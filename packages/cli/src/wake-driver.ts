import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { detectRuntime } from "./runtime-detection.ts";

/**
 * Waking the session that took a seat (wait, the drivers).
 *
 * A seat joined from inside a Codex or Claude Code session remembers that session: the harness's
 * own session id, the directory it worked in, and the harness command. When the seat is addressed
 * in its Room — by a member, a hook or the clock, always as an @ line — `sharednet serve` resumes
 * that same session with what was said, so the agent answers knowing everything it knew when it
 * joined, and posts the turn's last message as the seat's reply. Nothing here starts a fresh agent:
 * a seat with no session to resume is not driven.
 *
 * The reply is relayed rather than left to the agent because a resumed turn may not reach the Room
 * itself: `codex exec resume` runs read-only and offline unless told otherwise, and `claude -p` may
 * not be allowed to run commands. Relaying makes answering depend on nothing but the turn finishing.
 *
 * Verified on 2026-10-05 with Codex 0.160.0: inside a session CODEX_SESSION_ID is the thread id that
 * `codex exec resume` takes, and the resumed thread remembers its earlier turns. Claude Code exports
 * CLAUDE_CODE_SESSION_ID, which `claude -p --resume` takes; that needs the `claude` command signed in.
 */

type Environment = Record<string, string | undefined>;

export type WakeDriver = "codex" | "claude-code";

export interface SeatWake {
  driver: WakeDriver;
  /** The harness's own session id: what `codex exec resume` and `claude --resume` take. */
  session: string;
  /** Where the session worked when it joined; a resumed turn runs there. */
  cwd: string;
  /** The harness command, resolved on the joining session's PATH when it could be. */
  command: string;
  /** Codex finds a session only under the CODEX_HOME it was started with. */
  codex_home?: string;
  /**
   * The Claude Code process of a chat a person has open (CLAUDE_PID, when CLAUDE_CODE_SESSION_ATTENDED
   * is 1). While it runs, `claude -p --resume` would be a second writer to the chat's transcript that
   * the open chat never sees, so the seat's lines are left to the chat's own `sharednet wait`; once
   * it has closed, the session is resumed as usual. A headless `claude -p` is attended 0 and has none.
   */
  live_pid?: number;
}

function onPath(name: string, env: Environment): string | null {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The session this process runs in, when it is one a wake can resume. */
export function seatWakeFrom(env: Environment, cwd: string): SeatWake | null {
  const detected = detectRuntime(env);
  if (detected.anchor === null) return null;
  if (detected.kind === "codex") {
    const home = env.CODEX_HOME?.trim();
    return { driver: "codex", session: detected.anchor, cwd, command: onPath("codex", env) ?? "codex", ...(home ? { codex_home: home } : {}) };
  }
  if (detected.kind === "claude-code") {
    const pid = env.CLAUDE_CODE_SESSION_ATTENDED?.trim() === "1" ? Number(env.CLAUDE_PID?.trim()) : NaN;
    return {
      driver: "claude-code",
      session: detected.anchor,
      cwd,
      command: onPath("claude", env) ?? "claude",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { live_pid: pid } : {}),
    };
  }
  return null;
}

/** A stored wake, or nothing: a seat file with a damaged wake is still a seat, just not driven. */
export function parseSeatWake(value: unknown): SeatWake | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : null);
  const driver = record.driver === "codex" || record.driver === "claude-code" ? record.driver : null;
  const session = text(record.session);
  const cwd = text(record.cwd);
  const command = text(record.command);
  if (!driver || !session || !cwd || !command) return undefined;
  const home = text(record.codex_home);
  const live = record.live_pid;
  return {
    driver,
    session,
    cwd,
    command,
    ...(home ? { codex_home: home } : {}),
    ...(typeof live === "number" && Number.isSafeInteger(live) && live > 0 ? { live_pid: live } : {}),
  };
}

