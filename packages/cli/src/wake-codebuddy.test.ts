// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { wakeSessionKey } from "./guest.ts";
import { codebuddyPlugin, codebuddyProgram } from "./wake-codebuddy.ts";
import { harnessFreeEnv, livePrompt, type DeliveryContext, type SeatWake, type TurnOutcome, type TurnSpec, type WakeInput } from "./wake-driver.ts";
import { describeWake, parseSeatWake, pluginFor, seatWakeFrom, wakePlugins } from "./wake-plugins.ts";

// All synthetic: ids are made up, no CodeBuddy or WorkBuddy program is started, nothing is read from
// ~/.workbuddy or ~/.codebuddy.
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function bin(...programs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-codebuddy-"));
  cleanup.push(directory);
  for (const program of programs) {
    await writeFile(join(directory, program), "#!/bin/sh\n");
    await chmod(join(directory, program), 0o755);
  }
  return directory;
}

const about = { roomId: "rom_AbCdEfGhIj", seat: "wb", memberId: "i_SeatSeatSe", messages: [{ sequence: 7, content: "@wb draft the weekly report", sender: { name: "ann" } }], from: 6, through: 7 };
const input: WakeInput = { ...about, prompt: "TURN PROMPT", livePrompt: livePrompt(about) };
const SESSION = "64db2dd8-bdab-4f83-b1e3-92d0b4086103";
const wake: SeatWake = { driver: "codebuddy", session: SESSION, cwd: "/work", command: "codebuddy", config_dir: "/home/yu/.workbuddy" };

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

describe("the codebuddy plugin in the registry", () => {
  it("is known by its driver, and recognises a process that CodeBuddy or WorkBuddy runs a command for", () => {
    expect(wakePlugins.map((plugin) => plugin.driver)).toEqual(["codex", "claude-code", "codebuddy", "manus", "command"]);
    expect(pluginFor("codebuddy").label).toBe("CodeBuddy");
    const inWorkBuddy = { CODEBUDDY_SESSION_ID: SESSION, CODEBUDDY_HOST: "workbuddy-desktop", CODEBUDDY_CONFIG_DIR: "/home/yu/.workbuddy", WORKBUDDY_CONFIG_DIR: "/home/yu/.workbuddy", PATH: "" };
    expect(seatWakeFrom(inWorkBuddy, "/w")).toEqual({ driver: "codebuddy", session: SESSION, cwd: "/w", command: "codebuddy", config_dir: "/home/yu/.workbuddy" });
    // The config directory falls back to WorkBuddy's own name for it; with neither, the CLI's default applies.
    expect(codebuddyPlugin.capture({ CODEBUDDY_SESSION_ID: SESSION, WORKBUDDY_CONFIG_DIR: "/wb", PATH: "" }, "/w")).toMatchObject({ config_dir: "/wb" });
    expect(codebuddyPlugin.capture({ CODEBUDDY_SESSION_ID: SESSION, PATH: "" }, "/w")).toEqual({ driver: "codebuddy", session: SESSION, cwd: "/w", command: "codebuddy" });
    // Markers without a session id (the app's own processes, a plugin's) are not a conversation to resume.
    expect(codebuddyPlugin.capture({ CODEBUDDY_HOST: "workbuddy-desktop", WORKBUDDY_PRODUCT_NAME: "WorkBuddy", PATH: "" }, "/w")).toBeNull();
    expect(codebuddyPlugin.capture({ CLAUDE_PLUGIN_ROOT: "/p", PATH: "" }, "/w")).toBeNull();
  });

  it("finds whichever of the CLI's two names is on PATH", async () => {
    const path = await bin("cbc");
    expect(codebuddyProgram({ PATH: path })).toBe(join(path, "cbc"));
    expect(codebuddyProgram({ PATH: "" })).toBe("codebuddy");
  });

  it("keeps the config directory of a codebuddy wake only, and needs a session", () => {
    expect(parseSeatWake({ ...wake })).toEqual(wake);
    expect(parseSeatWake({ driver: "codebuddy", cwd: "/w", command: "codebuddy" })).toBeUndefined();
    expect(parseSeatWake({ driver: "codex", session: "019a", cwd: "/w", command: "codex", config_dir: "/x" })).toEqual({ driver: "codex", session: "019a", cwd: "/w", command: "codex" });
    expect(describeWake(wake)).toBe(`codebuddy ${SESSION}`);
  });

  it("scrubs the parent conversation's markers from what a delivery runs under", () => {
    const kept = harnessFreeEnv({ CODEBUDDY_SESSION_ID: SESSION, CODEBUDDY_TOOL_CALL_ID: "t", CODEBUDDY_CONVERSATION_REQUEST_ID: "r", CODEBUDDY_HOST: "workbuddy-desktop", HOME: "/home/yu" });
    expect(kept).toEqual({ CODEBUDDY_HOST: "workbuddy-desktop", HOME: "/home/yu" });
  });
});

