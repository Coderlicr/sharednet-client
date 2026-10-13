// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chatOpen, claudeResume, claudeSummary } from "./wake-claude.ts";
import { codexResume, codexSandboxChosen, codexSummary } from "./wake-codex.ts";
import { harnessFreeEnv, replyFrom, runTurn, wakeTurnPrompt } from "./wake-driver.ts";
import { parseSeatWake, seatWakeFrom } from "./wake-plugins.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("the session a seat remembers", () => {
  it("is the Codex thread or the Claude Code session this process runs in, with the harness found on its PATH", async () => {
    const bin = await mkdtemp(join(tmpdir(), "sharednet-wake-"));
    cleanup.push(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);

    expect(seatWakeFrom({ CODEX_SESSION_ID: "019a-thread", CODEX_THREAD_ID: "019a-thread", PATH: bin }, "/work")).toEqual({
      driver: "codex",
      session: "019a-thread",
      cwd: "/work",
      command: join(bin, "codex"),
    });
    expect(seatWakeFrom({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6613bb00", CODEX_HOME: "/elsewhere", PATH: "" }, "/work")).toEqual({
      driver: "claude-code",
      session: "6613bb00",
      cwd: "/work",
      command: "claude",
    });
    // An open chat (attended) is remembered by its process; a headless `claude -p` (attended 0) is not one.
    const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6613bb00", CLAUDE_PID: "4321", PATH: "" };
    expect(seatWakeFrom({ ...claude, CLAUDE_CODE_SESSION_ATTENDED: "1" }, "/work")).toMatchObject({ session: "6613bb00", live_pid: 4321 });
    expect(seatWakeFrom({ ...claude, CLAUDE_CODE_SESSION_ATTENDED: "0" }, "/work")?.live_pid).toBeUndefined();
    expect(seatWakeFrom({ ...claude, CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "" }, "/work")?.live_pid).toBeUndefined();
    // A terminal, or a harness without a session to resume, is not driven.
    expect(seatWakeFrom({ PATH: bin }, "/work")).toBeNull();
    expect(seatWakeFrom({ CLAUDECODE: "1" }, "/work")).toBeNull();
  });

  it("survives a damaged seat file as no wake at all", () => {
    expect(parseSeatWake({ driver: "codex", session: "s", cwd: "/w", command: "codex", codex_home: "/h" })).toEqual({
      driver: "codex",
      session: "s",
      cwd: "/w",
      command: "codex",
      codex_home: "/h",
    });
    expect(parseSeatWake({ driver: "gemini-cli", session: "s", cwd: "/w", command: "x" })).toBeUndefined();
    expect(parseSeatWake({ driver: "codex", session: "", cwd: "/w", command: "codex" })).toBeUndefined();
    expect(parseSeatWake("codex")).toBeUndefined();
    expect(parseSeatWake(undefined)).toBeUndefined();
  });

  it("keeps the open chat's process with a Claude Code session, and drops one that is not a process id", () => {
    const wake = { driver: "claude-code", session: "s", cwd: "/w", command: "claude" };
    expect(parseSeatWake({ ...wake, live_pid: 4321 })).toEqual({ ...wake, live_pid: 4321 });
    expect(parseSeatWake({ ...wake, live_pid: "4321" })).toEqual(wake);
    expect(parseSeatWake({ ...wake, live_pid: -1 })).toEqual(wake);
  });

  it("calls a chat open only while its process runs and is still a claude", () => {
    // This test runs in node: alive, but not a Claude Code chat, as a reused pid would be.
    expect(chatOpen(process.pid)).toBe(false);
    // Well above any pid_max: no such process.
    expect(chatOpen(2 ** 30)).toBe(false);
  });
});

