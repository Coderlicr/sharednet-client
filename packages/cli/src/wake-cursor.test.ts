// @vitest-environment node

import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CURSOR_CHECK_ARGS, cursorFreeEnv, cursorPlugin, cursorResume, cursorSignedIn, cursorSummary, fitPrompt } from "./wake-cursor.ts";
import { livePrompt, type DeliveryContext, type SeatWake, type TurnOutcome, type TurnSpec, type WakeInput } from "./wake-driver.ts";
import { describeWake, parseSeatWake, pluginFor, seatWakeFrom } from "./wake-plugins.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function bin(...programs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-cursor-"));
  cleanup.push(directory);
  for (const program of programs) {
    await writeFile(join(directory, program), "#!/bin/sh\n");
    await chmod(join(directory, program), 0o755);
  }
  return directory;
}

const about = { roomId: "rom_AbCdEfGhIj", seat: "helper", memberId: "i_SeatSeatSe", messages: [{ sequence: 7, content: "@helper look at the build", sender: { name: "ann" } }], from: 6, through: 7 };
const input: WakeInput = { ...about, prompt: "[SharedNet] TURN PROMPT\n#7 ann: @helper look at the build", livePrompt: livePrompt(about) };
const CHAT = "8f1c0d6e-2b7a-4c1e-9d11-0a5b3c2d1e00";
// #32 validates the wake's cwd in a check, so it is a directory that exists.
let work = "";
let wake: SeatWake;
beforeAll(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), "sharednet-cursor-work-")));
  wake = { driver: "cursor", session: CHAT, cwd: work, command: "cursor-agent" };
});
afterAll(() => rm(work, { recursive: true, force: true }));

/** A stand-in for the program: answers in order, and keeps what it was asked. */
function scripted(...answers: Array<Partial<TurnOutcome>>) {
  const ran: TurnSpec[] = [];
  const context: DeliveryContext = {
    env: { PATH: "", CURSOR_API_KEY: "key_test" },
    timeoutMs: 60_000,
    chatOpen: () => false,
    run: async (spec) => {
      ran.push(spec);
      const answer = answers.shift() ?? {};
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
    },
  };
  return { ran, context };
}

const DONE = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1234, duration_api_ms: 1234, result: "@ann the build is green.", session_id: "8f1c0d6e-2b7a-4c1e-9d11-0a5b3c2d1e00" });

