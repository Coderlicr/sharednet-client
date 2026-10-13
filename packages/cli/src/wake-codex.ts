import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { detectRuntime } from "./runtime-detection.ts";
import {
  checkProgram,
  deliveryEnv,
  failedTurn,
  onPath,
  type Delivery,
  type DeliveryContext,
  type Environment,
  type SeatWake,
  type TurnSpec,
  type WakeInput,
  type WakePlugin,
} from "./wake-driver.ts";

/**
 * The `codex` wake plugin (docs/wake-plugins.md).
 *
 * Idle, the seat's thread is resumed with `codex exec resume`, and its last agent message is the
 * reply. Open in a chat, Codex refuses a second writer ("active writer"); the wake is then put in the
 * thread's queue with `codex queue`, which the open chat runs after its current turn and answers in the
 * Room itself. Verified on Codex 0.162.0: the queue is durable, but Codex removes a message once a turn
 * takes it. Serve separately records the hand-over because that turn may still be interrupted.
 *
 * Inside a session CODEX_SESSION_ID is the thread id that `exec resume` and `queue` take.
 */

/** How Codex says the thread is open elsewhere. */
const ACTIVE_WRITER = /already has an active writer|thread-store conflict/i;
/** Queueing stores a message and returns; it never runs a turn. */
const QUEUE_LIMIT_MS = 30_000;
const RETRY_MS = 10_000;

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

function codexEnv(wake: SeatWake, env: Environment, memberId: string): Record<string, string> {
  return deliveryEnv(env, memberId, wake.codex_home ? { CODEX_HOME: wake.codex_home } : {});
}

/** One resumed turn of the seat's thread, asking nothing of a person. */
export function codexResume(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec {
  // The person's own sandbox, when they chose one. Otherwise `exec resume` would run read-only, which
  // is less than the session had: the default an interactive Codex session works in is
  // workspace-write, so the woken turn gets that.
  const home = wake.codex_home ?? env.CODEX_HOME?.trim() ?? join(env.HOME || homedir(), ".codex");
  return {
    command: wake.command,
    args: ["exec", "resume", "--json", "--skip-git-repo-check", ...(codexSandboxChosen(home) ? [] : ["-c", 'sandbox_mode="workspace-write"']), wake.session!, "-"],
    cwd: wake.cwd,
    env: codexEnv(wake, env, memberId),
    input: prompt,
    timeoutMs,
  };
}

/**
 * The wake put in the open thread's queue. A launcher script standing in for `codex` is written for
 * `exec resume` alone, and queueing runs nothing that needs its permissions, so the queue goes to the
 * real `codex`: the command itself when it is one, else the one on PATH.
 */
export function codexQueue(wake: SeatWake, message: string, env: Environment, memberId: string): TurnSpec {
  const codex = basename(wake.command) === "codex" ? wake.command : (onPath("codex", env) ?? "codex");
  return { command: codex, args: ["queue", "--thread", wake.session!, "--message", message], cwd: wake.cwd, env: codexEnv(wake, env, memberId), input: "", timeoutMs: QUEUE_LIMIT_MS };
}

/** How the turn went, read off Codex's --json stream: whether it finished, and its last words. */
export function codexSummary(stdout: string): { ok: boolean; said: string | null } {
  let said: string | null = null;
  let finished = false;
  let failed = false;
  for (const line of stdout.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = (event.item ?? null) as Record<string, unknown> | null;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") said = item.text;
    if (event.type === "turn.completed") finished = true;
    if (event.type === "turn.failed" || event.type === "error") failed = true;
  }
  return { ok: finished && !failed, said };
}

export const codexPlugin: WakePlugin = {
  driver: "codex",
  label: "Codex",
  capture(env, cwd) {
    const detected = detectRuntime(env);
    if (detected.kind !== "codex" || detected.anchor === null) return null;
    const home = env.CODEX_HOME?.trim();
    return { driver: "codex", session: detected.anchor, cwd, command: onPath("codex", env) ?? "codex", ...(home ? { codex_home: home } : {}) };
  },
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    const outcome = await context.run(codexResume(wake, input.prompt, context.env, input.memberId, context.timeoutMs));
    const summary = codexSummary(outcome.stdout);
    if (summary.ok && outcome.exitCode === 0) return { kind: "replied", reply: summary.said };
    if (!outcome.timedOut && ACTIVE_WRITER.test(`${outcome.stderr}\n${outcome.stdout}`)) {
      const queued = await context.run(codexQueue(wake, input.livePrompt, context.env, input.memberId));
      if (queued.exitCode === 0 && !queued.timedOut) return { kind: "handed", note: `queued into its open Codex chat (thread ${wake.session})` };
      return {
        kind: "busy",
        why: `its Codex chat is open, and \`codex queue\` ${queued.timedOut ? "did not answer" : `exited ${queued.exitCode}`}${queued.stderr.trim() ? ` (${queued.stderr.trim().split("\n").slice(-1)[0]!.slice(0, 200)})` : ""}`,
        retryMs: RETRY_MS,
      };
    }
    return failedTurn("codex", summary.said, outcome, context.timeoutMs);
  },
  check: (wake, env, run) => checkProgram(wake, "codex", env, run),
};
