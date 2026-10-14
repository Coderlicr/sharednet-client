import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { detectRuntime } from "./runtime-detection.ts";
import {
  CHECK_CALL_MS,
  CHECK_PROMPT,
  CHECK_SIGNED_IN_MS,
  checkFromSteps,
  skipRest,
  checkProgram,
  deliveryEnv,
  failedTurn,
  harnessFreeEnv,
  isLauncher,
  inThrowawayDirectory,
  lastWords,
  networkHint,
  onPath,
  wakeProgram,
  type CheckOptions,
  type CheckResult,
  type CheckStep,
  type Delivery,
  type DeliveryContext,
  type Environment,
  type SeatWake,
  type TurnRunner,
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

/**
 * Codex's own words for why a turn failed, read off its --json stream: the last `turn.failed` or
 * `error` event. The message is often the API's JSON error, whose inner message is the readable part.
 */
export function codexError(stdout: string): string | null {
  let said: string | null = null;
  for (const line of stdout.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message =
      event.type === "turn.failed" ? (event.error as Record<string, unknown> | undefined)?.message : event.type === "error" ? event.message : undefined;
    if (typeof message !== "string") continue;
    said = message;
    try {
      const inner = (JSON.parse(message) as { error?: { message?: unknown } }).error?.message;
      if (typeof inner === "string") said = inner;
    } catch {
      // plain text already
    }
  }
  return said;
}

/** The rollout file of a thread, or null: Codex files it as sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. */
export function codexRollout(home: string, thread: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(thread)) return null;
  const suffix = `-${thread}.jsonl`;
  const walk = (directory: string, depth: number): string | null => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return join(directory, entry.name);
    }
    if (depth === 0) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(join(directory, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return walk(join(home, "sessions"), 4);
}

/** The throwaway turn's arguments: a new thread that is never written to disk, reading only. */
export const CODEX_CHECK_ARGS: readonly string[] = ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-s", "read-only", "-"];

/**
 * The codex check (docs/wake-plugins.md): `--version`, then `codex login status` and the thread's
 * rollout under the wake's CODEX_HOME, and — when asked — one `codex exec --ephemeral` turn in an
 * empty directory, which resumes nothing and saves no session. Every step asks the wake's own
 * command. `login status` speaks only for Codex's own sign-in: a custom provider authenticated by an
 * environment variable fails it and still works (Codex 0.162.0), so it only warns, and the turn decides.
 */
export async function checkCodex(wake: SeatWake, env: Environment, run: TurnRunner, options: CheckOptions = { call: false }): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const started = await checkProgram(wake, "codex", env, run);
  steps.push({ step: "program", status: started.ok ? "ok" : "failed", message: started.message });
  const program = wakeProgram(wake, env);
  if (!started.ok || program === null) return skipRest(steps, options, "the program did not start");
  const launcher = isLauncher(program, "codex");

  const home = wake.codex_home || env.CODEX_HOME?.trim() || join(env.HOME || homedir(), ".codex");
  const runEnv = { ...harnessFreeEnv(env), ...(wake.codex_home ? { CODEX_HOME: wake.codex_home } : {}) };
  if (launcher) {
    steps.push({ step: "signed_in", status: "skipped", message: `${program} is a launcher, written for the turn a delivery runs; \`login status\` is not asked of it` });
  } else {
    const status = await run({ command: program, args: ["login", "status"], cwd: wake.cwd, env: runEnv, input: "", timeoutMs: CHECK_SIGNED_IN_MS });
    const statusSaid = lastWords(status);
    steps.push(
      !status.timedOut && status.exitCode === 0
        ? // Only the kind of sign-in: with an API key, Codex prints part of the key.
          { step: "signed_in", status: "ok", message: `codex login status: signed in${/chatgpt/i.test(statusSaid) ? " with ChatGPT" : /api key/i.test(statusSaid) ? " with an API key" : ""}` }
        : {
            step: "signed_in",
            status: "warning",
            message: status.timedOut
              ? `codex login status did not answer within ${CHECK_SIGNED_IN_MS / 1000}s (a busy machine, or a hung program)`
              : `codex login status exited ${status.exitCode}${statusSaid && !/sk-/.test(statusSaid) ? `: ${statusSaid}` : ""}. If this Codex signs in with \`codex login\`, run it with CODEX_HOME=${home}; a provider authenticated by an environment variable is not seen here`,
          },
    );
  }

  const rollout = codexRollout(home, wake.session!);
  steps.push(
    rollout
      ? { step: "session", status: "ok", message: `${wake.session} has its rollout at ${rollout}` }
      : {
          step: "session",
          status: "failed",
          message: `no rollout for thread ${wake.session} under ${join(home, "sessions")}, so \`codex exec resume\` has nothing to resume. Set the thread again from inside it (\`sharednet wake set codex\`) or give \`--resume <thread id>\``,
        },
  );

  if (options.call) {
    const outcome = await inThrowawayDirectory((cwd) => run({ command: program, args: [...CODEX_CHECK_ARGS], cwd, env: runEnv, input: CHECK_PROMPT, timeoutMs: CHECK_CALL_MS }));
    const summary = codexSummary(outcome.stdout);
    const answer = summary.said?.trim() ?? "";
    const through = launcher ? `through the launcher ${program}` : "";
    if (!outcome.timedOut && outcome.exitCode === 0 && summary.ok && answer !== "") {
      steps.push({ step: "call", status: "ok", message: `a throwaway \`codex exec --ephemeral\` turn${through ? ` ${through}` : ""} answered "${answer.slice(0, 60)}"` });
    } else {
      const said = outcome.timedOut ? `no answer within ${CHECK_CALL_MS / 1000}s` : (codexError(outcome.stdout) ?? (answer || lastWords(outcome) || `codex exec exited ${outcome.exitCode}`)).slice(0, 300);
      steps.push(
        launcher
          ? { step: "call", status: "warning", message: `a throwaway turn ${through} did not answer, which is not conclusive, since a launcher may accept only the resume it was written for: ${said}${networkHint(said, env)}` }
          : { step: "call", status: "failed", message: `a throwaway \`codex exec\` turn failed: ${said}${networkHint(said, env)}` },
      );
    }
  }
  return checkFromSteps(steps);
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
  check: checkCodex,
};