describe("the cursor plugin", () => {
  it("is registered, never captured at join, and keeps a stored chat id", () => {
    expect(pluginFor("cursor").label).toBe("Cursor");
    // CURSOR_TRACE_ID names the editor, not a CLI chat: join must not turn it into a wake.
    expect(seatWakeFrom({ CURSOR_AGENT: "1", CURSOR_TRACE_ID: "trace-1", PATH: "" }, "/w")).toBeNull();
    expect(parseSeatWake({ driver: "cursor", session: wake.session, cwd: "/w", command: "cursor-agent" })).toEqual({ driver: "cursor", session: wake.session, cwd: "/w", command: "cursor-agent" });
    expect(parseSeatWake({ driver: "cursor", cwd: "/w", command: "cursor-agent" })).toBeUndefined();
    expect(describeWake(wake)).toBe(`cursor ${wake.session}`);
  });

  it("resumes the chat in print mode with the prompt as the last argument, and replies with the result", async () => {
    const { ran, context } = scripted({ stdout: `${DONE}\n` });
    expect(await cursorPlugin.deliver(wake, input, context)).toEqual({ kind: "replied", reply: "@ann the build is green." });
    expect(ran).toHaveLength(1);
    expect([ran[0]!.command, ...ran[0]!.args]).toEqual(["cursor-agent", "-p", "--resume", wake.session, "--output-format", "json", "--trust", input.prompt]);
    expect(ran[0]!.input).toBe("");
    expect(ran[0]!.cwd).toBe(work);
    // Cursor signs in from the environment; the seat is named, the host's markers are not carried.
    expect(ran[0]!.env).toMatchObject({ CURSOR_API_KEY: "key_test", SHAREDNET_SEAT: "i_SeatSeatSe" });
  });

  it("never forces commands: --force is for a launcher the person chose", () => {
    const spec = cursorResume(wake, "p", {}, "i_SeatSeatSe", 1);
    expect(spec.args).not.toContain("--force");
    expect(spec.args).not.toContain("--yolo");
  });

  it("fails with the CLI's own words, or how it ended: a non-zero exit has no JSON", async () => {
    const refused = scripted({ exitCode: 1, stderr: "Error: Not authenticated. Run `agent login` or set CURSOR_API_KEY.\n" });
    expect(await cursorPlugin.deliver(wake, input, refused.context)).toMatchObject({
      kind: "failed",
      why: "the cursor command exited 1",
      detail: "Error: Not authenticated. Run `agent login` or set CURSOR_API_KEY.",
      timedOut: false,
    });
    const errored = scripted({ stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Chat not found" }) });
    expect(await cursorPlugin.deliver(wake, input, errored.context)).toMatchObject({ kind: "failed", why: "Chat not found" });
    // Exit 0 without a result event is not a finished turn.
    expect(await cursorPlugin.deliver(wake, input, scripted({ stdout: "hello\n" }).context)).toMatchObject({ kind: "failed" });
    const late = scripted({ exitCode: 143, timedOut: true });
    expect(await cursorPlugin.deliver(wake, input, late.context)).toMatchObject({ kind: "failed", timedOut: true });
  });

  it("hands serve an empty reply as it is (serve posts nothing for it)", async () => {
    const empty = scripted({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }) });
    expect(await cursorPlugin.deliver(wake, input, empty.context)).toEqual({ kind: "replied", reply: "" });
  });

  it("reads the result off the last JSON line when other lines are printed around it", () => {
    expect(cursorSummary(`warning: update available\n${DONE}\n`)).toMatchObject({ ok: true, said: "@ann the build is green." });
    expect(cursorSummary("")).toMatchObject({ ok: false });
    expect(cursorSummary(JSON.stringify({ type: "assistant", message: {} }))).toMatchObject({ ok: false });
  });

  it("keeps a long prompt inside one argument: first line and the newest lines stay", () => {
    expect(fitPrompt("short\nprompt")).toBe("short\nprompt");
    const lines = Array.from({ length: 40 }, (_, index) => `#${index + 1} ann: ${"x".repeat(5_000)} line ${index + 1}`);
    const long = ["[SharedNet] header", ...lines].join("\n");
    const fitted = fitPrompt(long);
    expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(100 * 1024);
    expect(fitted.startsWith("[SharedNet] header\n")).toBe(true);
    expect(fitted).toContain("line 40");
    expect(fitted).not.toContain("line 1\n");
    expect(fitted).toContain("earlier lines cut");
    // Multi-byte text is cut on a character, never in the middle of one.
    expect(fitPrompt(`head\n${"界".repeat(60_000)}`, 1_000)).not.toContain("�");
  });
});

const DOC_SUCCESS = { type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, result: "ok", session_id: CHAT };

