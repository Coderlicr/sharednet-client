// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as controls from "./board-controls.ts";
import { localError } from "./errors.ts";
import { runCli } from "./cli.ts";
import { providerLimit } from "./trigger-consumer.ts";
import { getStoragePaths, writeProjectRoomState, writeRoomCredential } from "./storage.ts";
import type { SeatWake, TurnRunner } from "./wake-driver.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const room = "rom_AbCdEfGhIj", seat = "i_AbCdEfGhIj", source = "msg_AbCdEfGhIj";
const wake = { id: "wak_AbCdEfGhIj", room_id: room, target_instance_id: seat, source_message_id: source, source_instance_id: "i_HumanHuman", source_sequence: 7, state: "pending", source_is_human: true, reasons: [{ kind: "mention" }], created_at: "2026-10-11T00:00:00.000Z" };
const receipt = `wrc_${"R".repeat(43)}`;
async function fixture(driver: SeatWake = { driver: "command", command: "/bin/cat", cwd: "/tmp" }) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-trigger-")); roots.push(root);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const credential = { schema_version: 1 as const, base_url: "http://127.0.0.1:3001", room_id: room, member_id: seat, member_token: `sni_${"T".repeat(43)}`, name: "pilot", joined_at: "2026-10-11T00:00:00.000Z", wake: driver };
  await writeRoomCredential(getStoragePaths(env), credential);
  await writeProjectRoomState(root, { schema_version: 1, base_url: credential.base_url, room_id: room, member_id: seat, last_sequence: 0 });
  const requests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let failedPost = false, failedComplete = false, failedReply = false;
  const state = { launches: 0, failPost: false, failComplete: false, throwTurn: false, reply: "answer", startDenied: false, startReplay: false, claimReplay: false, terminalPage: false, cancelAt: "" as "" | "claim" | "start", refusal: "wake_cancelled", inboxCalls: 0, agentSource: false,
    replyFail: "" as "" | "before" | "after", published: new Map<string, { id: string; content: string }>(), progress: undefined as Record<string, unknown> | undefined, rateLimit: { path: "", count: 0 }, backoffs: [] as number[], second: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname.replace(`/api/v1/rooms/${room}`, "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, body, headers: new Headers(init?.headers) });
    const query = new URL(String(input)).searchParams;
    if (path === "/wakes") state.inboxCalls++;
    const currentWake = { ...wake, source_is_human: !state.agentSource, ...(state.cancelAt && state.inboxCalls > 1 ? { id: "wak_NextValid1" } : {}), ...(state.progress ? { state: "start_authorized", progress: { status: state.progress.status, updated_at: "2026-10-13T00:00:00.000Z" } } : {}) };
    if (state.cancelAt && state.inboxCalls === 1 && path.endsWith(`/${state.cancelAt}`)) return Response.json({ error: { code: state.refusal } }, { status: state.refusal === "invalid_token" ? 401 : 409 });
    if (state.rateLimit.count > 0 && path.endsWith(state.rateLimit.path)) { state.rateLimit.count--; return Response.json({ error: { code: "rate_limited" } }, { status: 429 }); }
    if (query.has("after") && query.has("before")) return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
    let response: unknown = {};
    if (path === "/wake-mode") response = { protocol: "trigger-wakes-v1", executor_epoch: 1 };
    if (path === "/wakes") response = state.terminalPage && !new URL(String(input)).searchParams.has("after")
      ? { items: Array.from({ length: 50 }, (_, index) => ({ ...wake, id: `wak_${String(index).padStart(10, "0")}`, state: "completed" })), next_cursor: "page-one" }
      : { items: [currentWake, ...(state.second ? [{ ...wake, id: "wak_SecondWak1", source_message_id: "msg_SecondMsg1", source_sequence: 8 }] : [])], next_cursor: null };
    if (path.endsWith("/claim") || path.endsWith("/start")) response = { wake: { ...currentWake, ...(path.includes("wak_SecondWak1") ? { id: "wak_SecondWak1", source_message_id: "msg_SecondMsg1", source_sequence: 8 } : {}), state: path.endsWith("/claim") ? "claimed" : "start_authorized" }, receipt };
    if (path.endsWith("/claim") && state.claimReplay) response = { wake: { ...wake, state: "start_authorized" }, receipt };
    if (path.endsWith("/start") && state.startReplay) response = { wake: { ...wake, state: "completed" }, receipt };
    if (path === "/messages" && init?.method === "GET") response = { items: [{ id: source, sequence: 7, content: "please answer", sender: { member_id: "i_HumanHuman", kind: "instance", name: "owner" } }, ...(state.second ? [{ id: "msg_SecondMsg1", sequence: 8, content: "and this", sender: { member_id: "i_HumanHuman", kind: "instance", name: "owner" } }] : [])], has_more: false };
    if (path === "/messages" && init?.method === "POST" && state.failPost && !failedPost) { failedPost = true; throw new Error("lost post response"); }
    if (path.endsWith("/complete") && state.failComplete && !failedComplete) { failedComplete = true; throw new Error("lost completion response"); }
    if (path.endsWith("/start") && state.startDenied) return Response.json({ error: { code: "wake_cancelled" } }, { status: 409 });
    if (path.endsWith("/progress")) { state.progress = body; response = { wake: { ...currentWake, state: "start_authorized" } }; }
    if (path.endsWith("/reply")) {
      // The service's contract: one message per operation id; the same id and content returns it again.
      if (state.replyFail === "before" && !failedReply) { failedReply = true; throw new Error("reply never arrived"); }
      const operation = String(body.operation_id);
      let message = state.published.get(operation);
      if (message && message.content !== body.content) return Response.json({ error: { code: "idempotency_conflict" } }, { status: 409 });
      const replayed = Boolean(message);
      if (!message) { message = { id: `msg_Reply${String(state.published.size).padStart(5, "0")}`, content: String(body.content) }; state.published.set(operation, message); }
      if (state.replyFail === "after" && !failedReply) { failedReply = true; throw new Error("lost reply response"); }
      return Response.json({ wake: { ...currentWake, state: "completed", resolution: "replied" }, message: { id: message.id, content: message.content }, replayed }, { status: replayed ? 200 : 201 });
    }
    return Response.json(response);
  };
  const runTurn: TurnRunner = async () => { state.launches++; if (state.throwTurn) throw new Error("uncertain start"); return { exitCode: 0, stdout: state.reply, stderr: "", timedOut: false }; };
  const outputs: string[] = [];
  const run = async (args: string[], runner = runTurn, now = new Date()) => {
    const output: string[] = [];
    const controller = new AbortController(); let polls = 0;
    const code = await runCli(["trigger", ...args, "--as", seat, "--json"], { env, cwd: root, fetch, runTurn: runner, now: () => now, signal: controller.signal, sleep: async () => { if (++polls >= 2) controller.abort(); }, backoff: async ms => { state.backoffs.push(ms); }, stdout: s => output.push(s), stderr: s => output.push(s) });
    outputs.push(...output);
    return { code, text: output.join("") };
  };
  const journalFile = () => { const sessions = join(getStoragePaths(env).stateDir, "trigger-sessions"); return join(sessions, readdirSync(sessions)[0]!, "journal.json"); };
  const journal = () => JSON.parse(readFileSync(journalFile(), "utf8")) as { executions: Record<string, Record<string, unknown>> };
  /** Rewrites the one execution as a crash at that moment would have left it. */
  const crashAt = async (stage: string) => { const value = journal(); for (const entry of Object.values(value.executions)) entry.stage = stage; await writeFile(journalFile(), JSON.stringify(value), { mode: 0o600 }); };
  return { root, env, credential, requests, state, run, outputs, journal, crashAt };
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
  it("publishes the final reply through the receipt-checked reply route and arms continuation by default", async () => {
    const f = await fixture();
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    const reply = f.requests.find(r => r.path.endsWith("/reply"));
    expect(reply?.body).toEqual({ execution_key: expect.any(String), executor_id: expect.any(String), executor_epoch: 1, receipt, operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/), content: "answer" });
    expect(f.requests.find(r => r.path.endsWith("/start"))?.body).toMatchObject({ receipt, executor_epoch: 1 });
    // Publishing is reported after the output is saved, before the reply.
    expect(f.requests.filter(r => r.path.endsWith("/progress")).map(r => r.body.status)).toEqual(["publishing"]);
    const arm = f.requests.find(r => r.path === "/triggers");
    expect(arm?.body).toEqual({ source: "room.message.posted", recipe: "continuation", reply_message_id: "msg_Reply00000", request_key: reply?.body.execution_key });
    expect(f.requests.some(r => r.path.endsWith("/complete") || r.path === "/messages" && r.body.content)).toBe(false);
    expect(f.state.launches).toBe(1);
  });
  it.each(["", "(no reply)"])("completes a silent result %j explicitly, without publication or rearming", async reply => {
    const f = await fixture(); f.state.reply = reply;
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.requests.filter(r => r.body.content)).toHaveLength(0);
    expect(f.requests.at(-1)?.body).toMatchObject({ outcome: "completed", resolution: "silent" });
    expect(f.requests.some(r => r.path === "/triggers")).toBe(false);
  });
  it.each(["before", "after"] as const)("saved output whose reply POST fails %s commit publishes once with no second model call", async when => {
    const f = await fixture(); f.state.replyFail = when;
    expect((await f.run(["serve", "--headless", "--once"])).code).not.toBe(0);
    expect(f.journal().executions[`http://127.0.0.1:3001/${room}/${wake.id}`]).toMatchObject({ stage: "output", reply: "answer" });
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(1);
    expect(f.state.published.size).toBe(1);
    const replies = f.requests.filter(r => r.path.endsWith("/reply"));
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map(r => r.body.operation_id)).size).toBe(1);
    expect(f.requests.filter(r => r.path === "/triggers")).toHaveLength(1);
  });
  it("recovers a lost silent completion from the journal without executing again", async () => {
    const f = await fixture(); f.state.reply = "(no reply)"; f.state.failComplete = true;
    expect((await f.run(["serve", "--headless", "--once"])).code).not.toBe(0);
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.launches).toBe(1);
    expect(f.requests.filter(r => r.path.endsWith("/complete")).map(r => r.body.resolution)).toEqual(["silent", "silent"]);
  });
  it("records a failed turn as a failed resolution with its reason, never as an answer", async () => {
    const f = await fixture();
    const result = await f.run(["serve", "--headless", "--once"], async () => { f.state.launches++; return { exitCode: 3, stdout: "", stderr: "boom", timedOut: false }; });
    expect(result.code, result.text).toBe(0);
    expect(f.requests.at(-1)?.body).toMatchObject({ outcome: "failed", resolution: "failed", reason: expect.stringContaining("exited 3") });
    expect(f.requests.some(r => r.path.endsWith("/reply") || r.path === "/messages" && r.body.content)).toBe(false);
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
    expect(f.requests.filter(r => r.path.endsWith("/reply"))).toHaveLength(1);
    expect(f.requests.find(r => r.path.endsWith("/reply"))?.path).toContain("wak_NextValid1");
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
    expect(f.requests.find(r => r.body.content)?.body).toMatchObject({ content: "answer", receipt });
    expect(f.requests.some(r => r.path === "/triggers")).toBe(false);
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
    const f = await fixture(); f.state.failComplete = true; f.state.reply = "(no reply)";
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
});

