// @vitest-environment node

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_CHECK_ARGS, claudePlugin, claudeTranscript } from "./wake-claude.ts";
import { CODEX_CHECK_ARGS, codexError, codexPlugin, codexRollout } from "./wake-codex.ts";
import { commandPlugin, EXIT_BUSY, EXIT_HANDED } from "./wake-command.ts";
import { checkFromSteps, checkProgram, harnessFreeEnv, livePrompt, onPath, runTurn, startVerdict, type CheckResult, type CheckStep, type DeliveryContext, type SeatWake, type TurnOutcome, type TurnSpec, type WakeInput } from "./wake-driver.ts";
import { describeWake, parseSeatWake, pluginFor, seatWakeFrom, wakePlugins } from "./wake-plugins.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function bin(...programs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-plugins-"));
  cleanup.push(directory);
  for (const program of programs) {
    await writeFile(join(directory, program), "#!/bin/sh\n");
    await chmod(join(directory, program), 0o755);
  }
  return directory;
}

const about = { roomId: "rom_AbCdEfGhIj", seat: "helper", memberId: "i_SeatSeatSe", messages: [{ sequence: 7, content: "@helper look at the build", sender: { name: "ann" } }], from: 6, through: 7 };
const input: WakeInput = { ...about, prompt: "TURN PROMPT", livePrompt: livePrompt(about) };

