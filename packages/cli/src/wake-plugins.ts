import { claudePlugin } from "./wake-claude.ts";
import { codebuddyPlugin } from "./wake-codebuddy.ts";
import { codexPlugin } from "./wake-codex.ts";
import { commandPlugin } from "./wake-command.ts";
import { validTurnLimit } from "./wake-driver.ts";
import type { Environment, SeatWake, WakeDriver, WakePlugin } from "./wake-driver.ts";

/**
 * The wake plugins (docs/wake-plugins.md). A harness is one module and one line here; `serve` and
 * `join` only ever ask the registry.
 */
export const wakePlugins: readonly WakePlugin[] = [codexPlugin, claudePlugin, codebuddyPlugin, commandPlugin];

export function pluginFor(driver: WakeDriver): WakePlugin {
  const plugin = wakePlugins.find((candidate) => candidate.driver === driver);
  if (!plugin) throw new Error(`no wake plugin for ${driver}`);
  return plugin;
}

export function isWakeDriver(value: unknown): value is WakeDriver {
  return wakePlugins.some((plugin) => plugin.driver === value);
}

/** The session this process runs in, from the first plugin that recognises it, or none. */
export function seatWakeFrom(env: Environment, cwd: string): SeatWake | null {
  for (const plugin of wakePlugins) {
    const wake = plugin.capture(env, cwd);
    if (wake) return wake;
  }
  return null;
}

/** A stored wake, or nothing: a seat file with a damaged wake is still a seat, just not driven. */
export function parseSeatWake(value: unknown): SeatWake | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : null);
  const driver = isWakeDriver(record.driver) ? record.driver : null;
  const session = text(record.session);
  const cwd = text(record.cwd);
  const command = text(record.command);
  // A harness's wake resumes a session; a command's has none to resume.
  if (!driver || !cwd || !command || (driver !== "command" && !session)) return undefined;
  const home = text(record.codex_home);
  const configDir = text(record.config_dir);
  const live = record.live_pid;
  if (record.turn_limit_ms !== undefined && !validTurnLimit(record.turn_limit_ms)) return undefined;
  return {
    driver,
    ...(session ? { session } : {}),
    cwd,
    command,
    ...(home ? { codex_home: home } : {}),
    ...(validTurnLimit(record.turn_limit_ms) ? { turn_limit_ms: record.turn_limit_ms } : {}),
    ...(typeof live === "number" && Number.isSafeInteger(live) && live > 0 ? { live_pid: live } : {}),
    ...(driver === "codebuddy" && configDir ? { config_dir: configDir } : {}),
  };
}

/** How a wake reads in `serve --status` and the log: the plugin and what it resumes or runs. */
export function describeWake(wake: SeatWake): string {
  return `${wake.driver} ${wake.session ?? wake.command}`;
}