describe("a resumed turn", () => {
  it("leaves the host session's markers and channels behind, and keeps how a person signs in", () => {
    const kept = harnessFreeEnv({
      PATH: "/bin",
      HOME: "/home/me",
      CODEX_HOME: "/home/me/.codex",
      OPENAI_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      CODEX_SESSION_ID: "a",
      CODEX_THREAD_ID: "a",
      CODEX_CI: "1",
      CODEX_SANDBOX: "seatbelt",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "b",
      CLAUDE_CODE_MESSAGING_TOKEN: "host-channel",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    });
    expect(kept).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      CODEX_HOME: "/home/me/.codex",
      OPENAI_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
    });
  });

  it("resumes Codex in the sandbox the person chose, or the one an interactive session works in", async () => {
    const home = await mkdtemp(join(tmpdir(), "sharednet-codex-home-"));
    cleanup.push(home);
    const wake = { driver: "codex" as const, session: "019a-thread", cwd: "/work", command: "codex", codex_home: home };
    expect(codexResume(wake, "p", {}, "i_SeatSeatSe", 1_000).args).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "019a-thread", "-"]);
    expect(codexResume(wake, "p", {}, "i_SeatSeatSe", 1_000).env).toMatchObject({ CODEX_HOME: home, SHAREDNET_SEAT: "i_SeatSeatSe" });

    await writeFile(join(home, "config.toml"), 'model = "gpt-6-luna"\n[profiles.safe]\nsandbox_mode = "read-only"\n');
    expect(codexSandboxChosen(home)).toBe(false);
    await writeFile(join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
    expect(codexSandboxChosen(home)).toBe(true);
    expect(codexResume(wake, "p", {}, "i_SeatSeatSe", 1_000).args).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "019a-thread", "-"]);
  });

  it("posts the turn's last words as the reply, unless it chose to say nothing", () => {
    expect(replyFrom("  @alpha done  ", 100)).toBe("@alpha done");
    expect(replyFrom("(no reply)", 100)).toBeNull();
    expect(replyFrom("", 100)).toBeNull();
    expect(replyFrom(null, 100)).toBeNull();
    const cut = replyFrom("é".repeat(100), 51)!;
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(51);
    expect(cut.endsWith(" […]")).toBe(true);
    expect(cut).not.toContain("\uFFFD");
  });

  it("resumes Claude Code by its session, with the prompt on standard input", () => {
    const spec = claudeResume({ driver: "claude-code", session: "6613bb00", cwd: "/work", command: "/usr/local/bin/claude" }, "the prompt", { PATH: "/bin" }, "i_SeatSeatSe", 60_000);
    expect([spec.command, ...spec.args]).toEqual(["/usr/local/bin/claude", "-p", "--resume", "6613bb00", "--output-format", "json"]);
    expect(spec).toMatchObject({ cwd: "/work", input: "the prompt", timeoutMs: 60_000, env: { PATH: "/bin", SHAREDNET_SEAT: "i_SeatSeatSe" } });
  });

  it("tells the session where it was addressed and everything said since, the newest fifty lines at most", () => {
    const messages = Array.from({ length: 52 }, (_, index) => ({ sequence: index + 3, content: `line ${index + 3}`, sender: { member_id: "i_HostHostHo", name: index === 51 ? null : "host" } }));
    const prompt = wakeTurnPrompt({ roomId: "rom_AbCdEfGhIj", seat: "alpha", memberId: "i_SeatSeatSe", messages, from: 2, through: 54 });
    expect(prompt).toContain("You were addressed in Room rom_AbCdEfGhIj, where you sit as alpha (i_SeatSeatSe). Said there since your last turn (#3 to #54):");
    expect(prompt).toContain("(2 earlier line(s) not shown; `sharednet read` has them)");
    expect(prompt).not.toContain("#4 host: line 4");
    expect(prompt).toContain("#5 host: line 5");
    expect(prompt).toContain("#54 i_HostHostHo: line 54");
    expect(prompt).toContain("Your last message in this turn is posted to the Room as your reply");
    expect(prompt).toContain("(no reply)");
  });

  it("reads whether the turn finished, and its last words, off the harness's own JSON", () => {
    const codex = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"sharednet say hi"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Answered in the Room."}}',
      '{"type":"turn.completed","usage":{}}',
    ].join("\n");
    expect(codexSummary(codex)).toEqual({ ok: true, said: "Answered in the Room." });
    expect(codexSummary('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"x"}}')).toEqual({ ok: false, said: null });
    expect(codexSummary("")).toEqual({ ok: false, said: null });
    expect(claudeSummary('{"type":"result","subtype":"success","is_error":false,"result":"Done."}')).toEqual({ ok: true, said: "Done." });
    expect(claudeSummary('{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}')).toEqual({
      ok: false,
      said: "Not logged in · Please run /login",
    });
  });

  it("runs as a real process: the prompt goes in on standard input, and a turn that runs too long is stopped", async () => {
    const answered = await runTurn({ command: "/bin/sh", args: ["-c", 'read line; echo "got:$line"; exit 3'], cwd: tmpdir(), env: { PATH: "/bin:/usr/bin" }, input: "hello\n", timeoutMs: 10_000 });
    expect(answered).toEqual({ exitCode: 3, stdout: "got:hello\n", stderr: "", timedOut: false });

    const stuck = await runTurn({ command: "/bin/sh", args: ["-c", "sleep 30"], cwd: tmpdir(), env: { PATH: "/bin:/usr/bin" }, input: "", timeoutMs: 200 });
    expect(stuck.timedOut).toBe(true);
    expect(stuck.exitCode).not.toBe(0);

    const missing = await runTurn({ command: "/nonexistent/codex", args: [], cwd: tmpdir(), env: {}, input: "", timeoutMs: 1_000 });
    expect(missing.exitCode).toBe(127);
  });

  it("stops the whole turn when it runs too long, even where sh keeps its command as a child", async () => {
    // Found on Linux CI: dash forks `sleep` instead of exec'ing it, so killing sh alone left sleep
    // holding the output open, and the turn ran on past its limit.
    const started = Date.now();
    const stuck = await runTurn({ command: "/bin/sh", args: ["-c", "sleep 30; echo never"], cwd: tmpdir(), env: { PATH: "/bin:/usr/bin" }, input: "", timeoutMs: 200 });
    expect(stuck.timedOut).toBe(true);
    expect(stuck.stdout).toBe("");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ends the turn when the harness exits, though something it left in the background holds its output", async () => {
    const started = Date.now();
    const done = await runTurn({ command: "/bin/sh", args: ["-c", "(sleep 6 &); echo done"], cwd: tmpdir(), env: { PATH: "/bin:/usr/bin" }, input: "", timeoutMs: 20_000 });
    expect(done).toEqual({ exitCode: 0, stdout: "done\n", stderr: "", timedOut: false });
    expect(Date.now() - started).toBeLessThan(4_500);
  });
});