/** A stand-in for every program a plugin runs: answers in order, and keeps what it was asked. */
function scripted(...answers: Array<Partial<TurnOutcome>>) {
  const ran: TurnSpec[] = [];
  const context: DeliveryContext = {
    env: { PATH: "" },
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

const CODEX_DONE = ['{"type":"item.completed","item":{"type":"agent_message","text":"@ann the build is green."}}', '{"type":"turn.completed","usage":{}}'].join("\n");
const ACTIVE_WRITER = "ERROR codex_core::session: Failed to create session: thread-store conflict: thread 019a already has an active writer";

describe("the registry", () => {
  it("knows each plugin by its driver, and asks them in turn which harness this process is", () => {
    expect(wakePlugins.map((plugin) => plugin.driver)).toEqual(["codex", "claude-code", "command"]);
    expect(pluginFor("claude-code").label).toBe("Claude Code");
    expect(seatWakeFrom({ CODEX_SESSION_ID: "019a", PATH: "" }, "/w")?.driver).toBe("codex");
    expect(seatWakeFrom({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6613", PATH: "" }, "/w")?.driver).toBe("claude-code");
    // An adapter is chosen by a person, never recognised.
    expect(seatWakeFrom({ PATH: "" }, "/w")).toBeNull();
  });

  it("reads a command wake without a session, and a harness wake only with one", () => {
    expect(parseSeatWake({ driver: "command", cwd: "/w", command: "/bin/bot" })).toEqual({ driver: "command", cwd: "/w", command: "/bin/bot" });
    expect(parseSeatWake({ driver: "command", cwd: "/w" })).toBeUndefined();
    expect(parseSeatWake({ driver: "codex", cwd: "/w", command: "codex" })).toBeUndefined();
    expect(describeWake({ driver: "codex", session: "019a", cwd: "/w", command: "codex" })).toBe("codex 019a");
    expect(describeWake({ driver: "command", cwd: "/w", command: "/bin/bot" })).toBe("command /bin/bot");
  });
});

describe("the codex plugin", () => {
  const wake: SeatWake = { driver: "codex", session: "019a", cwd: "/work", command: "codex", codex_home: "/codex-home" };

  it("resumes an idle thread and replies with its last words", async () => {
    const { ran, context } = scripted({ stdout: CODEX_DONE });
    expect(await codexPlugin.deliver(wake, input, context)).toEqual({ kind: "replied", reply: "@ann the build is green." });
    expect(ran).toHaveLength(1);
    expect(ran[0]!.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(ran[0]!.input).toBe("TURN PROMPT");
  });

  it("queues the wake into a thread that is open elsewhere, and hands it on", async () => {
    const { ran, context } = scripted({ exitCode: 1, stderr: ACTIVE_WRITER }, { stdout: "Queued message m1 for thread 019a." });
    const delivery = await codexPlugin.deliver(wake, input, context);
    expect(delivery.kind).toBe("handed");
    expect([ran[1]!.command, ...ran[1]!.args]).toEqual(["codex", "queue", "--thread", "019a", "--message", input.livePrompt]);
    expect(ran[1]!.env).toMatchObject({ CODEX_HOME: "/codex-home", SHAREDNET_SEAT: "i_SeatSeatSe" });
  });

  it("queues through the real codex when a launcher script stands in for it", async () => {
    const path = await bin("codex");
    const { ran, context } = scripted({ exitCode: 1, stderr: ACTIVE_WRITER }, {});
    await codexPlugin.deliver({ ...wake, command: "/opt/launchers/codex-room-bypass.sh" }, input, { ...context, env: { PATH: path } });
    expect(ran[0]!.command).toBe("/opt/launchers/codex-room-bypass.sh");
    expect(ran[1]!.command).toBe(join(path, "codex"));
  });

  it("puts the wake off, unacknowledged, when the open thread cannot be queued to", async () => {
    const { context } = scripted({ exitCode: 1, stderr: ACTIVE_WRITER }, { exitCode: 2, stderr: "error: unrecognized subcommand 'queue'" });
    const delivery = await codexPlugin.deliver(wake, input, context);
    expect(delivery).toMatchObject({ kind: "busy", retryMs: 10_000 });
    expect(delivery.kind === "busy" && delivery.why).toContain("unrecognized subcommand 'queue'");
  });

  it("fails any other way, and a turn stopped for time is never queued", async () => {
    const { ran, context } = scripted({ exitCode: 1, stderr: "Not signed in" });
    expect(await codexPlugin.deliver(wake, input, context)).toMatchObject({ kind: "failed", why: "the codex command exited 1", timedOut: false });
    expect(ran).toHaveLength(1);
    const late = scripted({ exitCode: 143, stderr: ACTIVE_WRITER, timedOut: true });
    expect(await codexPlugin.deliver(wake, input, late.context)).toMatchObject({ kind: "failed", timedOut: true });
    expect(late.ran).toHaveLength(1);
  });
});

describe("the claude-code plugin", () => {
  const wake: SeatWake = { driver: "claude-code", session: "6613", cwd: "/work", command: "claude", live_pid: 4321 };

  it("leaves the wake to the chat while it is open, and runs nothing", async () => {
    const { ran, context } = scripted();
    const asked: number[] = [];
    const delivery = await claudePlugin.deliver(wake, input, { ...context, chatOpen: (pid) => (asked.push(pid), true) });
    expect(delivery).toEqual({ kind: "left", note: "its Claude Code chat is open (pid 4321)" });
    expect(asked).toEqual([4321]);
    expect(ran).toHaveLength(0);
  });

  it("resumes the session once the chat has closed, and fails with the harness's own words", async () => {
    const { ran, context } = scripted({ stdout: '{"type":"result","is_error":false,"result":"@ann done."}' });
    expect(await claudePlugin.deliver(wake, input, context)).toEqual({ kind: "replied", reply: "@ann done." });
    expect([ran[0]!.command, ...ran[0]!.args]).toEqual(["claude", "-p", "--resume", "6613", "--output-format", "json"]);
    const refused = scripted({ exitCode: 1, stdout: '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}' });
    expect(await claudePlugin.deliver(wake, input, refused.context)).toMatchObject({ kind: "failed", why: "Not logged in · Please run /login" });
  });

  it("asks an open chat to listen for itself, and a headless one not", () => {
    expect(claudePlugin.listen?.(wake, "i_SeatSeatSe")).toBe("sharednet wait --on mention --as i_SeatSeatSe --json");
    expect(claudePlugin.listen?.({ ...wake, live_pid: undefined } as SeatWake, "i_SeatSeatSe")).toBeNull();
  });
});

describe("the command plugin", () => {
  const wake: SeatWake = { driver: "command", cwd: "/work", command: "/bin/bot" };

  it("hands the adapter the wake as JSON and replies with what it prints", async () => {
    const { ran, context } = scripted({ stdout: "@ann on it\n" });
    expect(await commandPlugin.deliver(wake, input, context)).toEqual({ kind: "replied", reply: "@ann on it" });
    const handed = JSON.parse(ran[0]!.input);
    expect(handed).toMatchObject({ room_id: "rom_AbCdEfGhIj", member_id: "i_SeatSeatSe", seat: "helper", from: 6, through: 7, prompt: "TURN PROMPT" });
    expect(handed.messages[0].content).toBe("@helper look at the build");
    expect(ran[0]!.env).toMatchObject({ SHAREDNET_SEAT: "i_SeatSeatSe", SHAREDNET_ROOM_ID: "rom_AbCdEfGhIj" });
    expect(ran[0]!.cwd).toBe("/work");
  });

  it("reads its exit code: nothing printed, busy, handed on, failed", async () => {
    expect(await commandPlugin.deliver(wake, input, scripted({ stdout: "" }).context)).toEqual({ kind: "replied", reply: null });
    expect(await commandPlugin.deliver(wake, input, scripted({ exitCode: EXIT_BUSY }).context)).toMatchObject({ kind: "busy" });
    expect(await commandPlugin.deliver(wake, input, scripted({ exitCode: EXIT_HANDED }).context)).toMatchObject({ kind: "handed" });
    expect(await commandPlugin.deliver(wake, input, scripted({ exitCode: 3 }).context)).toMatchObject({ kind: "failed", why: "the /bin/bot command exited 3" });
  });

  it("is never started to be checked, only looked at", async () => {
    const path = await bin("bot");
    const { ran, context } = scripted();
    expect(await commandPlugin.check({ ...wake, command: join(path, "bot") }, {}, context.run)).toMatchObject({ ok: true });
    expect(await commandPlugin.check({ ...wake, command: "bot" }, { PATH: path }, context.run)).toMatchObject({ ok: true });
    expect(await commandPlugin.check({ ...wake, command: "/nowhere/bot" }, {}, context.run)).toMatchObject({ ok: false });
    expect(ran).toHaveLength(0);
  });
});

describe("the launch check", () => {
  it("asks the harness itself for its version, and only looks at a launcher", async () => {
    const path = await bin("codex", "codex-room-bypass.sh");
    const ok = scripted({ stdout: "codex-cli 0.162.0\n" });
    expect(await checkProgram({ driver: "codex", session: "s", cwd: path, command: "codex" }, "codex", { PATH: path }, ok.context.run)).toEqual({
      ok: true,
      message: `${join(path, "codex")} codex-cli 0.162.0`,
    });
    expect([ok.ran[0]!.command, ...ok.ran[0]!.args]).toEqual([join(path, "codex"), "--version"]);

    const launcher = scripted();
    const viaLauncher = await checkProgram({ driver: "codex", session: "s", cwd: path, command: join(path, "codex-room-bypass.sh") }, "codex", {}, launcher.context.run);
    expect(viaLauncher.ok).toBe(true);
    expect(launcher.ran).toHaveLength(0);
  });

  it("names what is wrong: not on PATH, a wrapper whose payload is gone, no answer, no directory", async () => {
    const path = await bin("codex");
    const wake: SeatWake = { driver: "codex", session: "s", cwd: path, command: "codex" };
    expect(await checkProgram(wake, "codex", { PATH: "" }, scripted().context.run)).toEqual({ ok: false, message: "codex is not on PATH" });
    const broken = scripted({ exitCode: 1, stderr: "Error: spawn /opt/homebrew/lib/codex/vendor/codex ENOENT\n" });
    expect((await checkProgram(wake, "codex", { PATH: path }, broken.context.run)).message).toContain("--version exited 1: Error: spawn");
    const silent = scripted({ timedOut: true, exitCode: 143 });
    expect((await checkProgram(wake, "codex", { PATH: path }, silent.context.run)).message).toContain("did not answer within 5s");
    // A directory that is gone would read as the program missing (spawn ENOENT); it is named instead.
    const gone = scripted();
    expect(await checkProgram({ ...wake, cwd: join(path, "gone") }, "codex", { PATH: path }, gone.context.run)).toEqual({
      ok: false,
      message: `the seat's directory ${join(path, "gone")} is not there; a delivery runs in it`,
    });
    expect(gone.ran).toHaveLength(0);
  });
});

/**
 * A stand-in for the harness, answering each kind of call the check makes by its arguments, and
 * keeping what it was asked. Nothing here reaches a model.
 */
function harness(answers: Record<string, Partial<TurnOutcome>>) {
  const ran: TurnSpec[] = [];
  const run = async (spec: TurnSpec): Promise<TurnOutcome> => {
    ran.push(spec);
    const kind = spec.args[0] === "--version" ? "version" : spec.args[0] === "auth" || spec.args[0] === "login" ? "signed_in" : "call";
    // The throwaway turn's directory exists while it runs.
    if (kind === "call") expect(existsSync(spec.cwd)).toBe(true);
    const answer = answers[kind] ?? {};
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", timedOut: answer.timedOut ?? false };
  };
  return { ran, run };
}

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
const claudeAnswered = (result: string, isError = false) => JSON.stringify({ type: "result", subtype: "success", is_error: isError, result });
const statuses = (checked: CheckResult) => checked.steps?.map((step) => [step.step, step.status]);

async function launcherIn(path: string, name: string) {
  await writeFile(join(path, name), "#!/bin/sh\n");
  await chmod(join(path, name), 0o755);
  return join(path, name);
}

describe("the claude-code wake check", () => {
  const SESSION = "96713c45-d688-4971-a55e-d2f0edbc0d72";

  /** A machine: claude on PATH, a seat directory, and a transcript filed under another directory's slug. */
  async function machine(options: { transcript?: boolean } = {}) {
    const path = await bin("claude");
    const config = await mkdtemp(join(tmpdir(), "sharednet-claude-config-"));
    cleanup.push(config);
    const seat = join(path, "seat");
    await mkdir(seat);
    await mkdir(join(config, "projects", "-Users-someone-Desktop"), { recursive: true });
    if (options.transcript !== false) await writeFile(join(config, "projects", "-Users-someone-Desktop", `${SESSION}.jsonl`), "{}\n");
    const wake: SeatWake = { driver: "claude-code", session: SESSION, cwd: seat, command: join(path, "claude") };
    const env = { PATH: path, HOME: "/nowhere", USER: "someone", CLAUDE_CONFIG_DIR: config, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "host-session" };
    return { path, config, seat, wake, env };
  }

  it("proves the path: the program, its sign-in, the transcript, and a throwaway turn", async () => {
    const { config, seat, wake, env } = await machine();
    const { ran, run } = harness({ version: { stdout: "2.1.296 (Claude Code)\n" }, signed_in: { stdout: SIGNED_IN }, call: { stdout: claudeAnswered("ok") } });
    const checked = await claudePlugin.check(wake, env, run, { call: true });

    expect(checked.ok).toBe(true);
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "ok"], ["session", "ok"], ["call", "ok"]]);
    expect(checked.steps?.[1]?.message).toBe("claude auth status: signed in (claude.ai)");
    // Found under the slug it was filed under, not the seat's.
    expect(checked.steps?.[2]?.message).toContain(join(config, "projects", "-Users-someone-Desktop", `${SESSION}.jsonl`));
    expect(checked.steps?.[3]?.message).toContain('answered "ok"');

    expect(ran.map((spec) => spec.args)).toEqual([["--version"], ["auth", "status", "--json"], [...CLAUDE_CHECK_ARGS]]);
    // Every step asks the wake's own command.
    expect(new Set(ran.map((spec) => spec.command))).toEqual(new Set([wake.command]));
    const call = ran[2]!;
    // The throwaway turn resumes nothing, saves nothing, and runs outside the seat's directory, which is then gone.
    expect(call.args).not.toContain("--resume");
    expect(call.input).toBe("Reply with exactly: ok");
    expect(call.cwd).not.toBe(seat);
    expect(existsSync(call.cwd)).toBe(false);
    // The host session's markers are left behind; the sign-in's USER is kept (the keychain is found by it).
    for (const spec of ran) {
      expect(spec.env.CLAUDECODE).toBeUndefined();
      expect(spec.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(spec.env.USER).toBe("someone");
    }
  });

  it("runs the throwaway turn without the person's hooks, MCP servers, tools or auto-memory", () => {
    // `--no-session-persistence` only skips the transcript; a global SessionStart hook still ran.
    const settings = CLAUDE_CHECK_ARGS[CLAUDE_CHECK_ARGS.indexOf("--settings") + 1]!;
    expect(JSON.parse(settings)).toEqual({ disableAllHooks: true, autoMemoryEnabled: false });
    expect(CLAUDE_CHECK_ARGS).toContain("--strict-mcp-config");
    expect(CLAUDE_CHECK_ARGS[CLAUDE_CHECK_ARGS.indexOf("--tools") + 1]).toBe("");
    expect(CLAUDE_CHECK_ARGS).toContain("--no-session-persistence");
    // Settings sources are left alone: their environment (a proxy) and sign-in still apply.
    expect(CLAUDE_CHECK_ARGS).not.toContain("--setting-sources");
    expect(CLAUDE_CHECK_ARGS).not.toContain("--bare");
  });

  it("costs no model call when serve starts", async () => {
    const { wake, env } = await machine();
    const { ran, run } = harness({ signed_in: { stdout: SIGNED_IN } });
    const checked = await claudePlugin.check(wake, env, run, { call: false });
    expect(checked.ok).toBe(true);
    expect(checked.steps?.map((step) => step.step)).toEqual(["program", "signed_in", "session"]);
    expect(ran.map((spec) => spec.args[0])).toEqual(["--version", "auth"]);
    // Called the old way, it is the same.
    expect((await claudePlugin.check(wake, env, harness({ signed_in: { stdout: SIGNED_IN } }).run)).steps).toHaveLength(3);
  });

  it("only warns when auth status says no, and lets the turn decide (2026-10-13)", async () => {
    const { wake, env } = await machine();
    // The 10-13 machine: --version answered, auth status said no, and so did the turn.
    const out = harness({ version: { stdout: "2.1.228 (Claude Code)\n" }, signed_in: { exitCode: 1, stdout: SIGNED_OUT }, call: { exitCode: 1, stdout: claudeAnswered("Not logged in · Please run /login", true) } });
    const signedOut = await claudePlugin.check(wake, env, out.run, { call: true });
    expect(signedOut.ok).toBe(false);
    expect(statuses(signedOut)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "ok"], ["call", "failed"]]);
    expect(signedOut.message).toBe(
      "model call failed: a throwaway `claude -p` turn failed: Not logged in · Please run /login; signed in warning: claude auth status: not signed in. Run `claude auth login` as the user serve runs as, unless this program signs in another way",
    );
    expect(out.ran).toHaveLength(3);

    // A program signed in some way auth status does not see: the turn answers, and the check passes.
    const other = await claudePlugin.check(wake, env, harness({ signed_in: { exitCode: 1, stdout: SIGNED_OUT }, call: { stdout: claudeAnswered("ok") } }).run, { call: true });
    expect(other.ok).toBe(true);
    expect(statuses(other)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "ok"], ["call", "ok"]]);

    // The answer is what it reports, not how it exits.
    expect((await claudePlugin.check(wake, env, harness({ signed_in: { exitCode: 0, stdout: SIGNED_OUT } }).run)).steps?.[1]?.status).toBe("warning");
    expect((await claudePlugin.check(wake, env, harness({ signed_in: { exitCode: 0, stdout: "signed in, probably" } }).run)).steps?.[1]?.status).toBe("warning");

    // A busy machine is not a broken one: a slow auth status warns.
    const slow = await claudePlugin.check(wake, env, harness({ signed_in: { timedOut: true, exitCode: 143 } }).run);
    expect(slow.steps?.[1]).toMatchObject({ status: "warning", message: expect.stringContaining("did not answer within 15s") });

    // Without USER, a signed-in Mac reads as signed out; the check says so.
    const { USER: _user, ...noUser } = env;
    const unnamed = await claudePlugin.check(wake, noUser, harness({ signed_in: { exitCode: 1, stdout: SIGNED_OUT } }).run, { call: true });
    expect(unnamed.message).toContain("but USER is not set in this environment, and Claude Code finds its keychain sign-in by USER. Set USER where serve runs");
  });

  it("reports the turn's own words when the call is refused, and whether a proxy was set", async () => {
    const { wake, env } = await machine();
    const refused = await claudePlugin.check(wake, env, harness({ signed_in: { stdout: SIGNED_IN }, call: { exitCode: 1, stdout: claudeAnswered("Failed to authenticate. API Error: 403 Request not allowed", true) } }).run, { call: true });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("model call failed: a throwaway `claude -p` turn failed: Failed to authenticate. API Error: 403 Request not allowed");
    expect(refused.message).toContain("the check ran without HTTPS_PROXY set");
    const proxied = await claudePlugin.check(wake, { ...env, HTTPS_PROXY: "http://127.0.0.1:10080" }, harness({ signed_in: { stdout: SIGNED_IN }, call: { exitCode: 1, stdout: claudeAnswered("API Error: 403", true) } }).run, { call: true });
    expect(proxied.message).toContain("the check ran with HTTPS_PROXY set");
    expect(proxied.message).not.toContain("127.0.0.1");

    const silent = await claudePlugin.check(wake, env, harness({ signed_in: { stdout: SIGNED_IN }, call: { timedOut: true, exitCode: 143 } }).run, { call: true });
    expect(silent.message).toContain("no answer within 120s");
    const empty = await claudePlugin.check(wake, env, harness({ signed_in: { stdout: SIGNED_IN }, call: { stderr: "warning: hook said something\n" } }).run, { call: true });
    expect(empty.ok).toBe(false);
  });

  it("fails a session with no transcript to resume, and says how to set it again", async () => {
    const { wake, env } = await machine({ transcript: false });
    const checked = await claudePlugin.check(wake, env, harness({ signed_in: { stdout: SIGNED_IN }, call: { stdout: claudeAnswered("ok") } }).run, { call: true });
    expect(checked.ok).toBe(false);
    expect(checked.steps?.map((step) => step.status)).toEqual(["ok", "ok", "failed", "ok"]);
    expect(checked.message).toContain(`session failed: no transcript for session ${SESSION}`);
    expect(checked.message).toContain("sharednet wake set claude-code");
  });

  it("looks where `claude auth status` says the projects are, and never outside them", async () => {
    const { wake, env } = await machine({ transcript: false });
    const elsewhere = await mkdtemp(join(tmpdir(), "sharednet-claude-projects-"));
    cleanup.push(elsewhere);
    await mkdir(join(elsewhere, "-work"));
    await writeFile(join(elsewhere, "-work", `${SESSION}.jsonl`), "{}\n");
    const reported = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", projectsDirectory: elsewhere });
    expect((await claudePlugin.check(wake, env, harness({ signed_in: { stdout: reported } }).run)).ok).toBe(true);

    expect(claudeTranscript(SESSION, {}, elsewhere)).toBe(join(elsewhere, "-work", `${SESSION}.jsonl`));
    expect(claudeTranscript("../-work/" + SESSION, {}, elsewhere)).toBeNull();
    expect(claudeTranscript(SESSION, {}, join(elsewhere, "missing"))).toBeNull();
  });

  it("skips what a program that does not start cannot answer", async () => {
    const { wake, env } = await machine();
    const { ran, run } = harness({ version: { exitCode: 1, stderr: "Error: spawn ENOENT\n" } });
    const broken = await claudePlugin.check(wake, env, run, { call: true });
    expect(statuses(broken)).toEqual([["program", "failed"], ["signed_in", "skipped"], ["session", "skipped"], ["call", "skipped"]]);
    expect(ran).toHaveLength(1);
  });

  it("checks a launcher itself, never the claude beside it, and never fails it for a step it cannot take", async () => {
    const { path, wake, env } = await machine();
    const launcher = await launcherIn(path, "claude-room.sh");
    const through = { ...wake, command: launcher };

    // The turn goes through the launcher, as a delivery does; `auth status` is not asked of it.
    const answered = harness({ call: { stdout: claudeAnswered("ok") } });
    const checked = await claudePlugin.check(through, env, answered.run, { call: true });
    expect(checked.ok).toBe(true);
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "skipped"], ["session", "ok"], ["call", "ok"]]);
    expect(answered.ran.map((spec) => [spec.command, spec.args[0]])).toEqual([[launcher, "-p"]]);
    expect(checked.steps?.[3]?.message).toContain(`through the launcher ${launcher}`);

    // A launcher that refuses the throwaway turn may accept only its resume: a warning, not a failure.
    const refused = await claudePlugin.check(through, env, harness({ call: { exitCode: 2, stderr: "usage: claude-room.sh --resume <id>\n" } }).run, { call: true });
    expect(refused.ok).toBe(true);
    expect(refused.steps?.[3]).toMatchObject({ status: "warning", message: expect.stringContaining("usage: claude-room.sh --resume <id>") });

    // With no claude on PATH at all, the launcher is still what is checked.
    const alone = harness({ call: { stdout: claudeAnswered("ok") } });
    expect((await claudePlugin.check(through, { ...env, PATH: "" }, alone.run, { call: true })).ok).toBe(true);
    expect(alone.ran.map((spec) => spec.command)).toEqual([launcher]);
  });

  // Proof against the real `claude` that the throwaway turn's flags keep the person's hooks and MCP
  // servers from running. A temporary CLAUDE_CONFIG_DIR stands in for the person's global settings,
  // with a SessionStart hook and an MCP server that each leave a marker. The API is pointed at a dead
  // local port, so no model is reached whatever the sign-in. Opt in: SHAREDNET_TEST_REAL_CLAUDE=1.
  it.skipIf(process.env.SHAREDNET_TEST_REAL_CLAUDE !== "1")("keeps a real claude's global hook and MCP server from running (opt-in)", async () => {
    const claude = onPath("claude", process.env);
    expect(claude).not.toBeNull();
    const scratch = await mkdtemp(join(tmpdir(), "sharednet-hook-proof-"));
    cleanup.push(scratch);
    const config = join(scratch, "config");
    await mkdir(config);
    const hookMarker = join(scratch, "hook-ran");
    const mcpMarker = join(scratch, "mcp-started");
    await writeFile(join(config, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch '${hookMarker}'` }] }] } }));
    await writeFile(join(config, ".claude.json"), JSON.stringify({ mcpServers: { probe: { type: "stdio", command: "/bin/sh", args: ["-c", `touch '${mcpMarker}'; sleep 2`] } } }));
    const { ANTHROPIC_API_KEY: _key, CLAUDE_CODE_OAUTH_TOKEN: _token, ...inherited } = process.env;
    const env = { ...harnessFreeEnv(inherited), CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
    const turn = (args: string[]) =>
      runTurn({ command: claude!, args, cwd: scratch, env, input: "Reply with exactly: ok", timeoutMs: 60_000 });

    // The control: without the flags, the hook runs, the MCP server starts, and auto-memory files a
    // project directory for the working directory even though no session is saved.
    await turn(["-p", "--no-session-persistence", "--output-format", "json"]);
    expect(existsSync(hookMarker)).toBe(true);
    expect(existsSync(mcpMarker)).toBe(true);
    const filed = await readdir(join(config, "projects"));
    expect(filed).toHaveLength(1);
    await rm(hookMarker);
    await rm(mcpMarker);

    // With the check's flags, through the check itself, neither does.
    const wake: SeatWake = { driver: "claude-code", session: "00000000-0000-0000-0000-000000000000", cwd: scratch, command: claude! };
    const checked = await claudePlugin.check(wake, env, runTurn, { call: true });
    expect(checked.steps?.find((step) => step.step === "call")?.status).toBe("failed");
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(mcpMarker)).toBe(false);
    // And it filed nothing for its own temporary directory.
    expect(await readdir(join(config, "projects"))).toEqual(filed);
  }, 120_000);
});

describe("serve's start verdict", () => {
  const step = (name: CheckStep["step"], status: CheckStep["status"], message = `${name} ${status}`): CheckStep => ({ step: name, status, message });

  it("holds a seat back only for a program that does not start; the rest are warnings", () => {
    expect(startVerdict(checkFromSteps([step("program", "ok"), step("signed_in", "warning"), step("session", "failed")]))).toEqual({
      ok: true,
      message: "session failed: session failed; signed in warning: signed_in warning",
      warnings: ["signed in warning: signed_in warning", "session failed: session failed"],
    });
    expect(startVerdict(checkFromSteps([step("program", "failed", "codex --version did not answer within 5s"), step("signed_in", "skipped"), step("session", "skipped")]))).toEqual({
      ok: false,
      message: "program failed: codex --version did not answer within 5s",
      warnings: [],
    });
    expect(startVerdict(checkFromSteps([step("program", "ok"), step("signed_in", "ok"), step("session", "ok")]))).toMatchObject({ ok: true, warnings: [] });
    // A check without steps (an adapter's, a stand-in's) is judged as it says.
    expect(startVerdict({ ok: false, message: "bot is not on PATH" })).toEqual({ ok: false, message: "bot is not on PATH", warnings: [] });
  });

  it("is stricter by hand: `wake check` fails on a failed session or call, never on a warning", () => {
    expect(checkFromSteps([step("program", "ok"), step("signed_in", "warning"), step("session", "ok"), step("call", "ok")]).ok).toBe(true);
    expect(checkFromSteps([step("program", "ok"), step("signed_in", "ok"), step("session", "failed")]).ok).toBe(false);
  });
});

describe("the codex wake check", () => {
  const THREAD = "019efdd0-ba96-77c3-820c-641b3e5e756c";
  const ANSWERED = ['{"type":"thread.started","thread_id":"01a1"}', '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}', '{"type":"turn.completed","usage":{}}'].join("\n");
  // Recorded 2026-10-13: Codex 0.146.0 with a model configured that needs a newer Codex.
  const TOO_OLD = [
    '{"type":"thread.started","thread_id":"01a1"}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: "error", message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model requires a newer version of Codex." } }) }),
    JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model requires a newer version of Codex." } }) } }),
  ].join("\n");

  async function machine(options: { rollout?: boolean } = {}) {
    const path = await bin("codex");
    const home = await mkdtemp(join(tmpdir(), "sharednet-codex-home-"));
    cleanup.push(home);
    await mkdir(join(home, "sessions", "2026", "06", "25"), { recursive: true });
    if (options.rollout !== false) await writeFile(join(home, "sessions", "2026", "06", "25", `rollout-2026-06-25T16-06-15-${THREAD}.jsonl`), "{}\n");
    const wake: SeatWake = { driver: "codex", session: THREAD, cwd: path, command: join(path, "codex"), codex_home: home };
    return { path, home, wake, env: { PATH: path, HOME: "/nowhere", USER: "someone", CODEX_SESSION_ID: "host-thread" } };
  }

  it("proves the path: the program, its login, the rollout, and an ephemeral turn", async () => {
    const { home, wake, env } = await machine();
    const { ran, run } = harness({ version: { stdout: "codex-cli 0.146.0\n" }, signed_in: { stderr: "Logged in using ChatGPT\n" }, call: { stdout: ANSWERED } });
    const checked = await codexPlugin.check(wake, env, run, { call: true });
    expect(checked.ok).toBe(true);
    expect(checked.steps?.map((step) => step.message)).toEqual([
      `${wake.command} codex-cli 0.146.0`,
      "codex login status: signed in with ChatGPT",
      `${THREAD} has its rollout at ${join(home, "sessions", "2026", "06", "25", `rollout-2026-06-25T16-06-15-${THREAD}.jsonl`)}`,
      'a throwaway `codex exec --ephemeral` turn answered "ok"',
    ]);
    expect(ran.map((spec) => spec.args)).toEqual([["--version"], ["login", "status"], [...CODEX_CHECK_ARGS]]);
    expect(CODEX_CHECK_ARGS).toEqual(["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-s", "read-only", "-"]);
    for (const spec of ran.slice(1)) {
      expect(spec.command).toBe(wake.command);
      expect(spec.env.CODEX_HOME).toBe(home);
      expect(spec.env.CODEX_SESSION_ID).toBeUndefined();
    }
    expect(ran[2]!.args).not.toContain("resume");
    expect(existsSync(ran[2]!.cwd)).toBe(false);
  });

  it("names a Codex too old for its configured model, which --version and login status both pass", async () => {
    const { wake, env } = await machine();
    const checked = await codexPlugin.check(wake, env, harness({ call: { exitCode: 1, stdout: TOO_OLD, stderr: "ERROR rmcp::transport::worker: worker quit\n" } }).run, { call: true });
    expect(checked.ok).toBe(false);
    expect(checked.message).toBe("model call failed: a throwaway `codex exec` turn failed: The 'gpt-6-astra' model requires a newer version of Codex.");
    expect(codexError(TOO_OLD)).toBe("The 'gpt-6-astra' model requires a newer version of Codex.");
    expect(codexError(ANSWERED)).toBeNull();
  });

  it("passes a custom provider signed in by an environment variable, which login status does not see (Codex 0.162.0)", async () => {
    const { wake, env } = await machine();
    const provider = harness({ signed_in: { exitCode: 1, stderr: "Not logged in\n" }, call: { stdout: ANSWERED } });
    const checked = await codexPlugin.check(wake, { ...env, MY_PROVIDER_API_KEY: "synthetic-test-value" }, provider.run, { call: true });
    expect(checked.ok).toBe(true);
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "ok"], ["call", "ok"]]);
    expect(checked.steps?.[1]?.message).toContain("a provider authenticated by an environment variable is not seen here");
    // The variable reaches the turn, as it reaches a delivery.
    expect(provider.ran[2]!.env.MY_PROVIDER_API_KEY).toBe("synthetic-test-value");
  });

  it("warns for a login it cannot see, fails a missing rollout, and never repeats an API key", async () => {
    const { home, wake, env } = await machine({ rollout: false });
    const checked = await codexPlugin.check(wake, env, harness({ signed_in: { exitCode: 1, stderr: "Not logged in\n" }, call: { exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}' } }).run, { call: true });
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "failed"], ["call", "failed"]]);
    expect(checked.message).toContain(`signed in warning: codex login status exited 1: Not logged in. If this Codex signs in with \`codex login\`, run it with CODEX_HOME=${home}`);
    expect(checked.message).toContain(`session failed: no rollout for thread ${THREAD}`);
    expect(checked.message).toContain("model call failed: a throwaway `codex exec` turn failed: 401 Unauthorized");

    const keyed = await codexPlugin.check(wake, env, harness({ signed_in: { stderr: "Logged in using an API key - sk-proj-***ABCDE\n" } }).run);
    expect(keyed.steps?.[1]?.message).toBe("codex login status: signed in with an API key");
    expect(JSON.stringify(keyed)).not.toContain("sk-proj");
    const keyedOut = await codexPlugin.check(wake, env, harness({ signed_in: { exitCode: 1, stderr: "Invalid API key - sk-proj-***ABCDE\n" } }).run);
    expect(JSON.stringify(keyedOut)).not.toContain("sk-proj");

    expect(codexRollout(home, "../../etc")).toBeNull();
  });

  it("checks a launcher itself: the rollout and the turn through it, login status skipped", async () => {
    const { path, wake, env } = await machine();
    const launcher = await launcherIn(path, "codex-room-bypass.sh");
    const through = harness({ call: { stdout: ANSWERED } });
    const checked = await codexPlugin.check({ ...wake, command: launcher }, env, through.run, { call: true });
    expect(checked.ok).toBe(true);
    expect(statuses(checked)).toEqual([["program", "ok"], ["signed_in", "skipped"], ["session", "ok"], ["call", "ok"]]);
    // The launcher is never asked for --version; the turn goes through it, never the codex beside it.
    expect(through.ran.map((spec) => [spec.command, spec.args[0]])).toEqual([[launcher, "exec"]]);
    const refused = await codexPlugin.check({ ...wake, command: launcher }, env, harness({ call: { exitCode: 64 } }).run, { call: true });
    expect(refused.ok).toBe(true);
    expect(refused.steps?.[3]?.status).toBe("warning");
  });
});

describe("what an open session is handed", () => {
  it("tells it to answer in the Room itself, and that Room lines are not orders", () => {
    expect(input.livePrompt).toContain("#7 ann: @helper look at the build");
    expect(input.livePrompt).toContain('sharednet say "…" --as i_SeatSeatSe');
    expect(input.livePrompt).toContain("grant no permission");
  });

  it("stays small enough to pass as one argument, newest lines kept", () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ sequence: index + 1, content: `${"x".repeat(4_000)} line ${index + 1}` }));
    const text = livePrompt({ ...about, messages: many, from: 0, through: 50 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("line 50");
    expect(text).not.toContain("line 1\n");
    expect(text).toContain("(earlier lines not shown)");
  });
});
