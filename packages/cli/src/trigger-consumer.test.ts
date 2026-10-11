// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as controls from "./board-controls.ts";
import { localError } from "./errors.ts";
import { runCli } from "./cli.ts";
import { getStoragePaths, writeProjectRoomState, writeRoomCredential } from "./storage.ts";
import type { SeatWake, TurnRunner } from "./wake-driver.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const room = "rom_AbCdEfGhIj", seat = "i_AbCdEfGhIj", source = "msg_AbCdEfGhIj";
const wake = { id: "wak_AbCdEfGhIj", room_id: room, target_instance_id: seat, source_message_id: source, source_instance_id: "i_HumanHuman", source_sequence: 7, state: "pending", source_is_human: true, reasons: [{ kind: "mention" }], created_at: "2026-10-11T00:00:00.000Z" };
async function fixture(driver: SeatWake = { driver: "command", command: "/bin/cat", cwd: "/tmp" }) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-trigger-")); roots.push(root);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const credential = { schema_version: 1 as const, base_url: "http://127.0.0.1:3001", room_id: room, member_id: seat, member_token: `sni_${"T".repeat(43)}`, name: "pilot", joined_at: "2026-10-11T00:00:00.000Z", wake: driver };
  await writeRoomCredential(getStoragePaths(env), credential);
  await writeProjectRoomState(root, { schema_version: 1, base_url: credential.base_url, room_id: room, member_id: seat, last_sequence: 0 });
  const requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let failedPost = false, failedComplete = false;
  const state = { launches: 0, failPost: false, failComplete: false, throwTurn: false, reply: "answer", startDenied: false, startReplay: false, claimReplay: false, terminalPage: false, cancelAt: "" as "" | "claim" | "start", refusal: "wake_cancelled", inboxCalls: 0, agentSource: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(`/api/v1/rooms/${room}`, "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, body, headers: new Headers(init?.headers) });
    const query = new URL(String(input)).searchParams;
    if (path === "/wakes") state.inboxCalls++;
    const currentWake = { ...wake, source_is_human: !state.agentSource, ...(state.cancelAt && state.inboxCalls > 1 ? { id: "wak_NextValid1" } : {}) };
    if (state.cancelAt && state.inboxCalls === 1 && path.endsWith(`/${state.cancelAt}`)) return Response.json({ error: { code: state.refusal } }, { status: state.refusal === "invalid_token" ? 401 : 409 });
    if (query.has("after") && query.has("before")) return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    let response: unknown = {};
    if (path === "/wake-mode") response = { protocol: "trigger-wakes-v1", executor_epoch: 1 };
    if (path === "/wakes") response = state.terminalPage && !new URL(String(input)).searchParams.has("after")
      ? { items: Array.from({ length: 50 }, (_, index) => ({ ...wake, id: `wak_${String(index).padStart(10, "0")}`, state: "completed" })), next_cursor: "page-one" }
      : { items: [currentWake], next_cursor: null };
    if (path.endsWith("/claim") || path.endsWith("/start")) response = { wake: { ...currentWake, state: path.endsWith("/claim") ? "claimed" : "start_authorized" }, receipt: "test-receipt" };
    if (path.endsWith("/claim") && state.claimReplay) response = { wake: { ...wake, state: "start_authorized" }, receipt: "test-receipt" };
    if (path.endsWith("/start") && state.startReplay) response = { wake: { ...wake, state: "completed" }, receipt: "test-receipt" };
    if (path === "/messages" && init?.method === "GET") response = { items: [{ id: source, sequence: 7, content: "please answer", sender: { member_id: "i_HumanHuman", kind: "instance", name: "owner" } }], has_more: false };
    if (path === "/messages" && init?.method === "POST" && state.failPost && !failedPost) { failedPost = true; throw new Error("lost post response"); }
    if (path.endsWith("/complete") && state.failComplete && !failedComplete) { failedComplete = true; throw new Error("lost completion response"); }
    if (path.endsWith("/start") && state.startDenied) return Response.json({ error: { code: "wake_cancelled" } }, { status: 409 });
    return Response.json(response);
  };
  const runTurn: TurnRunner = async () => { state.launches++; if (state.throwTurn) throw new Error("uncertain start"); return { exitCode: 0, stdout: state.reply, stderr: "", timedOut: false }; };
  const run = async (args: string[], runner = runTurn) => {
    const output: string[] = [];
    const controller = new AbortController(); let polls = 0;
    const code = await runCli(["trigger", ...args, "--as", seat, "--json"], { env, cwd: root, fetch, runTurn: runner, signal: controller.signal, sleep: async () => { if (++polls >= 2) controller.abort(); }, stdout: s => output.push(s), stderr: s => output.push(s) });
    return { code, text: output.join("") };
  };
  return { root, env, credential, requests, state, run };
}

