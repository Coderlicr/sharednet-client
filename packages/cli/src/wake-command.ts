import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

import { deliveryEnv, failedTurn, onPath, type Delivery, type DeliveryContext, type SeatWake, type WakeInput, type WakePlugin } from "./wake-driver.ts";

/**
 * The `command` wake plugin (docs/wake-plugins.md): any harness or bot without a plugin of its own.
 *
 * The program gets the wake as JSON on standard input — the same shape `serve --run` hands its command,
 * plus the prompt a turn would be given — and says how it went by its exit code:
 * 0 replied (standard output is the reply; empty or `(no reply)` posts nothing), 75 busy (try again
 * later), 76 handed (passed on to something that answers in the Room itself), anything else failed.
 * It is never captured by `join`; `sharednet wake set command --command <path>` sets it.
 */

/** EX_TEMPFAIL: nothing was lost, try again. */
export const EXIT_BUSY = 75;
/** Passed on to something that answers in the Room itself. */
export const EXIT_HANDED = 76;
const RETRY_MS = 10_000;

export const commandPlugin: WakePlugin = {
  driver: "command",
  label: "command",
  capture: () => null,
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    const wakeJson = {
      room_id: input.roomId,
      member_id: input.memberId,
      seat: input.seat,
      trigger: input.trigger ?? "mention",
      ...(input.sourceMessageId ? { source_message_id: input.sourceMessageId } : {}),
      ...(input.wakeId ? { wake_id: input.wakeId } : {}),
      from: input.from,
      through: input.through,
      messages: input.messages,
      prompt: input.prompt,
    };
    const outcome = await context.run({
      command: wake.command,
      args: [],
      cwd: wake.cwd,
      env: deliveryEnv(context.env, input.memberId, { SHAREDNET_ROOM_ID: input.roomId }),
      input: `${JSON.stringify(wakeJson)}\n`,
      timeoutMs: context.timeoutMs,
    });
    if (!outcome.timedOut && outcome.exitCode === 0) return { kind: "replied", reply: outcome.stdout.trim() || null };
    if (!outcome.timedOut && outcome.exitCode === EXIT_BUSY) return { kind: "busy", why: `${wake.command} said it is busy (exit ${EXIT_BUSY})`, retryMs: RETRY_MS };
    if (!outcome.timedOut && outcome.exitCode === EXIT_HANDED) return { kind: "handed", note: `${wake.command} passed it on` };
    return failedTurn(wake.command, null, outcome, context.timeoutMs);
  },
  async check(wake, env) {
    // An adapter reads a wake from standard input; starting it to look would hand it an empty one.
    const program = isAbsolute(wake.command) ? wake.command : onPath(wake.command, env);
    if (program === null) return { ok: false, message: `${wake.command} is not on PATH` };
    try {
      accessSync(program, constants.X_OK);
      return { ok: true, message: `${program} (an adapter; not started)` };
    } catch {
      return { ok: false, message: `${program} is not executable` };
    }
  },
};