describe("the codebuddy plugin: delivering", () => {
  it("resumes the conversation in its config directory and replies with the result", async () => {
    const { ran, context } = scripted({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SESSION, result: "@ann the report is drafted." }) });
    const delivery = await codebuddyPlugin.deliver(wake, input, { ...context, env: { PATH: "", CODEBUDDY_SESSION_ID: "parent-session", CODEBUDDY_HOST: "workbuddy-desktop" } });
    expect(delivery).toEqual({ kind: "replied", reply: "@ann the report is drafted." });
    expect([ran[0]!.command, ...ran[0]!.args]).toEqual(["codebuddy", "-p", "--resume", SESSION, "--output-format", "json"]);
    expect(ran[0]!.input).toBe("TURN PROMPT");
    expect(ran[0]!.cwd).toBe("/work");
    expect(ran[0]!.env).toMatchObject({ CODEBUDDY_CONFIG_DIR: "/home/yu/.workbuddy", SHAREDNET_SEAT: "i_SeatSeatSe", CODEBUDDY_HOST: "workbuddy-desktop" });
    expect(ran[0]!.env).not.toHaveProperty("CODEBUDDY_SESSION_ID");
  });

  it("runs a launcher exactly as it runs the CLI, and leaves the config directory to the CLI when none was recorded", async () => {
    const { ran, context } = scripted({ stdout: '{"type":"result","is_error":false,"result":"ok"}' });
    await codebuddyPlugin.deliver({ driver: "codebuddy", session: SESSION, cwd: "/w", command: "/opt/launchers/workbuddy-cli.sh" }, input, context);
    expect(ran[0]!.command).toBe("/opt/launchers/workbuddy-cli.sh");
    expect(ran[0]!.env).not.toHaveProperty("CODEBUDDY_CONFIG_DIR");
  });

  it("reads the array of events CodeBuddy 2.106.4 prints, by its last result, as seen from WorkBuddy 5.2.5", async () => {
    // Shape of a live run (2026-10-14): pretty-printed array, 13 events, the result last. Contents stripped.
    const events = [
      { type: "message", role: "user", sessionId: SESSION, content: [{ type: "input_text", text: "stripped" }] },
      { type: "file-history-snapshot", isSnapshotUpdate: false, snapshot: {} },
      { type: "reasoning", sessionId: SESSION, content: [] },
      { type: "function_call", name: "Read", callId: "c1", arguments: "{}" },
      { type: "function_call_result", name: "Read", callId: "c1", status: "completed", output: {} },
      { type: "message", role: "assistant", sessionId: SESSION, status: "completed", content: [{ type: "output_text", text: "an earlier assistant message" }] },
      { type: "result", subtype: "success", is_error: false, result: "WB-RAW-OK", session_id: "f07732fe-da9e-4f94-b6b3-e737e37cd0f2", total_cost_usd: 0, num_turns: 10 },
    ];
    const printed = JSON.stringify(events, null, 2);
    expect(printed.split("\n").length).toBeGreaterThan(20);
    const ok = scripted({ stdout: printed });
    expect(await codebuddyPlugin.deliver(wake, input, ok.context)).toEqual({ kind: "replied", reply: "WB-RAW-OK" });
    // An error result in the array is a failure with its words; an array with no result is a failure.
    const refused = scripted({ stdout: JSON.stringify([...events.slice(0, 3), { type: "result", subtype: "error_during_execution", is_error: true, result: "Please log in first" }], null, 2) });
    expect(await codebuddyPlugin.deliver(wake, input, refused.context)).toMatchObject({ kind: "failed", why: "Please log in first" });
    const none = scripted({ stdout: JSON.stringify(events.slice(0, 5), null, 2) });
    expect((await codebuddyPlugin.deliver(wake, input, none.context)).kind).toBe("failed");
    // A last result wins over an earlier one, and a non-object element is skipped.
    const two = scripted({ stdout: JSON.stringify([{ type: "result", is_error: false, result: "old" }, null, "x", { type: "result", is_error: false, result: "new" }], null, 2) });
    expect(await codebuddyPlugin.deliver(wake, input, two.context)).toEqual({ kind: "replied", reply: "new" });
  });

  it("still reads Claude Code's single object, or one per line, as before", async () => {
    const result = { type: "result", is_error: false, result: "done" };
    const one = scripted({ stdout: JSON.stringify(result) });
    expect(await codebuddyPlugin.deliver(wake, input, one.context)).toEqual({ kind: "replied", reply: "done" });
    const lines = scripted({ stdout: `${JSON.stringify({ type: "system" })}\n${JSON.stringify(result)}\n` });
    expect(await codebuddyPlugin.deliver(wake, input, lines.context)).toEqual({ kind: "replied", reply: "done" });
    const none = scripted({ stdout: "not json at all" });
    expect((await codebuddyPlugin.deliver(wake, input, none.context)).kind).toBe("failed");
  });

  it("fails with the CLI's own words, and a turn stopped for time is a timeout", async () => {
    const refused = scripted({ exitCode: 1, stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Please log in first" }) });
    expect(await codebuddyPlugin.deliver(wake, input, refused.context)).toMatchObject({ kind: "failed", why: "Please log in first", timedOut: false });
    const silent = scripted({ exitCode: 2, stderr: "session not found" });
    expect(await codebuddyPlugin.deliver(wake, input, silent.context)).toMatchObject({ kind: "failed", why: "the codebuddy command exited 2", detail: "session not found" });
    const late = scripted({ exitCode: 143, timedOut: true });
    expect(await codebuddyPlugin.deliver(wake, input, late.context)).toMatchObject({ kind: "failed", timedOut: true });
    // Never an `is_error: false` result with a nonzero exit taken for a reply.
    const odd = scripted({ exitCode: 1, stdout: '{"type":"result","is_error":false,"result":"hm"}' });
    expect((await codebuddyPlugin.deliver(wake, input, odd.context)).kind).toBe("failed");
  });
});

