import { accessSync, constants } from "node:fs";

import { deliverResumedPrint } from "./wake-claude.ts";
import { checkProgram, onPath, type CheckResult, type Delivery, type DeliveryContext, type Environment, type SeatWake, type WakeInput, type WakePlugin } from "./wake-driver.ts";

/**
 * The `codebuddy` wake plugin (docs/wake-plugins.md): Tencent's CodeBuddy Code CLI, and WorkBuddy, whose
 * desktop app runs that same CLI as its agent engine (`app.asar/cli/bin/codebuddy`, `codebuddy --serve`).
 *
 * The CLI mirrors Claude Code's headless mode (https://www.workbuddy.ai/docs/cli/headless): `-p` prints
 * the final result and exits, `--resume <sessionId>` continues a conversation, `--output-format json`
 * returns one result object with `result` and `session_id`. So a wake is one `codebuddy -p --resume`
 * turn with the prompt on standard input, and its result is the reply. That turn and its parsing are
 * Claude Code's own (wake-claude.ts deliverResumedPrint), shared rather than copied: this plugin only
 * supplies the program, the session id and where the sessions are.
 *
 * Sessions live under the CLI's config directory (`CODEBUDDY_CONFIG_DIR`): `~/.codebuddy` for a
 * standalone CLI, `~/.workbuddy` for WorkBuddy. A resume only finds a session under the directory it
 * was made in, so the wake carries it (`config_dir`), the way a Codex wake carries `codex_home`.
 *
 * What this does not do: tell whether the conversation is open in the WorkBuddy app. One app process
 * hosts every conversation and its session registry does not say which is open, so unlike Claude Code's
 * `live_pid` there is no `left`. A conversation open in the app and woken here is written by two
 * processes; bind a seat to a conversation that is not open, or fork one.
 *
 * Inside a session the CLI exports CODEBUDDY_SESSION_ID to the commands its agent runs (read off its
 * source; not observed live), which is the id `--resume` takes.
 *
 * WorkBuddy ships the CLI inside the app and puts no `codebuddy` on PATH. Point the wake at a launcher:
 *   #!/bin/sh
 *   ELECTRON_RUN_AS_NODE=1 exec /Applications/WorkBuddy.app/Contents/MacOS/Electron \
 *     /Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/bin/codebuddy "$@"
 * which can also add `-y`/`--permission-mode` for a person who wants unattended tool use.
 */

/** The CLI's two names (`codebuddy`, `cbc`), on PATH, or the first as a name to be found later. */
export function codebuddyProgram(env: Environment): string {
  return onPath("codebuddy", env) ?? onPath("cbc", env) ?? "codebuddy";
}

export const codebuddyPlugin: WakePlugin = {
  driver: "codebuddy",
  label: "CodeBuddy",
  capture(env, cwd) {
    const session = env.CODEBUDDY_SESSION_ID?.trim();
    if (!session) return null;
    const configDir = env.CODEBUDDY_CONFIG_DIR?.trim() || env.WORKBUDDY_CONFIG_DIR?.trim();
    return { driver: "codebuddy", session, cwd, command: codebuddyProgram(env), ...(configDir ? { config_dir: configDir } : {}) };
  },
  // The turn is Claude Code's (wake-claude.ts deliverResumedPrint): `<command> -p --resume <session>
  // --output-format json` with the prompt on stdin, only run where CodeBuddy keeps its sessions.
  deliver: (wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> =>
    deliverResumedPrint("codebuddy", wake, input, context, wake.config_dir ? { CODEBUDDY_CONFIG_DIR: wake.config_dir } : {}),
  async check(wake: SeatWake, env: Environment, run): Promise<CheckResult> {
    if (wake.config_dir) {
      try {
        accessSync(wake.config_dir, constants.R_OK);
      } catch {
        return { ok: false, message: `${wake.config_dir} (the CodeBuddy config directory holding the session) is not readable` };
      }
    }
    const checked = await checkProgram(wake, "codebuddy", env, run);
    if (!checked.ok && /is not on PATH$/.test(checked.message)) {
      return { ok: false, message: `${checked.message}. WorkBuddy ships the CLI inside the app without putting it on PATH: use a launcher (see docs/wake-plugins.md) with --command` };
    }
    return checked;
  },
};