describe("opt-in trigger commands", () => {
  it("sends standalone continuation, list and cancellation with the negotiated header and no local session data", async () => {
    const f = await fixture();
    expect((await f.run(["continuation", "--reply-to", source, "--request-key", "12345678-1234-4234-8234-123456789abc"])).code).toBe(0);
    expect(f.requests[0]?.body).toEqual({ source: "room.message.posted", recipe: "continuation", reply_message_id: source, request_key: "12345678-1234-4234-8234-123456789abc" });
    expect((await f.run(["list"])).code).toBe(0);
    expect((await f.run(["cancel", "trg_AbCdEfGhIj"])).code).toBe(0);
    expect(f.requests.map(r => r.path)).toEqual(["/triggers", "/triggers", "/triggers/trg_AbCdEfGhIj/cancel"]);
    expect(f.requests.every(r => r.headers.get("x-sharednet-wake-protocol") === "trigger-wakes-v1")).toBe(true);
    expect(JSON.stringify(f.requests)).not.toContain(f.root);
  });
  it("requires explicit headless opt-in before enrolling", async () => {
    const f = await fixture();
    expect((await f.run(["serve", "--once"])).code).not.toBe(0);
    expect(f.requests).toEqual([]);
  });
  it("links an idempotent final reply to its source and arms continuation by default", async () => {
    const f = await fixture();
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    const post = f.requests.find(r => r.path === "/messages" && r.body.content);
    expect(post?.body).toEqual({ content: "answer", reply_to_message_id: source, continuation: { request_key: expect.any(String) } });
    expect(post?.headers.get("idempotency-key")).toBeTruthy();
    expect(f.requests.find(r => r.path.endsWith("/start"))?.body).toMatchObject({ receipt: "test-receipt", executor_epoch: 1 });
    expect(f.requests.at(-1)?.body.outcome).toBe("completed");
    expect(f.state.launches).toBe(1);
  });
  it.each(["", "(no reply)"])("completes a silent result %j without publication or rearming", async reply => {
    const f = await fixture(); f.state.reply = reply;
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.requests.filter(r => r.body.content)).toHaveLength(0);
    expect(f.requests.at(-1)?.body.outcome).toBe("completed");
  });
  it.each(["failPost", "failComplete"] as const)("recovers %s using saved output without executing again", async failure => {
    const f = await fixture(); f.state[failure] = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).not.toBe(0);
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(1);
    const posts = f.requests.filter(r => r.body.content);
    expect(new Set(posts.map(r => r.headers.get("idempotency-key"))).size).toBe(1);
  });
  it("does not relaunch an uncertain start after reopening the journal", async () => {
    const f = await fixture(); f.state.throwTurn = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).not.toBe(0);
    const retry = await f.run(["serve", "--headless", "--once"]);
    expect(retry.code).not.toBe(0);
    expect(retry.text).toContain("needs_reconciliation");
    expect(f.state.launches).toBe(1);
  });
  it("does not launch after the server refuses start authorization", async () => {
    const f = await fixture(); f.state.startDenied = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(0);
  });
  it.each(["startReplay", "claimReplay"] as const)("does not launch on an incompatible %s response", async replay => {
    const f = await fixture(); f.state[replay] = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).not.toBe(0);
    expect(f.state.launches).toBe(0);
    if (replay === "startReplay") {
      f.state.startReplay = false;
      const retry = await f.run(["serve", "--headless", "--once"]);
      expect(retry.text).toContain("needs_reconciliation");
      expect(f.state.launches).toBe(0);
    }
  });
  it.each(["claim", "start"] as const)("keeps serving after cancellation at %s and executes the next wake once", async cancelAt => {
    const f = await fixture(); f.state.cancelAt = cancelAt;
    const result = await f.run(["serve", "--headless"]);
    expect(result.code, result.text).toBe(0);
    expect(f.state.inboxCalls).toBe(2);
    expect(f.state.launches).toBe(1);
    expect(f.requests.filter(r => r.path.endsWith("/complete"))).toHaveLength(1);
    expect(f.requests.find(r => r.path.endsWith("/complete"))?.path).toContain("wak_NextValid1");
    // Reopen persisted terminal cancellation without resurrecting either execution.
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(1);
  });
  it.each(["executor_fenced", "invalid_token", "wake_conflict"])("stops on %s instead of mistaking it for cancellation", async refusal => {
    const f = await fixture(); f.state.cancelAt = "start"; f.state.refusal = refusal;
    expect((await f.run(["serve", "--headless"])).code).not.toBe(0);
    expect(f.state.inboxCalls).toBe(1); expect(f.state.launches).toBe(0);
  });
  it("replies to an agent mention without arming a human continuation", async () => {
    const f = await fixture(); f.state.agentSource = true;
    const result = await f.run(["serve", "--headless", "--once"]);
    expect(result.code, result.text).toBe(0);
    expect(f.requests.find(r => r.body.content)?.body).toEqual({ content: "answer", reply_to_message_id: source });
    expect(f.requests.at(-1)?.body.outcome).toBe("completed");
  });
  it("drains past a full page of terminal wakes without starving new work", async () => {
    const f = await fixture(); f.state.terminalPage = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(1);
  });
  it("refuses an open saved chat before enrollment", async () => {
    const f = await fixture({ driver: "claude-code", command: "/bin/echo", cwd: "/tmp", session: "local-session", live_pid: process.pid });
    const result = await f.run(["serve", "--headless", "--once"]);
    expect(result.text).toContain("trigger_headless_required");
    expect(f.requests).toEqual([]);
  });
  it("resumes a saved Claude session after its attended chat has exited", async () => {
    const f = await fixture({ driver: "claude-code", command: "/bin/echo", cwd: "/tmp", session: "local-session", live_pid: 2147483647 });
    let calls = 0;
    const result = await f.run(["serve", "--headless", "--once"], async () => { calls++; return { exitCode: 0, stdout: JSON.stringify({ type: "result", result: "(no reply)", is_error: false }), stderr: "", timedOut: false }; });
    expect(result.code, result.text).toBe(0);
    expect(calls).toBe(1);
  });
  it("keeps a resident consumer alive through a transient completion failure", async () => {
    const f = await fixture(); f.state.failComplete = true;
    const result = await f.run(["serve", "--headless"]);
    expect(result.code, result.text).toBe(0);
    expect(f.state.launches).toBe(1);
    expect(f.requests.filter(request => request.path.endsWith("/complete"))).toHaveLength(2);
  });
  it("waits for another Room's long turn without abandoning the resident queue", async () => {
    const f = await fixture();
    vi.spyOn(controls, "withControlLock").mockRejectedValueOnce(localError("local_state_busy", "held by another Room"));
    const result = await f.run(["serve", "--headless"]);
    expect(result.code, result.text).toBe(0);
    expect(f.state.launches).toBe(1);
  });
  it("passes the precise source identity and routing reason to the headless command", async () => {
    const f = await fixture();
    let input = "";
    const result = await f.run(["serve", "--headless", "--once"], async spec => {
      input = spec.input;
      return { exitCode: 0, stdout: "(no reply)", stderr: "", timedOut: false };
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(input)).toMatchObject({ source_message_id: source, wake_id: "wak_AbCdEfGhIj", trigger: "mention" });
  });
  it("never sends a Codex wake to the open-chat queue", async () => {
    const f = await fixture({ driver: "codex", command: "/bin/echo", cwd: "/tmp", session: "local-session" });
    let calls = 0;
    await f.run(["serve", "--headless", "--once"], async () => { calls++; return { exitCode: 1, stdout: "", stderr: "already has an active writer", timedOut: false }; });
    expect(calls).toBe(1);
  });
});
