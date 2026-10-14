import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * The `claude-code` wake plugin (docs/wake-plugins.md).
 *
 * Closed, the seat's session is resumed with `claude -p --resume`, and the result is the reply. That
 * needs the `claude` command signed in. Open in a chat a person is in, it is not: `claude -p --resume`
 * appends to the same transcript (checked: one .jsonl, written by both), the open chat never sees the
 * turn, and the two diverge. Claude Code has no queue to reach an open chat, so the chat listens for
 * itself — a background `sharednet wait --on mention`, which Claude Code calls it back from — and the
 * plugin leaves the seat's lines to it. Once the chat has closed, they are resumed as usual.
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID, which `claude -p --resume` takes; an attended chat has
 * CLAUDE_CODE_SESSION_ATTENDED=1 and its process in CLAUDE_PID, a headless `claude -p` attended 0.
 */

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

/** One resumed turn of the seat's session, with the prompt on standard input. */
export function claudeResume(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number, extraEnv: Record<string, string> = {}): TurnSpec {
  return { command: wake.command, args: ["-p", "--resume", wake.session!, "--output-format", "json"], cwd: wake.cwd, env: deliveryEnv(env, memberId, extraEnv), input: prompt, timeoutMs };
}

/**
 * One resumed print-mode turn and how it went: the part of a wake that every harness with Claude Code's
 * headless shape shares (`<program> -p --resume <session> --output-format json`, a `result` object back).
 * The program is the wake's `command` and `extraEnv` is where a harness keeps its sessions (CodeBuddy's
 * config directory), so a harness like that is this function with another program and session path
 * (wake-codebuddy.ts), and a fix to the turn or its parsing is made once, here.
 */
export async function deliverResumedPrint(label: string, wake: SeatWake, input: WakeInput, context: DeliveryContext, extraEnv: Record<string, string> = {}): Promise<Delivery> {
  const outcome = await context.run(claudeResume(wake, input.prompt, context.env, input.memberId, context.timeoutMs, extraEnv));
  const summary = claudeSummary(outcome.stdout);
  if (summary.ok && outcome.exitCode === 0) return { kind: "replied", reply: summary.said };
  return failedTurn(label, summary.said, outcome, context.timeoutMs);
}

/**
 * How the turn went, read off `--output-format json`: whether it finished, and its result. Claude Code
 * prints one result object. CodeBuddy 2.106.4 (WorkBuddy 5.2.5) prints a pretty-printed array of the
 * turn's events whose last `result` element is the same object (seen live, 2026-10-14), so a whole
 * output that is an array is read by that last result.
 */
export function claudeSummary(stdout: string): { ok: boolean; said: string | null } {
  for (const line of [stdout.trim(), ...stdout.split("\n")]) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      event = Array.isArray(parsed) ? (([...(parsed as unknown[])].reverse().find((item) => (item as Record<string, unknown> | null)?.type === "result") ?? {}) as Record<string, unknown>) : (parsed as Record<string, unknown>);
    } catch {
      continue;
    }
    if (event.type !== "result") continue;
    return { ok: event.is_error !== true, said: typeof event.result === "string" ? event.result : null };
  }
  return { ok: false, said: null };
}

/** The command an open chat listens with. */
export function listenCommand(memberId: string): string {
  return `sharednet wait --on mention --as ${memberId} --json`;
}

/** A session id as Claude Code writes it: one file name, never a path. */
const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where the session's transcript is, or null. Claude Code files a transcript under the slug of the
 * directory it was started in, which need not be the seat's (a session joined from one directory and
 * resumed from another keeps its first one), so every project directory is looked in. `projects` is
 * where `claude auth status` says they are, else CLAUDE_CONFIG_DIR's or ~/.claude's.
 */
