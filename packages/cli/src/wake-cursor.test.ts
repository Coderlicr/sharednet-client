// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cursorPlugin, cursorResume, cursorSummary, fitPrompt } from "./wake-cursor.ts";
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
const wake: SeatWake = { driver: "cursor", session: "8f1c0d6e-2b7a-4c1e-9d11-0a5b3c2d1e00", cwd: "/work", command: "cursor-agent" };

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
    expect(ran[0]!.cwd).toBe("/work");
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
    expect(cursorSummary(`warning: update available\n${DONE}\n`)).toEqual({ ok: true, said: "@ann the build is green." });
    expect(cursorSummary("")).toEqual({ ok: false, said: null });
    expect(cursorSummary(JSON.stringify({ type: "assistant", message: {} }))).toEqual({ ok: false, said: null });
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

  it("checks the CLI by asking it for its version, and only looks at a launcher", async () => {
    const path = await bin("agent", "cursor-agent", "cursor-room.sh");
    const asked = scripted({ stdout: "2026.10.01-abc\n" });
    expect(await cursorPlugin.check({ ...wake, command: "agent" }, { PATH: path }, asked.context.run)).toEqual({ ok: true, message: `${join(path, "agent")} 2026.10.01-abc` });
    expect([asked.ran[0]!.command, ...asked.ran[0]!.args]).toEqual([join(path, "agent"), "--version"]);
    const alias = scripted({ stdout: "2026.10.01-abc\n" });
    expect((await cursorPlugin.check(wake, { PATH: path }, alias.context.run)).ok).toBe(true);
    expect(alias.ran[0]!.command).toBe(join(path, "cursor-agent"));

    const launcher = scripted();
    expect(await cursorPlugin.check({ ...wake, command: join(path, "cursor-room.sh") }, {}, launcher.context.run)).toMatchObject({ ok: true });
    expect(launcher.ran).toHaveLength(0);
    expect(await cursorPlugin.check({ ...wake, command: "agent" }, { PATH: "" }, scripted().context.run)).toEqual({ ok: false, message: "agent is not on PATH" });
  });
});