describe("the codebuddy plugin: check", () => {
  it("says what to do when WorkBuddy's CLI is not on PATH", async () => {
    const result = await codebuddyPlugin.check({ ...wake, config_dir: undefined } as SeatWake, { PATH: "" }, async () => {
      throw new Error("must not start");
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("codebuddy is not on PATH");
    expect(result.message).toContain("launcher");
  });

  it("looks at a launcher without starting it, and asks the real CLI for its version", async () => {
    const path = await bin("codebuddy", "workbuddy-cli.sh");
    const asked: TurnSpec[] = [];
    const run = async (spec: TurnSpec) => (asked.push(spec), { exitCode: 0, stdout: "2.106.4\n", stderr: "", timedOut: false });
    const cli = await codebuddyPlugin.check({ driver: "codebuddy", session: SESSION, cwd: path, command: "codebuddy" }, { PATH: path }, run);
    expect(cli).toEqual({ ok: true, message: `${join(path, "codebuddy")} 2.106.4` });
    expect(asked[0]!.args).toEqual(["--version"]);
    const launcher = await codebuddyPlugin.check({ driver: "codebuddy", session: SESSION, cwd: path, command: join(path, "workbuddy-cli.sh") }, { PATH: "" }, run);
    expect(launcher.ok).toBe(true);
    expect(launcher.message).toContain("a launcher; not started");
    expect(asked).toHaveLength(1);
  });

  it("asks the cbc alias for its version too, so a broken cbc is not reported healthy, and still only looks at a launcher", async () => {
    const path = await bin("cbc", "my-launcher.sh");
    const asked: TurnSpec[] = [];
    const broken = async (spec: TurnSpec) => (asked.push(spec), { exitCode: 7, stdout: "", stderr: "cbc: payload missing\n", timedOut: false });
    const cbc = await codebuddyPlugin.check({ driver: "codebuddy", session: SESSION, cwd: path, command: "cbc" }, { PATH: path }, broken);
    expect(cbc.ok).toBe(false);
    expect(cbc.message).toContain("cbc --version exited 7: cbc: payload missing");
    expect(asked).toHaveLength(1);
    expect([asked[0]!.command, ...asked[0]!.args]).toEqual([join(path, "cbc"), "--version"]);
    const healthy = await codebuddyPlugin.check({ driver: "codebuddy", session: SESSION, cwd: path, command: join(path, "cbc") }, { PATH: "" }, async () => ({ exitCode: 0, stdout: "2.106.4\n", stderr: "", timedOut: false }));
    expect(healthy).toEqual({ ok: true, message: `${join(path, "cbc")} 2.106.4` });
    // A launcher, even one named like the alias plus a suffix, is not started.
    const launcher = await codebuddyPlugin.check({ driver: "codebuddy", session: SESSION, cwd: path, command: join(path, "my-launcher.sh") }, { PATH: "" }, broken);
    expect(launcher.message).toContain("a launcher; not started");
    expect(asked).toHaveLength(1);
  });

  it("fails when the config directory that holds the session is not there", async () => {
    const result = await codebuddyPlugin.check({ ...wake, config_dir: "/definitely/not/here/.workbuddy" }, { PATH: "" }, async () => {
      throw new Error("must not start");
    });
    expect(result).toEqual({ ok: false, message: "/definitely/not/here/.workbuddy (the CodeBuddy config directory holding the session) is not readable" });
  });
});

describe("one turn per session (serve)", () => {
  it("keys a CodeBuddy conversation by its config directory too, and leaves the other drivers' keys as they were", () => {
    expect(wakeSessionKey({ ...wake })).not.toEqual(wakeSessionKey({ ...wake, config_dir: "/home/yu/.codebuddy" }));
    expect(wakeSessionKey({ ...wake })).toEqual(wakeSessionKey({ ...wake, cwd: "/elsewhere" }));
    expect(wakeSessionKey({ driver: "claude-code", session: "6613", cwd: "/w", command: "claude" })).toBe('["claude-code",null,"6613"]');
    expect(wakeSessionKey({ driver: "codex", session: "019a", cwd: "/w", command: "codex", codex_home: "/h" })).toBe('["codex","/h","019a"]');
    expect(wakeSessionKey({ driver: "command", cwd: "/w", command: "/bin/bot" })).toBeNull();
  });
});