describe("point 3: only the documented success object is a success", () => {
  it("requires type result, subtype success, is_error false and a string result", () => {
    expect(cursorSummary(JSON.stringify(DOC_SUCCESS))).toMatchObject({ ok: true, said: "ok" });
    expect(cursorSummary(JSON.stringify({ ...DOC_SUCCESS, result: "" }))).toMatchObject({ ok: true, said: "" });
    const bad: Array<[string, Record<string, unknown>]> = [
      ["missing subtype", { type: "result", is_error: false, result: "hi" }],
      ["unknown subtype", { ...DOC_SUCCESS, subtype: "partial" }],
      ["is_error missing", { type: "result", subtype: "success", result: "hi" }],
      ["is_error not exactly false", { ...DOC_SUCCESS, is_error: "false" }],
      ["is_error null", { ...DOC_SUCCESS, is_error: null }],
      ["result missing", { type: "result", subtype: "success", is_error: false }],
      ["result not a string", { ...DOC_SUCCESS, result: { text: "hi" } }],
    ];
    for (const [why, object] of bad) {
      const summary = cursorSummary(JSON.stringify(object));
      expect(summary.ok, why).toBe(false);
      expect(summary.said, why).toContain("not the documented success object");
    }
    expect(cursorSummary("")).toMatchObject({ ok: false, said: "the Cursor CLI printed nothing" });
    expect(cursorSummary("hello")).toMatchObject({ ok: false, said: "the Cursor CLI printed no result object" });
    expect(cursorSummary(JSON.stringify({ type: "assistant" }))).toMatchObject({ ok: false });
  });

  it("reports the CLI's own words when it says is_error, and never acknowledges a malformed result as a reply", async () => {
    expect(cursorSummary(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Chat not found" }))).toMatchObject({ ok: false, said: "Chat not found" });
    for (const object of [{ type: "result", subtype: "success", result: "hi" }, { ...DOC_SUCCESS, is_error: undefined }]) {
      const delivery = await cursorPlugin.deliver(wake, input, scripted({ stdout: JSON.stringify(object) }).context);
      expect(delivery).toMatchObject({ kind: "failed" });
      expect(delivery.kind === "failed" && delivery.why).toContain("not the documented success object");
    }
  });

  it("finds the result when warnings are printed around it", () => {
    expect(cursorSummary(`warning: update available\n${JSON.stringify(DOC_SUCCESS)}\n`)).toMatchObject({ ok: true, said: "ok" });
  });
});

describe("point 4: Cursor's host markers stay behind, its sign-in stays", () => {
  const host = { CURSOR_AGENT: "1", CURSOR_TRACE_ID: "editor-trace", CURSOR_SANDBOX: "seatbelt", CURSOR_SANDBOX_NETWORK_DISABLED: "1", CURSOR_AGENT_WORKER_ID: "pw_1", CURSOR_WAKE: "1" };
  const signIn = { CURSOR_API_KEY: "key_test", CURSOR_SERVICE_ACCOUNT_API_KEY: "svc", CURSOR_CONFIG_DIR: "/cfg", AGENT_CLI_CREDENTIAL_STORE: "file", PATH: "/bin" };

  it("scrubs them from the resumed child and keeps what signs it in", () => {
    const spec = cursorResume(wake, "p", { ...host, ...signIn, CODEX_SESSION_ID: "019a" }, "i_SeatSeatSe", 1);
    for (const key of Object.keys(host)) expect(spec.env, key).not.toHaveProperty(key);
    expect(spec.env).toMatchObject({ ...signIn, SHAREDNET_SEAT: "i_SeatSeatSe" });
    expect(spec.env).not.toHaveProperty("CODEX_SESSION_ID");
    expect(cursorFreeEnv({ ...host, ...signIn })).toEqual(signIn);
  });

  it("scrubs them from every step of a check as well", async () => {
    const { ran, run } = checks({ version: { stdout: "2026.10.14\n" }, signed_in: { stdout: '{"isAuthenticated":true}' }, call: { stdout: JSON.stringify(DOC_SUCCESS) } });
    await cursorPlugin.check({ ...wake, command: await agentOnPath() }, { ...host, ...signIn, PATH: pathDir }, run, { call: true });
    expect(ran.length).toBe(3);
    for (const spec of ran.slice(1)) {
      for (const key of Object.keys(host)) expect(spec.env, `${spec.args[0]} ${key}`).not.toHaveProperty(key);
      expect(spec.env.CURSOR_API_KEY).toBe("key_test");
    }
  });
});

let pathDir = "";
async function agentOnPath() {
  pathDir = await bin("agent", "cursor-agent", "cursor-room.sh");
  return "agent";
}

/** Answers a check's programs by what they were asked: --version, status, or the throwaway turn. */
function checks(answers: { version?: Partial<TurnOutcome>; signed_in?: Partial<TurnOutcome>; call?: Partial<TurnOutcome> }) {
  const ran: TurnSpec[] = [];
  const run = async (spec: TurnSpec): Promise<TurnOutcome> => {
    ran.push(spec);
    const kind = spec.args[0] === "--version" ? "version" : spec.args[0] === "status" ? "signed_in" : "call";
    const answer = answers[kind] ?? {};
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
  };
  return { ran, run };
}

const statuses = (checked: { steps?: Array<{ step: string; status: string }> }) => checked.steps?.map((step) => [step.step, step.status]);

describe("point 2: the staged check", () => {
  const SIGNED_IN = '{"isAuthenticated":true}';

  it("takes the four steps in order: version, status, chat id, and a throwaway turn only when asked", async () => {
    const path = await bin("agent", "cursor-agent");
    const { ran, run } = checks({ version: { stdout: "2026.10.14-0f9edde\n" }, signed_in: { stdout: SIGNED_IN }, call: { stdout: JSON.stringify(DOC_SUCCESS) } });
    const checked = await cursorPlugin.check({ ...wake, command: "agent" }, { PATH: path }, run, { call: true });
    expect(checked.ok).toBe(true);
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "ok"], ["session", "skipped"], ["call", "ok"]]);
    expect([ran[0]!.command, ...ran[0]!.args]).toEqual([join(path, "agent"), "--version"]);
    expect([ran[1]!.command, ...ran[1]!.args]).toEqual([join(path, "agent"), "status", "--format", "json"]);
    // The throwaway turn resumes nothing, in ask mode, in an empty directory that is not the seat's and is gone afterwards.
    expect(ran[2]!.args).toEqual([...CURSOR_CHECK_ARGS, "Reply with exactly: ok"]);
    expect(ran[2]!.args).not.toContain("--resume");
    expect(ran[2]!.args).not.toContain("--force");
    expect(ran[2]!.cwd).not.toBe(work);
    expect(checked.steps![3]!.message).toContain("leaves one");

    const free = checks({ signed_in: { stdout: SIGNED_IN } });
    const noCall = await cursorPlugin.check({ ...wake, command: "agent" }, { PATH: path }, free.run);
    expect(statuses(noCall)).toEqual([["program", "ok"], ["signed_in", "ok"], ["session", "skipped"]]);
    expect(free.ran.map((spec) => spec.args[0])).toEqual(["--version", "status"]);
  });

  it("asks the wake's own command, so the cursor-agent alias is the one checked", async () => {
    const path = await bin("agent", "cursor-agent");
    const { ran, run } = checks({ signed_in: { stdout: SIGNED_IN } });
    await cursorPlugin.check(wake, { PATH: path }, run);
    expect(new Set(ran.map((spec) => spec.command))).toEqual(new Set([join(path, "cursor-agent")]));
  });

  it("does not repeat #32's false positive: a program that starts but is signed out, or has no answer, is not clean", async () => {
    const path = await bin("agent");
    const base = { ...wake, command: "agent" };
    const out = await cursorPlugin.check(base, { PATH: path }, checks({ signed_in: { stdout: '{"isAuthenticated":false}' }, call: { exitCode: 1, stderr: "Error: Not authenticated. Run `agent login`\n" } }).run, { call: true });
    expect(out.ok).toBe(false);
    expect(statuses(out)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "skipped"], ["call", "failed"]]);
    expect(out.message).toContain("agent login");
    expect(out.message).toContain("CURSOR_API_KEY is not set");
    // A sign-in status that says no is a warning, not a verdict: the CLI may sign in by CURSOR_API_KEY.
    const key = await cursorPlugin.check(base, { PATH: path, CURSOR_API_KEY: "k" }, checks({ signed_in: { exitCode: 1, stderr: "Not logged in\n" }, call: { stdout: JSON.stringify(DOC_SUCCESS) } }).run, { call: true });
    expect(key.ok).toBe(true);
    expect(statuses(key)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "skipped"], ["call", "ok"]]);
    expect(key.steps![1]!.message).toContain("CURSOR_API_KEY is set");
    expect(JSON.stringify(key)).not.toContain('"k"');
    // The throwaway turn must itself be the documented success object, with an answer.
    for (const stdout of [JSON.stringify({ ...DOC_SUCCESS, is_error: undefined }), JSON.stringify({ ...DOC_SUCCESS, result: "  " }), ""]) {
      const bad = await cursorPlugin.check(base, { PATH: path }, checks({ signed_in: { stdout: SIGNED_IN }, call: { stdout } }).run, { call: true });
      expect(bad.steps![3]!.status).toBe("failed");
    }
    const silent = await cursorPlugin.check(base, { PATH: path }, checks({ signed_in: { stdout: SIGNED_IN }, call: { timedOut: true, exitCode: 143 } }).run, { call: true });
    expect(silent.steps![3]!.message).toContain("no answer within 120s");
    const slow = await cursorPlugin.check(base, { PATH: path }, checks({ signed_in: { timedOut: true, exitCode: 143 } }).run);
    expect(slow.steps![1]).toMatchObject({ status: "warning" });
    expect(slow.steps![1]!.message).toContain("did not answer within 15s");
    const proxy = await cursorPlugin.check(base, { PATH: path, HTTPS_PROXY: "http://127.0.0.1:1" }, checks({ signed_in: { stdout: SIGNED_IN }, call: { exitCode: 1, stderr: "ECONNREFUSED\n" } }).run, { call: true });
    expect(proxy.steps![3]!.message).toContain("with HTTPS_PROXY set");
  });

  it("reads the sign-in status by its boolean, then by its words, else says it cannot tell", () => {
    expect(cursorSignedIn('{"isAuthenticated":true,"email":"a@b.c"}')).toBe("yes");
    expect(cursorSignedIn('{"loggedIn":false}')).toBe("no");
    expect(cursorSignedIn("Logged in as someone")).toBe("yes");
    expect(cursorSignedIn("Not logged in")).toBe("no");
    expect(cursorSignedIn("")).toBe("unknown");
    expect(cursorSignedIn('{"version":1}')).toBe("unknown");
  });

  it("warns on a chat id that is not a Cursor chat id, instead of letting --resume fail later", async () => {
    const path = await bin("agent");
    const odd = await cursorPlugin.check({ ...wake, command: "agent", session: "--force" }, { PATH: path }, checks({ signed_in: { stdout: SIGNED_IN } }).run);
    expect(statuses(odd)).toEqual([["program", "ok"], ["signed_in", "ok"], ["session", "warning"]]);
    expect(odd.steps![2]!.message).toContain("does not look like a Cursor chat id");
  });

  it("stops at the program when it does not start, and says what it did not do", async () => {
    const gone = await cursorPlugin.check({ ...wake, command: "agent" }, { PATH: "" }, checks({}).run, { call: true });
    expect(gone.ok).toBe(false);
    expect(statuses(gone)).toEqual([["program", "failed"], ["signed_in", "skipped"], ["session", "skipped"], ["call", "skipped"]]);
    expect(gone.steps![0]!.message).toBe("agent is not on PATH");
    // #32: a seat directory that is gone reads as a failed program, not a pass.
    const path = await bin("agent");
    const nowhere = await cursorPlugin.check({ ...wake, command: "agent", cwd: join(work, "gone") }, { PATH: path }, checks({}).run);
    expect(nowhere.ok).toBe(false);
    expect(nowhere.steps![0]!.message).toContain("is not there");
  });

  it("only looks at a launcher for the steps it may not accept, and a refused throwaway turn through it is only a warning", async () => {
    const path = await bin("agent", "cursor-room.sh");
    const launcher = { ...wake, command: join(path, "cursor-room.sh") };
    const quiet = checks({});
    const looked = await cursorPlugin.check(launcher, {}, quiet.run);
    expect(statuses(looked)).toEqual([["program", "ok"], ["signed_in", "skipped"], ["session", "skipped"]]);
    expect(quiet.ran).toHaveLength(0);
    const refused = await cursorPlugin.check(launcher, {}, checks({ call: { exitCode: 2, stderr: "usage: cursor-room.sh --resume <id>\n" } }).run, { call: true });
    expect(refused.ok).toBe(true);
    expect(statuses(refused)).toEqual([["program", "ok"], ["signed_in", "skipped"], ["session", "skipped"], ["call", "warning"]]);
  });
});
