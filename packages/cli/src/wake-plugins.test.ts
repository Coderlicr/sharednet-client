// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudePlugin } from "./wake-claude.ts";
import { codexPlugin } from "./wake-codex.ts";
import { commandPlugin, EXIT_BUSY, EXIT_HANDED } from "./wake-command.ts";
import { checkProgram, livePrompt, type DeliveryContext, type SeatWake, type TurnOutcome, type TurnSpec, type WakeInput } from "./wake-driver.ts";
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
    expect(await checkProgram({ driver: "codex", session: "s", cwd: "/w", command: "codex" }, "codex", { PATH: path }, ok.context.run)).toEqual({
      ok: true,
      message: `${join(path, "codex")} codex-cli 0.162.0`,
    });
    expect([ok.ran[0]!.command, ...ok.ran[0]!.args]).toEqual([join(path, "codex"), "--version"]);

    const launcher = scripted();
    const viaLauncher = await checkProgram({ driver: "codex", session: "s", cwd: "/w", command: join(path, "codex-room-bypass.sh") }, "codex", {}, launcher.context.run);
    expect(viaLauncher.ok).toBe(true);
    expect(launcher.ran).toHaveLength(0);
  });

  it("names what is wrong: not on PATH, a wrapper whose payload is gone, no answer", async () => {
    const path = await bin("codex");
    const wake: SeatWake = { driver: "codex", session: "s", cwd: "/w", command: "codex" };
    expect(await checkProgram(wake, "codex", { PATH: "" }, scripted().context.run)).toEqual({ ok: false, message: "codex is not on PATH" });
    const broken = scripted({ exitCode: 1, stderr: "Error: spawn /opt/homebrew/lib/codex/vendor/codex ENOENT\n" });
    expect((await checkProgram(wake, "codex", { PATH: path }, broken.context.run)).message).toContain("--version exited 1: Error: spawn");
    const silent = scripted({ timedOut: true, exitCode: 143 });
    expect((await checkProgram(wake, "codex", { PATH: path }, silent.context.run)).message).toContain("did not answer within 5s");
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