/**
 * Whether the Claude Code chat with this process id is still open. The pid alone is not enough: once
 * the chat has closed the number can be handed to any other process, so the process must also still
 * be a `claude`. Where `ps` cannot say, the chat is taken as closed and the session is resumed.
 */
export function chatOpen(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const named = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  return named.status === 0 && /claude/i.test(named.stdout);
}

// The variables a harness sets for the commands it runs. Handed on, they would make the resumed
// harness believe it runs inside the session it is resuming, and carry the host's channels with it.
const HARNESS_SESSION_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_VERSION",
]);
// CLAUDE_CODE_* is mostly the host session's own wiring; these few are how a person signs in.
const KEPT_CLAUDE_CODE_KEYS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);

export function harnessFreeEnv(env: Environment): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || HARNESS_SESSION_KEYS.has(key)) continue;
    if (key.startsWith("CLAUDE_CODE_") && !KEPT_CLAUDE_CODE_KEYS.has(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/** True inside a harness sandbox, where a background service would inherit the sandbox. */
export function sandboxed(env: Environment): boolean {
  return Boolean(env.CODEX_SANDBOX?.trim());
}

interface WakeMessage {
  sequence: number;
  content: string;
  sender?: { member_id?: string; name?: string | null; kind?: string };
}

/** How many lines a wake shows; the rest are a `sharednet read` away. */
const PROMPT_MESSAGES = 50;
/** What a turn ends with when it has nothing to say back; nothing is posted then. */
export const NO_REPLY = "(no reply)";

/** What a resumed session is told: where it was addressed, and everything said since its last turn. */
export function wakeTurnPrompt(input: { roomId: string; seat: string; memberId: string; messages: WakeMessage[]; from: number; through: number }): string {
  const shown = input.messages.slice(-PROMPT_MESSAGES);
  const hidden = input.messages.length - shown.length;
  return [
    `[SharedNet] You were addressed in Room ${input.roomId}, where you sit as ${input.seat} (${input.memberId}). Said there since your last turn (#${input.from + 1} to #${input.through}):`,
    ...(hidden > 0 ? [`(${hidden} earlier line(s) not shown; \`sharednet read\` has them)`] : []),
    ...shown.map((message) => `#${message.sequence} ${message.sender?.name ?? message.sender?.member_id ?? "someone"}: ${message.content}`),
    "",
    `Do what is asked of you. Your last message in this turn is posted to the Room as your reply, so do not post it yourself; write @name to address someone, or end with exactly ${NO_REPLY} when there is nothing to say. You are woken again the next time someone addresses you.`,
  ].join("\n");
}

export interface TurnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The prompt, on standard input, so no length or quoting limit applies. */
  input: string;
  timeoutMs: number;
}

export interface TurnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type TurnRunner = (spec: TurnSpec) => Promise<TurnOutcome>;

/**
 * Whether the person chose a sandbox for Codex: a top-level `sandbox_mode` in its config.toml. A
 * profile's choice applies only to runs that name the profile, so it does not count.
 */
export function codexSandboxChosen(codexHome: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) return false;
    if (/^\s*sandbox_mode\s*=/.test(line)) return true;
  }
  return false;
}

