import { basename } from "node:path";

import {
  CHECK_CALL_MS,
  CHECK_PROMPT,
  CHECK_SIGNED_IN_MS,
  checkFromSteps,
  checkProgram,
  deliveryEnv,
  failedTurn,
  harnessFreeEnv,
  inThrowawayDirectory,
  isLauncher,
  lastWords,
  networkHint,
  skipRest,
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
 * The `cursor` wake plugin (docs/wake-plugins.md): a chat of the Cursor Agent CLI (`agent`, also
 * installed as `cursor-agent`).
 *
 * The seat's chat is resumed with `agent -p --resume <chat id> --output-format json`, and the result is
 * the reply. That is the documented primitive (https://cursor.com/docs/cli/reference/parameters.md and
 * /cli/reference/output-format.md): print mode, `--resume [chatId]`, and one `{"type":"result",
 * "is_error":false,"result":…,"session_id":…}` object on success; on failure a non-zero exit, a message
 * on stderr and no JSON. It needs the CLI signed in (`agent login`) or CURSOR_API_KEY in serve's environment.
 *
 * Argument parsing was checked by a reviewer against the official CLI 2026.10.14-0f9edde in an unsigned
 * HOME (`agent` and `cursor-agent` accept this argv; a failed turn is non-zero with a message on stderr).
 * No signed-in turn has run yet, so the following are read from the docs, not observed:
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

/**
 * The variables Cursor sets for the commands its agent runs, and for its sandbox, workers and hooks.
 * Handed on, they would make the resumed CLI believe it runs inside the session that woke it. What
 * signs it in (`CURSOR_API_KEY`, `CURSOR_SERVICE_ACCOUNT_API_KEY`, `CURSOR_CONFIG_DIR`,
 * `AGENT_CLI_CREDENTIAL_STORE`) is kept. Names: CURSOR_AGENT and CURSOR_TRACE_ID are what runtime
 * detection reads; the others are named in https://cursor.com/docs/cli/changelog.md (`CURSOR_WAKE`),
 * /cloud-agent/api/endpoints.md (`CURSOR_AGENT_WORKER_ID`, `CURSOR_SANDBOX*`).
 */
const CURSOR_HOST_KEYS = new Set(["CURSOR_AGENT", "CURSOR_TRACE_ID", "CURSOR_AGENT_WORKER_ID", "CURSOR_WAKE"]);

export function cursorFreeEnv(env: Environment): Record<string, string> {
  const kept = harnessFreeEnv(env);
  for (const key of Object.keys(kept)) {
    if (CURSOR_HOST_KEYS.has(key) || key.startsWith("CURSOR_SANDBOX")) delete kept[key];
  }
  return kept;
}

/** One resumed turn of the seat's chat, with the prompt as the last argument. */
export function cursorResume(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec {
  return {
    command: wake.command,
    args: ["-p", "--resume", wake.session!, "--output-format", "json", "--trust", fitPrompt(prompt)],
    cwd: wake.cwd,
    env: deliveryEnv(cursorFreeEnv(env), memberId),
    input: "",
    timeoutMs,
  };
}

/**
 * How the turn went, read off `--output-format json`, which documents exactly one success shape:
 * `{"type":"result","subtype":"success","is_error":false,"result":"<text>",...}`
 * (https://cursor.com/docs/cli/reference/output-format.md). Anything else is a failure, and `said`
 * then holds a message for the Room: the CLI's own words when it reported an error, else what was wrong
 * with the output. A result that merely lacks `is_error: true` is not a success: serve would
 * acknowledge the wake and post nothing.
 */
export function cursorSummary(stdout: string): { ok: boolean; said: string | null; reported: boolean } {
  let result: Record<string, unknown> | null = null;
  for (const line of [stdout.trim(), ...stdout.split("\n")]) {
    try {
      const event = JSON.parse(line) as unknown;
      if (event && typeof event === "object" && !Array.isArray(event) && (event as Record<string, unknown>).type === "result") result = event as Record<string, unknown>;
    } catch {
      // not a JSON line
    }
  }
  if (result === null) return { ok: false, said: stdout.trim() === "" ? "the Cursor CLI printed nothing" : "the Cursor CLI printed no result object", reported: false };
  if (result.subtype === "success" && result.is_error === false && typeof result.result === "string") return { ok: true, said: result.result, reported: true };
  if (result.is_error === true && typeof result.result === "string" && result.result.trim() !== "") return { ok: false, said: result.result, reported: true };
  const shape = `subtype ${JSON.stringify(result.subtype ?? null)}, is_error ${JSON.stringify(result.is_error ?? null)}, result ${typeof result.result}`;
  return { ok: false, said: `the Cursor CLI printed a result that is not the documented success object (${shape})`, reported: true };
}

/** The name `--version` is asked of: the CLI's own, unless the command is a launcher standing in for it. */
function harnessName(program: string): string {
  return basename(program) === "cursor-agent" ? "cursor-agent" : "agent";
}

/** A chat id as `agent create-chat` and the result's `session_id` show it: a UUID. */
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The throwaway turn's arguments: ask mode (read-only), a trusted empty directory, one short answer.
 * Cursor documents no flag that saves no chat (it has no `--no-session-persistence`), so this turn
 * leaves one chat entry behind in the throwaway directory's workspace; that is said in the step.
 */
export const CURSOR_CHECK_ARGS: readonly string[] = ["-p", "--mode", "ask", "--output-format", "json", "--trust"];

/**
 * Whether `agent status --format json` says the CLI is signed in. Its output shape is not documented
 * (https://cursor.com/docs/cli/reference/authentication.md only lists what it shows), so a boolean
 * under any of the usual names decides, then the words; anything else is "unknown".
 */
export function cursorSignedIn(stdout: string): "yes" | "no" | "unknown" {
  try {
    const status = JSON.parse(stdout.trim()) as unknown;
    if (status && typeof status === "object" && !Array.isArray(status)) {
      for (const key of ["isAuthenticated", "authenticated", "loggedIn", "isLoggedIn", "signedIn", "isSignedIn"]) {
        const value = (status as Record<string, unknown>)[key];
        if (typeof value === "boolean") return value ? "yes" : "no";
      }
    }
  } catch {
    // not JSON: read the words
  }
  if (/not (?:logged in|authenticated|signed in)|unauthenticated|logged out|signed out/i.test(stdout)) return "no";
  if (/logged in|authenticated|signed in/i.test(stdout)) return "yes";
  return "unknown";
}

/**
 * The cursor check (docs/wake-plugins.md), in the staged model of `claude-code` and `codex`:
 * `--version`; `agent status --format json` for the sign-in; the chat id; and, when asked, a
 * throwaway ask-mode turn that resumes nothing. Every step asks the wake's own command, so a launcher
 * is what is checked, and is only looked at for the steps it may not accept.
 *
 * The session step cannot look for the chat: Cursor's docs say where the config is (`~/.cursor`,
 * `CURSOR_CONFIG_DIR`) but not where chats are kept, and `agent ls` is an interactive picker. It
 * checks the id's shape and says the rest is proven by the delivery.
 */
export async function checkCursor(wake: SeatWake, env: Environment, run: TurnRunner, options: CheckOptions = { call: false }): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const started = await checkProgram(wake, harnessName(wake.command), env, run);
  steps.push({ step: "program", status: started.ok ? "ok" : "failed", message: started.message });
  const program = wakeProgram(wake, env);
  if (!started.ok || program === null) return skipRest(steps, options, "the program did not start");
  const launcher = isLauncher(program, harnessName(program));
  const runEnv = cursorFreeEnv(env);

  if (launcher) {
    steps.push({ step: "signed_in", status: "skipped", message: `${program} is a launcher, written for the turn a delivery runs; \`status\` is not asked of it` });
  } else {
    const status = await run({ command: program, args: ["status", "--format", "json"], cwd: wake.cwd, env: runEnv, input: "", timeoutMs: CHECK_SIGNED_IN_MS });
    const signedIn = status.timedOut || status.exitCode !== 0 ? "unknown" : cursorSignedIn(status.stdout);
    if (signedIn === "yes") {
      steps.push({ step: "signed_in", status: "ok", message: "agent status: signed in" });
    } else {
      const key = env.CURSOR_API_KEY?.trim() ? "CURSOR_API_KEY is set in this environment, so the CLI may sign in with it regardless" : "CURSOR_API_KEY is not set in this environment";
      const why = status.timedOut
        ? `agent status did not answer within ${CHECK_SIGNED_IN_MS / 1000}s (a busy machine, or a hung program)`
        : status.exitCode !== 0
          ? `agent status exited ${status.exitCode}${lastWords(status) ? `: ${lastWords(status)}` : ""}`
          : signedIn === "no"
            ? "agent status: not signed in. Run `agent login` as the user serve runs as, or put CURSOR_API_KEY in serve's environment"
            : `agent status answered, but its words are not recognised as signed in or out: ${lastWords(status) || "(empty)"}`;
      steps.push({ step: "signed_in", status: "warning", message: `${why}; ${key}` });
    }
  }

  steps.push(
    wake.session && CHAT_ID.test(wake.session)
      ? { step: "session", status: "skipped", message: `${wake.session} has the shape of a Cursor chat id; Cursor's docs do not say where chats are stored, so whether it exists is proven only by a delivery (\`agent --resume\` exits non-zero for a chat it cannot find)` }
      : { step: "session", status: "warning", message: `${wake.session ?? "(none)"} does not look like a Cursor chat id (a UUID, as \`agent create-chat\` prints); \`agent --resume\` would fail. Set it again with \`sharednet wake set cursor --resume <chat id>\`` },
  );

  if (options.call) {
    const outcome = await inThrowawayDirectory((cwd) => run({ command: program, args: [...CURSOR_CHECK_ARGS, CHECK_PROMPT], cwd, env: runEnv, input: "", timeoutMs: CHECK_CALL_MS }));
    const summary = cursorSummary(outcome.stdout);
    const answer = summary.ok ? (summary.said?.trim() ?? "") : "";
    const through = launcher ? ` through the launcher ${program}` : "";
    if (!outcome.timedOut && outcome.exitCode === 0 && summary.ok && answer !== "") {
      steps.push({ step: "call", status: "ok", message: `a throwaway \`agent -p --mode ask\` turn${through} (resumes nothing; Cursor has no flag to save no chat, so it leaves one) answered "${answer.slice(0, 60)}"` });
    } else {
      const said = outcome.timedOut ? `no answer within ${CHECK_CALL_MS / 1000}s` : (!summary.ok && summary.reported ? summary.said ?? "" : "") || lastWords(outcome) || (!summary.ok && outcome.exitCode === 0 ? summary.said ?? "" : "") || `agent -p exited ${outcome.exitCode}`;
      const text = said.slice(0, 300);
      steps.push(
        launcher
          ? { step: "call", status: "warning", message: `a throwaway turn${through} did not answer, which is not conclusive, since a launcher may accept only the resume it was written for: ${text}${networkHint(text, env)}` }
          : { step: "call", status: "failed", message: `a throwaway \`agent -p\` turn failed: ${text}${networkHint(text, env)}` },
      );
    }
  }
  return checkFromSteps(steps);
}

export const cursorPlugin: WakePlugin = {
  driver: "cursor",
  label: "Cursor",
  capture: () => null,
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    const outcome = await context.run(cursorResume(wake, input.prompt, context.env, input.memberId, context.timeoutMs));
    const summary = cursorSummary(outcome.stdout);
    if (summary.ok && outcome.exitCode === 0 && !outcome.timedOut) return { kind: "replied", reply: summary.said };
    // A non-zero exit prints no JSON (the docs say), so its words are the exit; an exit 0 without the success object says what was wrong.
    const said = !summary.ok && (summary.reported || outcome.exitCode === 0) ? summary.said : null;
    return failedTurn("cursor", said, outcome, context.timeoutMs);
  },
  check: checkCursor,
};