export function claudeTranscript(session: string, env: Environment, projects?: string): string | null {
  if (!SESSION_FILE.test(session)) return null;
  const root = projects ?? join(env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME || homedir(), ".claude"), "projects");
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const candidate = join(root, slug, `${session}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The throwaway turn's arguments. It saves no session, and runs none of the person's hooks, MCP
 * servers or tools: `--no-session-persistence` only skips the transcript, and a global SessionStart
 * hook would otherwise run (and write wherever it writes) on every check. Auto-memory is off too,
 * which otherwise leaves an empty `projects/<temp dir>/memory` behind each time. Settings are
 * otherwise kept, so their environment and sign-in still apply. All of this exists on Claude Code 2.1.296.
 */
export const CLAUDE_CHECK_ARGS: readonly string[] = [
  "-p",
  "--no-session-persistence",
  "--output-format",
  "json",
  "--settings",
  JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
  "--strict-mcp-config",
  "--tools",
  "",
];

/**
 * The claude-code check (docs/wake-plugins.md). `--version` alone passed on a machine whose
 * `claude -p` answered every resume with "Not logged in" (the desktop chat signs in on its own), so
 * the check also asks `claude auth status`, looks for the transcript a resume needs, and — when asked
 * — runs a throwaway turn that resumes nothing and saves no session. Every step asks the wake's own
 * command: a launcher is what a delivery runs, so it is what is checked.
 */
export async function checkClaude(wake: SeatWake, env: Environment, run: TurnRunner, options: CheckOptions = { call: false }): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const started = await checkProgram(wake, "claude", env, run);
  steps.push({ step: "program", status: started.ok ? "ok" : "failed", message: started.message });
  const program = wakeProgram(wake, env);
  if (!started.ok || program === null) return skipRest(steps, options, "the program did not start");
  const launcher = isLauncher(program, "claude");
  const runEnv = harnessFreeEnv(env);

  // A sign-in status that says no is a warning, not a verdict: the turn itself decides.
  let reported: Record<string, unknown> | null = null;
  if (launcher) {
    steps.push({ step: "signed_in", status: "skipped", message: `${program} is a launcher, written for the turn a delivery runs; \`auth status\` is not asked of it` });
  } else {
    const status = await run({ command: program, args: ["auth", "status", "--json"], cwd: wake.cwd, env: runEnv, input: "", timeoutMs: CHECK_SIGNED_IN_MS });
    try {
      reported = JSON.parse(status.stdout) as Record<string, unknown>;
    } catch {
      reported = null;
    }
    if (!status.timedOut && status.exitCode === 0 && reported?.loggedIn === true) {
      steps.push({ step: "signed_in", status: "ok", message: `claude auth status: signed in${typeof reported.authMethod === "string" ? ` (${reported.authMethod})` : ""}` });
    } else {
      // Claude Code finds a macOS keychain sign-in by USER; without it a signed-in machine reads as signed out.
      const why = status.timedOut
        ? `claude auth status did not answer within ${CHECK_SIGNED_IN_MS / 1000}s (a busy machine, or a hung program)`
        : reported?.loggedIn === false
          ? !env.USER?.trim()
            ? "claude auth status: not signed in, but USER is not set in this environment, and Claude Code finds its keychain sign-in by USER. Set USER where serve runs; if it still says this, run `claude auth login`"
            : "claude auth status: not signed in. Run `claude auth login` as the user serve runs as, unless this program signs in another way"
          : `claude auth status exited ${status.exitCode}${lastWords(status) ? `: ${lastWords(status)}` : ""}`;
      steps.push({ step: "signed_in", status: "warning", message: why });
    }
  }

  const projects = typeof reported?.projectsDirectory === "string" && reported.projectsDirectory ? reported.projectsDirectory : undefined;
  const transcript = claudeTranscript(wake.session!, env, projects);
  steps.push(
    transcript
      ? { step: "session", status: "ok", message: `${wake.session} has its transcript at ${transcript}` }
      : {
          step: "session",
          status: "failed",
          message: `no transcript for session ${wake.session} under ${projects ?? "the Claude Code projects directory"}, so \`claude --resume\` has nothing to resume. Set the session again from inside it (\`sharednet wake set claude-code\`) or give \`--resume <session id>\``,
        },
  );

  if (options.call) {
    const outcome = await inThrowawayDirectory((cwd) => run({ command: program, args: [...CLAUDE_CHECK_ARGS], cwd, env: runEnv, input: CHECK_PROMPT, timeoutMs: CHECK_CALL_MS }));
    const summary = claudeSummary(outcome.stdout);
    const answer = summary.said?.trim() ?? "";
    const through = launcher ? `through the launcher ${program}` : "";
    if (!outcome.timedOut && outcome.exitCode === 0 && summary.ok && answer !== "") {
      steps.push({ step: "call", status: "ok", message: `a throwaway \`claude -p\` turn${through ? ` ${through}` : ""} (no session saved, no hooks, MCP servers or tools) answered "${answer.slice(0, 60)}"` });
    } else {
      const said = outcome.timedOut ? `no answer within ${CHECK_CALL_MS / 1000}s` : (answer || lastWords(outcome) || `claude -p exited ${outcome.exitCode}`).slice(0, 300);
      steps.push(
        launcher
          ? { step: "call", status: "warning", message: `a throwaway turn ${through} did not answer, which is not conclusive, since a launcher may accept only the resume it was written for: ${said}${networkHint(said, env)}` }
          : { step: "call", status: "failed", message: `a throwaway \`claude -p\` turn failed: ${said}${networkHint(said, env)}` },
      );
    }
  }
  return checkFromSteps(steps);
}

export const claudePlugin: WakePlugin = {
  driver: "claude-code",
  label: "Claude Code",
  capture(env, cwd) {
    const detected = detectRuntime(env);
    if (detected.kind !== "claude-code" || detected.anchor === null) return null;
    const pid = env.CLAUDE_CODE_SESSION_ATTENDED?.trim() === "1" ? Number(env.CLAUDE_PID?.trim()) : NaN;
    return {
      driver: "claude-code",
      session: detected.anchor,
      cwd,
      command: onPath("claude", env) ?? "claude",
      ...(Number.isSafeInteger(pid) && pid > 0 ? { live_pid: pid } : {}),
    };
  },
  listen(wake, memberId) {
    return wake.live_pid === undefined ? null : listenCommand(memberId);
  },
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    if (wake.live_pid !== undefined && context.chatOpen(wake.live_pid)) {
      return { kind: "left", note: `its Claude Code chat is open (pid ${wake.live_pid})` };
    }
    return deliverResumedPrint("claude", wake, input, context);
  },
  check: checkClaude,
};