const key = `http://127.0.0.1:3001/${room}/${wake.id}`;
/** A Codex chat that is open: `exec resume` meets the active writer, `queue` stores the message. */
function openChat(f: Awaited<ReturnType<typeof fixture>>, queue: "ok" | "fail" | "throw" = "ok") {
  const calls = { exec: 0, queue: 0, message: "" };
  const runner: TurnRunner = async spec => {
    if (spec.args[0] === "queue") {
      calls.queue++; calls.message = spec.args[spec.args.indexOf("--message") + 1]!;
      if (queue === "throw") throw new Error("queue answer lost");
      return { exitCode: queue === "ok" ? 0 : 1, stdout: "", stderr: queue === "ok" ? "" : "queue refused", timedOut: false };
    }
    calls.exec++; f.state.launches++;
    return { exitCode: 1, stdout: "", stderr: "thread already has an active writer", timedOut: false };
  };
  return { calls, runner };
}
const codex: SeatWake = { driver: "codex", command: "/bin/echo", cwd: "/tmp", session: "local-session" };

describe("receipt-aware queued turns and recovery", () => {
  it("queues into an open Codex chat as queued, never completed, with only the wake id and source in context", async () => {
    const f = await fixture(codex); const chat = openChat(f);
    const result = await f.run(["serve", "--headless", "--once"], chat.runner);
    expect(result.code, result.text).toBe(0);
    expect(JSON.parse(result.text)).toMatchObject({ processed: 0, held: [{ wake_id: wake.id, stage: "queued" }] });
    expect(chat.calls.queue).toBe(1);
    expect(chat.calls.message).toContain(wake.id);
    expect(chat.calls.message).toContain(source);
    expect(chat.calls.message).toContain(room);
    expect(chat.calls.message).toContain(`sharednet trigger start ${wake.id} --as ${seat}`);
    expect(chat.calls.message).not.toContain(receipt);
    expect(f.requests.filter(r => r.path.endsWith("/progress")).map(r => r.body)).toEqual([expect.objectContaining({ status: "queued", receipt })]);
    expect(f.requests.some(r => r.path.endsWith("/complete") || r.path.endsWith("/reply"))).toBe(false);
    expect(f.journal().executions[key]).toMatchObject({ stage: "queued", delivery: "queued" });
  });
  it("#834 shape: queued, then interrupted before any start receipt, stays unresolved and is never rerun", async () => {
    const f = await fixture(codex); const chat = openChat(f);
    expect((await f.run(["serve", "--headless", "--once"], chat.runner)).code).toBe(0);
    // The open chat's turn is interrupted: no start, reply or completion ever arrives.
    for (let i = 0; i < 2; i++) {
      const again = await f.run(["serve", "--headless", "--once"], chat.runner);
      expect(again.code, again.text).toBe(0);
      expect(JSON.parse(again.text).held).toEqual([{ wake_id: wake.id, room_id: room, stage: "queued" }]);
    }
    expect(chat.calls).toMatchObject({ exec: 1, queue: 1 });
    expect(f.requests.some(r => r.path.endsWith("/complete") || r.path.endsWith("/reply") || r.path.endsWith("/claim") && f.requests.indexOf(r) > 5)).toBe(false);
    const status = JSON.parse((await f.run(["status"])).text);
    expect(status.bindings).toEqual([expect.objectContaining({ wake_id: wake.id, stage: "queued", holds_session: true, server: expect.objectContaining({ progress: expect.objectContaining({ status: "queued" }) }) })]);
  });
  it("one session runs one request at a time: a later request stays pending while the queued one is unresolved", async () => {
    const f = await fixture(codex); const chat = openChat(f); f.state.second = true;
    expect(JSON.parse((await f.run(["serve", "--headless", "--once"], chat.runner)).text).held).toHaveLength(1);
    expect(JSON.parse((await f.run(["serve", "--headless", "--once"], chat.runner)).text).held).toHaveLength(1);
    expect(f.requests.some(r => r.path.includes("wak_SecondWak1"))).toBe(false);
    expect(chat.calls).toMatchObject({ exec: 1, queue: 1 });
    expect((await f.run(["complete", wake.id, "--silent"])).code).toBe(0);
    await f.run(["serve", "--headless", "--once"], chat.runner);
    expect(f.requests.some(r => r.path === "/wakes/wak_SecondWak1/claim")).toBe(true);
    expect(chat.calls.queue).toBe(2);
  });
  it("start records running; reply publishes once with a stable operation id and settles", async () => {
    const f = await fixture(codex); const chat = openChat(f);
    await f.run(["serve", "--headless", "--once"], chat.runner);
    const started = await f.run(["start", wake.id]);
    expect(started.code, started.text).toBe(0);
    expect(f.requests.at(-1)).toMatchObject({ path: `/wakes/${wake.id}/progress`, body: { status: "running", receipt } });
    const replied = await f.run(["reply", wake.id, "done, see the PR"]);
    expect(replied.code, replied.text).toBe(0);
    expect(JSON.parse(replied.text)).toEqual({ wake_id: wake.id, resolution: "replied", message_id: "msg_Reply00000", replayed: false });
    expect(f.state.published.size).toBe(1);
    expect(f.journal().executions[key]).toMatchObject({ stage: "completed", resolution: "replied" });
    // The slot is free: the next serve lists again instead of holding.
    expect(JSON.parse((await f.run(["serve", "--headless", "--once"], chat.runner)).text).held).toBeUndefined();
    expect((await f.run(["reply", wake.id, "again"])).text).toContain("wake_resolved");
  });
  it("committed reply whose response is lost settles once, by the agent's retry or by serve", async () => {
    for (const retry of ["command", "serve"] as const) {
      const f = await fixture(codex); const chat = openChat(f); f.state.replyFail = "after";
      await f.run(["serve", "--headless", "--once"], chat.runner);
      expect((await f.run(["reply", wake.id, "answer text"])).code).toBe(5);
      expect(f.journal().executions[key]).toMatchObject({ stage: "replying" });
      // Changed content under the same pending operation is refused locally, never a second message.
      expect((await f.run(["reply", wake.id, "different text"])).text).toContain("reply_pending");
      const settled = retry === "command" ? await f.run(["reply", wake.id, "answer text"]) : await f.run(["serve", "--headless", "--once"], chat.runner);
      expect(settled.code, settled.text).toBe(0);
      if (retry === "command") expect(JSON.parse(settled.text)).toMatchObject({ replayed: true, message_id: "msg_Reply00000" });
      expect(f.state.published.size).toBe(1);
      const replies = f.requests.filter(r => r.path.endsWith("/reply"));
      expect(new Set(replies.map(r => r.body.operation_id)).size).toBe(1);
      expect(f.journal().executions[key]).toMatchObject({ stage: "completed", resolution: "replied" });
      expect(chat.calls.queue).toBe(1);
    }
  });
  it("silent completion is explicit; --failed carries its reason", async () => {
    for (const [args, body] of [[["--silent"], { outcome: "completed", resolution: "silent" }], [["--failed", "could not reach the repo"], { outcome: "failed", resolution: "failed", reason: "could not reach the repo" }]] as const) {
      const f = await fixture(codex); const chat = openChat(f);
      await f.run(["serve", "--headless", "--once"], chat.runner);
      const done = await f.run(["complete", wake.id, ...args]);
      expect(done.code, done.text).toBe(0);
      expect(f.requests.at(-1)).toMatchObject({ path: `/wakes/${wake.id}/complete`, body: { ...body, receipt } });
      expect(f.requests.some(r => r.path.endsWith("/reply") || r.path === "/messages" && r.body.content)).toBe(false);
    }
  });
  it("refuses a wake id with no local binding for this seat, before any request", async () => {
    const f = await fixture(codex);
    for (const args of [["start", "wak_ZzZzZzZzZz"], ["reply", "wak_ZzZzZzZzZz", "hi"], ["complete", "wak_ZzZzZzZzZz", "--silent"]]) {
      const result = await f.run(args);
      expect(result.code).toBe(2);
      expect(result.text).toContain("wake_binding_missing");
    }
    expect(f.requests).toEqual([]);
    expect((await f.run(["complete", wake.id, "--silent", "--failed", "x"])).text).toContain("invalid_arguments");
  });
  it("refuses start/reply for a headless turn its consumer owns", async () => {
    const f = await fixture(); f.state.throwTurn = true;
    await f.run(["serve", "--headless", "--once"]);
    expect((await f.run(["start", wake.id])).text).toContain("wake_not_queued");
    expect((await f.run(["reply", wake.id, "x"])).text).toContain("wake_not_queued");
  });
  it.each(["queuing", "starting"])("crash with %s saved: held as interrupted needs_reconciliation, never queued or run again", async stage => {
    const f = await fixture(codex); const chat = openChat(f);
    await f.run(["serve", "--headless", "--once"], chat.runner);
    await f.crashAt(stage);
    const before = f.requests.length;
    for (let i = 0; i < 2; i++) {
      const again = await f.run(["serve", "--headless", "--once"], chat.runner);
      expect(again.code).not.toBe(0);
      expect(again.text).toContain("needs_reconciliation");
    }
    expect(chat.calls).toMatchObject({ exec: 1, queue: 1 });
    const reports = f.requests.slice(before).filter(r => r.path.endsWith("/progress"));
    expect(reports.map(r => r.body)).toEqual([expect.objectContaining({ status: "interrupted", reason: "needs_reconciliation" })]);
    const status = JSON.parse((await f.run(["status"])).text);
    expect(status.bindings[0]).toMatchObject({ stage: "unknown", reason: "needs_reconciliation", holds_session: true });
    // The owner settles it explicitly; then serving resumes without rerunning it.
    expect((await f.run(["complete", wake.id, "--failed", "interrupted; owner reconciled"])).code).toBe(0);
    expect((await f.run(["serve", "--headless", "--once"], chat.runner)).code).toBe(0);
    expect(chat.calls).toMatchObject({ exec: 1, queue: 1 });
  });
  it.each(["fail", "throw"] as const)("a queue call that %s after intent is unknown, not failed, and is not repeated", async mode => {
    const f = await fixture(codex); const chat = openChat(f, mode);
    const first = await f.run(["serve", "--headless", "--once"], chat.runner);
    expect(first.text).toContain("needs_reconciliation");
    expect(f.journal().executions[key]).toMatchObject({ stage: "unknown", delivery: "queued" });
    expect((await f.run(["serve", "--headless", "--once"], chat.runner)).text).toContain("needs_reconciliation");
    expect(chat.calls.queue).toBe(1);
    // If the chat did receive it, its start receipt resolves the doubt.
    expect((await f.run(["start", wake.id])).code).toBe(0);
    expect(f.journal().executions[key]).toMatchObject({ stage: "running" });
  });
  it("a temporary provider rate limit retries the same attempt with bounded backoff", async () => {
    const f = await fixture(); let calls = 0;
    const runner: TurnRunner = async () => { calls++; return calls === 1 ? { exitCode: 1, stdout: "", stderr: "429 Too Many Requests: rate limit reached", timedOut: false } : { exitCode: 0, stdout: "answer", stderr: "", timedOut: false }; };
    const result = await f.run(["serve", "--headless", "--once"], runner);
    expect(result.code, result.text).toBe(0);
    expect(calls).toBe(2);
    expect(f.state.backoffs).toEqual([30_000]);
    expect(f.requests.filter(r => r.path.endsWith("/claim") || r.path.endsWith("/start"))).toHaveLength(2);
    expect(f.requests.find(r => r.path.endsWith("/progress"))?.body).toMatchObject({ status: "blocked", blocker: { kind: "rate_limited" } });
    expect(f.requests.find(r => r.path.endsWith("/progress"))?.body.blocker).not.toHaveProperty("retry_after");
    expect(f.state.published.size).toBe(1);
  });
  it("a rate limit that outlasts its retries, or quota exhaustion, is blocked and held without rerun", async () => {
    const f = await fixture(); let calls = 0;
    const runner: TurnRunner = async () => { calls++; return { exitCode: 1, stdout: "", stderr: "rate limit exceeded", timedOut: false }; };
    expect((await f.run(["serve", "--headless", "--once"], runner)).code).toBe(0);
    expect(calls).toBe(3);
    expect(f.state.backoffs).toEqual([30_000, 120_000]);
    expect(JSON.parse((await f.run(["serve", "--headless", "--once"], runner)).text).held).toEqual([{ wake_id: wake.id, room_id: room, stage: "blocked" }]);
    expect(calls).toBe(3);
    const q = await fixture(); let quota = 0;
    const exhausted: TurnRunner = async () => { quota++; return { exitCode: 1, stdout: "", stderr: "You've exceeded your current quota (insufficient_quota). Try again at 3:05 PM.", timedOut: false }; };
    expect((await q.run(["serve", "--headless", "--once"], exhausted)).code).toBe(0);
    expect(quota).toBe(1); expect(q.state.backoffs).toEqual([]);
    const blocked = q.requests.find(r => r.path.endsWith("/progress"))?.body;
    expect(blocked).toMatchObject({ status: "blocked", blocker: { kind: "quota_exhausted" } });
    // A wall-clock time without date or zone is not a reliable reset: no retry_after is invented.
    expect(blocked?.blocker).not.toHaveProperty("retry_after");
    expect(JSON.parse((await q.run(["status"])).text).bindings[0]).toMatchObject({ stage: "blocked", blocker: { kind: "quota_exhausted" } });
  });
  it("keeps a quota reset time only when the provider states an absolute instant", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    expect(providerLimit("usage limit reached; resets at 2026-10-14T05:00:00Z", now)).toMatchObject({ kind: "quota_exhausted", retry_after: "2026-10-14T05:00:00.000Z" });
    expect(providerLimit("usage limit reached; resets at 2020-01-01T00:00:00Z", now)).not.toHaveProperty("retry_after");
    expect(providerLimit("429 rate limit", now)).toMatchObject({ kind: "rate_limited" });
    expect(providerLimit("the command exited 1", now)).toBeNull();
  });
  it("retries a SharedNet 429 with bounded backoff inside the same attempt", async () => {
    const f = await fixture(); f.state.rateLimit = { path: "/claim", count: 2 };
    expect((await f.run(["serve", "--headless", "--once"])).code).toBe(0);
    expect(f.state.backoffs).toEqual([1_000, 2_000]);
    const claims = f.requests.filter(r => r.path.endsWith("/claim"));
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map(r => r.body.execution_key)).size).toBe(1);
    expect(f.state.launches).toBe(1);
  });
  it("never prints a receipt in any command's output", async () => {
    const f = await fixture(codex); const chat = openChat(f); f.state.replyFail = "after";
    await f.run(["serve", "--headless", "--once"], chat.runner);
    await f.run(["status"]); await f.run(["start", wake.id]);
    await f.run(["reply", wake.id, "x"]); await f.run(["reply", wake.id, "x"]); await f.run(["status"]);
    expect(f.outputs.join("")).not.toContain("wrc_");
    expect(f.outputs.join("")).not.toContain(f.state.published.keys().next().value!);
    // Nor may a reply carry it into the Room.
    const g = await fixture(codex); const other = openChat(g);
    await g.run(["serve", "--headless", "--once"], other.runner);
    expect((await g.run(["reply", wake.id, `leak ${receipt}`])).text).toContain("invalid_arguments");
    expect(g.requests.some(r => r.path.endsWith("/reply"))).toBe(false);
  });
});
