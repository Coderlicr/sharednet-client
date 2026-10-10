import { spawnSync } from "node:child_process";

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
export function claudeResume(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec {
  return { command: wake.command, args: ["-p", "--resume", wake.session!, "--output-format", "json"], cwd: wake.cwd, env: deliveryEnv(env, memberId), input: prompt, timeoutMs };
}

/** How the turn went, read off `--output-format json`: whether it finished, and its result. */
export function claudeSummary(stdout: string): { ok: boolean; said: string | null } {
  for (const line of [stdout.trim(), ...stdout.split("\n")]) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
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
    const outcome = await context.run(claudeResume(wake, input.prompt, context.env, input.memberId, context.timeoutMs));
    const summary = claudeSummary(outcome.stdout);
    if (summary.ok && outcome.exitCode === 0) return { kind: "replied", reply: summary.said };
    return failedTurn("claude", summary.said, outcome, context.timeoutMs);
  },
  check: (wake, env, run) => checkProgram(wake, "claude", env, run),
};