/** One resumed turn of the seat's own session, asking nothing of a person. */
export function turnSpec(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec {
  const environment = {
    ...harnessFreeEnv(env),
    // `sharednet` in the resumed turn speaks as this seat, whatever else the directory holds.
    SHAREDNET_SEAT: memberId,
    ...(wake.codex_home ? { CODEX_HOME: wake.codex_home } : {}),
  };
  if (wake.driver === "codex") {
    // The person's own sandbox, when they chose one. Otherwise `exec resume` would run read-only,
    // which is less than the session had: the default an interactive Codex session works in is
    // workspace-write, so the woken turn gets that.
    const home = wake.codex_home ?? env.CODEX_HOME?.trim() ?? join(env.HOME || homedir(), ".codex");
    return {
      command: wake.command,
      args: [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        ...(codexSandboxChosen(home) ? [] : ["-c", 'sandbox_mode="workspace-write"']),
        wake.session,
        "-",
      ],
      cwd: wake.cwd,
      env: environment,
      input: prompt,
      timeoutMs,
    };
  }
  return { command: wake.command, args: ["-p", "--resume", wake.session, "--output-format", "json"], cwd: wake.cwd, env: environment, input: prompt, timeoutMs };
}

/** The reply a finished turn leaves for the Room, or null when it chose to say nothing. */
export function replyFrom(said: string | null, limitBytes: number): string | null {
  const text = said?.trim() ?? "";
  if (text === "" || text === NO_REPLY) return null;
  const bytes = Buffer.from(text, "utf8");
  const mark = " […]";
  return bytes.length <= limitBytes ? text : `${bytes.subarray(0, limitBytes - Buffer.byteLength(mark)).toString("utf8").replace(/\uFFFD+$/, "")}${mark}`;
}

/** How the turn went, read off the harness's own JSON: whether it finished, and its last words. */
export function turnSummary(driver: WakeDriver, stdout: string): { ok: boolean; said: string | null } {
  let said: string | null = null;
  let finished = false;
  let failed = false;
  const lines = driver === "claude-code" ? [stdout.trim(), ...stdout.split("\n")] : stdout.split("\n");
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (driver === "codex") {
      const item = (event.item ?? null) as Record<string, unknown> | null;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") said = item.text;
      if (event.type === "turn.completed") finished = true;
      if (event.type === "turn.failed" || event.type === "error") failed = true;
    } else if (event.type === "result") {
      finished = true;
      if (typeof event.result === "string") said = event.result;
      if (event.is_error === true) failed = true;
      break;
    }
  }
  return { ok: finished && !failed, said };
}

/** A turn's output is kept for its last words and the log, not as a transcript. */
const OUTPUT_KEPT = 256 * 1024;

/** How long a turn's output may stay open after the harness itself has exited. */
const EXIT_GRACE_MS = 2_000;

export const runTurn: TurnRunner = (spec) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a turn stopped for running too long is stopped with everything it
      // started: killing the harness alone leaves its children holding the output open.
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ exitCode: 127, stdout, stderr: String(error), timedOut });
      return;
    }
    const signalAll = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };
    const limit = setTimeout(() => {
      timedOut = true;
      signalAll("SIGTERM");
      setTimeout(() => signalAll("SIGKILL"), 5_000).unref();
    }, spec.timeoutMs);
    const finish = (exitCode: number, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      if (grace !== undefined) clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode, stdout, stderr: `${stderr}${extra}`, timedOut });
    };
    child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-OUTPUT_KEPT)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-OUTPUT_KEPT)));
    child.once("error", (error) => finish(127, String(error)));
    // The turn is over when the harness exits. Something it left running in the background can keep
    // the output open for as long as it lives, so that is waited for only a moment.
    child.once("exit", (code) => {
      grace = setTimeout(() => finish(code ?? 1), EXIT_GRACE_MS);
    });
    child.once("close", (code) => finish(code ?? 1));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(spec.input);
  });

/**
 * Starts `sharednet serve` in the background, out of the joining session's process group so it
 * outlives the session's command, writing to `logFile`. The pid, or null when it did not start.
 */
export function startWakeService(input: { env: Environment; logFile: string; entry: string; execPath: string; execArgv: readonly string[] }): number | null {
  mkdirSync(dirname(input.logFile), { recursive: true, mode: 0o700 });
  const log = openSync(input.logFile, "a", 0o600);
  try {
    const child = spawn(input.execPath, [...input.execArgv, input.entry, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: harnessFreeEnv(input.env) as NodeJS.ProcessEnv,
      cwd: homedir(),
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    closeSync(log);
  }
}
