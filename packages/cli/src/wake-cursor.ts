import { basename } from "node:path";

import {
  checkProgram,
  deliveryEnv,
  failedTurn,
  type Delivery,
  type DeliveryContext,
  type Environment,
  type SeatWake,
  type TurnSpec,
  type WakeInput,
  type WakePlugin,
} from "./wake-driver.ts";

/**
 * The `cursor` wake plugin (docs/wake-plugins.md): a chat of the Cursor Agent CLI (`agent`, also
 * installed as `cursor-agent`).
 *
 * The seat's chat is resumed with `agent -p --resume <chat id> --output-format json`, and the result is
 * the reply. That is the documented primitive (https://cursor.com/docs/cli/reference/parameters.md and
 * /cli/reference/output-format.md): print mode, `--resume [chatId]`, and one `{"type":"result",
 * "is_error":false,"result":…,"session_id":…}` object on success; on failure a non-zero exit, a message
 * on stderr and no JSON. It needs the CLI signed in (`agent login`) or CURSOR_API_KEY in serve's environment.
 *
 * Not checked against a real Cursor CLI yet (none was installed when this was written), so the following
 * are read from the docs, not observed:
 * - The prompt goes as the last argument, because the docs show no prompt on standard input. It is cut
 *   to fit one argument (a Linux argument is at most 128 KiB).
 * - Nothing is captured at `join`. CURSOR_TRACE_ID, the only id the Cursor markers carry, belongs to the
 *   Cursor editor, not to a CLI chat; the chat id comes from `sharednet wake set cursor --resume <id>`
 *   (`agent create-chat` prints a new one, `agent ls` lists them).
 * - No `--force`: the person's own permissions apply. A launcher script that adds the flags they choose
 *   (`--force`, `--sandbox`, `--model`) stands in for `agent` through `--command`, as for Codex.
 * - Whether a chat open in a Cursor terminal refuses a second writer is not documented, so there is no
 *   `handed`/`left` outcome here: a resumed turn is the only route.
 */

/** A single argument may be at most 128 KiB on Linux; the prompt is kept well inside it. */
const PROMPT_BYTES = 100 * 1024;
const CUT = "\n[… earlier lines cut; `sharednet read` has them]\n";

/** The prompt, cut from its middle when it would not fit one argument: the first line and the newest lines stay. */
export function fitPrompt(prompt: string, limit: number = PROMPT_BYTES): string {
  if (Buffer.byteLength(prompt) <= limit) return prompt;
  const newline = prompt.indexOf("\n");
  const head = newline === -1 ? "" : prompt.slice(0, newline);
  const room = limit - Buffer.byteLength(head) - Buffer.byteLength(CUT);
  const tail = Buffer.from(prompt).subarray(Buffer.byteLength(prompt) - Math.max(room, 0)).toString("utf8").replace(/^�+/, "");
  return `${head}${CUT}${tail}`;
}

/** One resumed turn of the seat's chat, with the prompt as the last argument. */
export function cursorResume(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec {
  return {
    command: wake.command,
    args: ["-p", "--resume", wake.session!, "--output-format", "json", "--trust", fitPrompt(prompt)],
    cwd: wake.cwd,
    env: deliveryEnv(env, memberId),
    input: "",
    timeoutMs,
  };
}

/** How the turn went, read off `--output-format json`: whether it finished, and its result. */
export function cursorSummary(stdout: string): { ok: boolean; said: string | null } {
  for (const line of [stdout.trim(), ...stdout.split("\n")]) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "result") continue;
    return { ok: event.is_error !== true && event.subtype !== "error", said: typeof event.result === "string" ? event.result : null };
  }
  return { ok: false, said: null };
}

/** The name `--version` is asked of: the CLI's own, unless the command is a launcher standing in for it. */
function harnessName(wake: SeatWake): string {
  return basename(wake.command) === "cursor-agent" ? "cursor-agent" : "agent";
}

export const cursorPlugin: WakePlugin = {
  driver: "cursor",
  label: "Cursor",
  capture: () => null,
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    const outcome = await context.run(cursorResume(wake, input.prompt, context.env, input.memberId, context.timeoutMs));
    const summary = cursorSummary(outcome.stdout);
    if (summary.ok && outcome.exitCode === 0 && !outcome.timedOut) return { kind: "replied", reply: summary.said };
    return failedTurn("cursor", summary.said, outcome, context.timeoutMs);
  },
  check: (wake, env, run) => checkProgram(wake, harnessName(wake), env, run),
};
