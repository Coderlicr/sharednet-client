import { isAbsolute, join, resolve } from "node:path";

import type { ServiceHost } from "./serve-service.ts";
import { getStoragePaths } from "./storage.ts";

/**
 * Other service definitions that run or respawn a SharedNet serve for the same storage root as the
 * service being installed (docs/serve-service.md, "Never two serves"). Two serves for one root race
 * for its one slot (serve.json), so `serve --install` refuses beside one that will run.
 *
 * The effective configuration of a definition is the service manager's, not its file's: systemd
 * applies continuation lines, comments, drop-ins, precedence across the whole unit search path and
 * its own environment block; launchd applies its overrides database. Each round of reading unit
 * files by hand found another corner of that, so the manager is asked instead:
 *
 * - systemd: `systemctl --user list-unit-files` and `list-units --all` for candidates across the
 *   full search path, one batched `systemctl --user show` for their effective Environment=,
 *   EnvironmentFiles=, ExecStart=, Triggers= and state, and `show-environment` for what the
 *   manager hands every unit. When the manager cannot be asked, files that mention SharedNet are
 *   reported as unresolved and blocking.
 * - launchd: `launchctl print gui/<uid>/<label>` for a loaded job (its effective environment and
 *   state), `launchctl print-disabled gui/<uid>` for the enabled/disabled override, and the plist
 *   only for a job that is not loaded (converted by `plutil` when it is binary).
 *
 * Every manager call goes through the injected host, so tests never run launchctl or systemctl.
 * Nothing found is stopped or edited.
 */

/** Another definition that runs or respawns serve for this storage root. */
export interface ServeDefinition {
  label: string;
  file: string;
  /** Whether its manager will run it, so that it would race this service. */
  blocking: boolean;
  /** Its manager's state, and anything about it that could not be read. */
  why: string;
  /** The command that stops it from running. */
  stop: string;
}

/** A definition's storage root, or why it could not be read. */
export type DefinitionRoot = { root: string } | { unresolved: string };

/** Mentions SharedNet together with serving, supervising, listening or waking. */
export function mentionsServe(text: string): boolean {
  return /sharednet/i.test(text) && /serve|supervis|listener|wake/i.test(text);
}

/**
 * The storage root a process uses, given the HOME and XDG_CONFIG_HOME it is started with, as the
 * CLI's own getStoragePaths resolves it. A relative HOME or XDG_CONFIG_HOME would be resolved
 * against a working directory nobody can know for certain here, so it is unresolved.
 */
export function rootFrom(env: Record<string, string | undefined>, accountHome: string): DefinitionRoot {
  const home = env.HOME === undefined || env.HOME === "" ? accountHome : env.HOME;
  if (!isAbsolute(home)) return { unresolved: `its HOME=${home} is relative` };
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome !== undefined && configHome !== "" && !isAbsolute(configHome)) return { unresolved: `its XDG_CONFIG_HOME=${configHome} is relative` };
  return { root: resolve(getStoragePaths({ HOME: home, ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}) }).configDir) };
}

// ---------------------------------------------------------------------------------------------
// systemd

/**
 * `systemctl show` output for several units: blocks separated by a blank line, each `Key=value`
 * per line. Keyed by each block's Id.
 */
export function parseSystemctlShow(output: string): Map<string, Record<string, string>> {
  const units = new Map<string, Record<string, string>>();
  for (const block of output.split(/\n\s*\n/)) {
    const properties: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1);
    }
    if (properties.Id) units.set(properties.Id, properties);
  }
  return units;
}

/**
 * The words of an Environment= property as `systemctl show` prints it (systemd 255): assignments
 * separated by spaces, one with a special character double-quoted with `\"`, `\\`, `\$` and
 * `` \` `` escaped (captured on Ubuntu 24.04: `OTHER=x "SPACED=a b" "QUOTED=c\"d" "DOLLAR=\$x"`).
 * Null when it does not follow that form.
 */
export function systemctlShowWords(value: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === " ") {
      index += 1;
      continue;
    }
    let word = "";
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const char = value[index]!;
        if (char === "\\") {
          const next = value[index + 1];
          if (next === undefined) return null;
          word += next;
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        word += char;
        index += 1;
      }
      if (!closed || (index < value.length && value[index] !== " ")) return null;
    } else {
      while (index < value.length && value[index] !== " ") {
        if (value[index] === '"' || value[index] === "\\") return null;
        word += value[index];
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

/** `systemctl show-environment`: one assignment per line, quoted the same way when it has to be. */
export function parseShowEnvironment(output: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const words = systemctlShowWords(line);
    if (words === null || words.length !== 1) {
      // A value printed in a form this does not read ($'…' for control characters) only matters
      // when it is one of the two variables the root comes from.
      if (/^(HOME|XDG_CONFIG_HOME)=/.test(line)) return null;
      continue;
    }
    const at = words[0]!.indexOf("=");
    if (at > 0) env[words[0]!.slice(0, at)] = words[0]!.slice(at + 1);
  }
  return env;
}

/**
 * The storage root a systemd --user unit's process uses: the manager's environment block (handed
 * to every unit it starts), then the unit's effective Environment= on top. EnvironmentFiles= and
 * UnsetEnvironment= of either variable, a manager environment that could not be read, or a value
 * not in the printed form, make it unresolved.
 */
export function systemdUnitRoot(unit: Record<string, string>, managerEnv: Record<string, string> | null, accountHome: string): DefinitionRoot {
  if ((unit.EnvironmentFiles ?? "").trim() !== "") return { unresolved: `it reads variables from EnvironmentFile= ${unit.EnvironmentFiles!.trim()}` };
  const unset = (unit.UnsetEnvironment ?? "").split(/\s+/).filter((name) => /^(HOME|XDG_CONFIG_HOME)(=|$)/.test(name));
  if (unset.length > 0) return { unresolved: `it unsets ${unset.join(" ")} (UnsetEnvironment=)` };
  const words = systemctlShowWords(unit.Environment ?? "");
  if (words === null) return { unresolved: `its Environment=${unit.Environment} could not be read` };
  const own: Record<string, string> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    if (at > 0) own[word.slice(0, at)] = word.slice(at + 1);
  }
  if (managerEnv === null && (own.HOME === undefined || own.XDG_CONFIG_HOME === undefined)) {
    return { unresolved: "the user manager's own environment (systemctl --user show-environment) could not be read" };
  }
  return rootFrom({ ...(managerEnv ?? {}), ...own }, accountHome);
}

const SYSTEMD_PROPERTIES = "Id,LoadState,FragmentPath,DropInPaths,UnitFileState,ActiveState,ExecStart,ExecStartPre,Environment,EnvironmentFiles,UnsetEnvironment,Triggers,Description";
const ENABLED = new Set(["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"]);
const NOT_ENABLED = new Set(["disabled", "static", "indirect", "masked", "masked-runtime", "generated", "transient", "bad", ""]);
const ACTIVE = new Set(["active", "activating", "reloading", "refreshing", "deactivating"]);
const NOT_ACTIVE = new Set(["inactive", "failed", "dead"]);

/** Unit names from `list-unit-files` or `list-units --plain` output: the first column. */
function unitNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => /\.(service|timer|path|socket)$/.test(name));
}

export async function systemdConflicts(input: { host: ServiceHost; ownLabel: string; root: string; unitDirs: string[] }): Promise<ServeDefinition[]> {
  const { host, ownLabel, root } = input;
  const run = (args: string[]) => host.run("systemctl", ["--user", ...args]);
  const types = "--type=service,timer,path,socket";
  const files = await run(["list-unit-files", types, "--no-legend", "--no-pager"]);
  const loaded = await run(["list-units", "--all", types, "--no-legend", "--no-pager", "--plain"]);
  if (files.exitCode !== 0) return systemdFallback(input, `systemctl --user list-unit-files exited ${files.exitCode}`);
  const names = [...new Set([...unitNames(files.stdout), ...unitNames(loaded.exitCode === 0 ? loaded.stdout : "")])].filter((name) => name !== ownLabel);
  const units = new Map<string, Record<string, string>>();
  const show = async (list: string[]): Promise<string | null> => {
    for (let at = 0; at < list.length; at += 200) {
      const shown = await run(["show", "--no-pager", `--property=${SYSTEMD_PROPERTIES}`, ...list.slice(at, at + 200)]);
      if (shown.exitCode !== 0) return `systemctl --user show exited ${shown.exitCode}`;
      for (const [id, properties] of parseSystemctlShow(shown.stdout)) units.set(id, properties);
    }
    return null;
  };
  const failed = await show(names);
  if (failed !== null) return systemdFallback(input, failed);
  // What a timer, path or socket starts, after its drop-ins: the manager's Triggers=.
  const activators = new Map<string, string[]>();
  for (const [id, unit] of units) {
    if (id.endsWith(".service")) continue;
    for (const target of (unit.Triggers ?? "").split(/\s+/).filter(Boolean)) activators.set(target, [...(activators.get(target) ?? []), id]);
  }
  const unseen = [...activators.keys()].filter((target) => !units.has(target) && target !== ownLabel);
  if (unseen.length > 0) {
    const again = await show(unseen);
    if (again !== null) return systemdFallback(input, again);
  }
  const environment = await run(["show-environment"]);
  const managerEnv = environment.exitCode === 0 ? parseShowEnvironment(environment.stdout) : null;

  const found: ServeDefinition[] = [];
  for (const [id, unit] of units) {
    if (!id.endsWith(".service") || id === ownLabel) continue;
    // Whether it is about SharedNet at all: what the manager reports, and the files it was made from.
    const sources: string[] = [id, unit.Description ?? "", unit.ExecStart ?? "", unit.ExecStartPre ?? "", unit.Environment ?? "", unit.FragmentPath ?? ""];
    for (const path of [unit.FragmentPath ?? "", ...(unit.DropInPaths ?? "").split(/\s+/)].filter(Boolean)) sources.push((await host.readFile(path)) ?? "");
    if (!mentionsServe(sources.join("\n"))) continue;
    if (unit.LoadState === "masked") continue;
    const resolved = systemdUnitRoot(unit, managerEnv, host.home);
    if ("root" in resolved && resolved.root !== root) continue;
    const involved = [...(activators.get(id) ?? []), id];
    let blocking = false;
    const states = involved.map((name) => {
      const state = units.get(name) ?? {};
      const enabled = state.UnitFileState ?? "";
      const active = state.ActiveState ?? "";
      const known = (ENABLED.has(enabled) || NOT_ENABLED.has(enabled)) && (ACTIVE.has(active) || NOT_ACTIVE.has(active));
      if (!known || ENABLED.has(enabled) || ACTIVE.has(active)) blocking = true;
      return `${name} is ${enabled || "of unknown enablement"} and ${active || "of unknown activity"}`;
    });
    found.push({
      label: id,
      file: unit.FragmentPath || id,
      blocking: blocking || "unresolved" in resolved,
      why: `${states.join("; ")}${"unresolved" in resolved ? `; its storage root could not be read (${resolved.unresolved}), so it is treated as this one` : ""}`,
      stop: `systemctl --user disable --now ${involved.join(" ")}`,
    });
  }
  return found;
}

/**
 * When the manager cannot be asked, nothing about a unit's effective configuration is known: each
 * unit file in the manager's directories that mentions SharedNet is reported, unresolved and blocking.
 */
async function systemdFallback(input: { host: ServiceHost; ownLabel: string; unitDirs: string[] }, why: string): Promise<ServeDefinition[]> {
  const found: ServeDefinition[] = [];
  for (const dir of input.unitDirs) {
    for (const name of (await input.host.listDir(dir)).sort()) {
      if (!/\.(service|timer|path|socket)$/.test(name) || name === input.ownLabel) continue;
      const file = join(dir, name);
      const content = await input.host.readFile(file);
      if (content === null || !mentionsServe(content)) continue;
      found.push({
        label: name,
        file,
        blocking: true,
        why: `the user manager could not be asked (${why}), so its storage root and state are unknown; it is treated as this root's, and running`,
        stop: `systemctl --user disable --now ${name}`,
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// launchd

function unxml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** An XML plist's EnvironmentVariables, or null when they are there but cannot be read. */
export function plistEnvironment(xml: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  if (!/<key>EnvironmentVariables<\/key>/.test(xml)) return env;
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1];
  if (dict === undefined) return /<key>EnvironmentVariables<\/key>\s*<dict\/>/.test(xml) ? env : null;
  for (const match of dict.matchAll(/<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\/>)/g)) env[unxml(match[1]!)] = unxml(match[2] ?? "");
  for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
    if (new RegExp(`<key>${name}</key>`).test(dict) && env[name] === undefined) return null;
  }
  return env;
}

/**
 * A loaded job's environment, as `launchctl print` shows it: its default, inherited and own
 * environment blocks, later ones overriding earlier ones. HOME is not among them; launchd gives a
 * LaunchAgent the account's home.
 */
export function launchdPrintEnvironment(printed: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const block of ["default environment", "inherited environment", "environment"]) {
    const body = new RegExp(`^\\t${block} = \\{\\n([\\s\\S]*?)^\\t\\}`, "m").exec(printed)?.[1] ?? "";
    for (const match of body.matchAll(/^\t\t(\S+) => (.*)$/gm)) env[match[1]!] = match[2]!;
  }
  return env;
}

/** `launchctl print-disabled gui/<uid>`: each label's explicit override, enabled or disabled. */
export function launchdOverrides(printed: string): Map<string, "enabled" | "disabled"> {
  const overrides = new Map<string, "enabled" | "disabled">();
  for (const match of printed.matchAll(/^\s*"([^"]+)"\s*=>\s*(enabled|disabled|true|false)\s*$/gm)) {
    overrides.set(match[1]!, match[2] === "enabled" || match[2] === "false" ? "enabled" : "disabled");
  }
  return overrides;
}

export async function launchdConflicts(input: { host: ServiceHost; ownLabel: string; root: string; agentDirs: string[] }): Promise<ServeDefinition[]> {
  const { host, ownLabel, root } = input;
  const target = `gui/${host.uid}`;
  let overrides: Map<string, "enabled" | "disabled"> | null = null;
  const found: ServeDefinition[] = [];
  for (const dir of input.agentDirs) {
    for (const name of (await host.listDir(dir)).sort()) {
      if (!name.endsWith(".plist")) continue;
      const file = join(dir, name);
      const raw = await host.readFile(file);
      if (raw === null) continue;
      let xml: string | null = raw;
      if (raw.startsWith("bplist")) {
        const converted = await host.run("plutil", ["-convert", "xml1", "-o", "-", file]);
        xml = converted.exitCode === 0 ? converted.stdout : null;
      }
      if (!mentionsServe(xml ?? raw)) continue;
      const label = xml === null ? name.replace(/\.plist$/, "") : (/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ?? name.replace(/\.plist$/, ""));
      if (label === ownLabel) continue;
      const printed = await host.run("launchctl", ["print", `${target}/${label}`]);
      const isLoaded = printed.exitCode === 0;
      let resolved: DefinitionRoot;
      if (isLoaded) {
        resolved = rootFrom(launchdPrintEnvironment(printed.stdout), host.home);
      } else if (xml === null) {
        resolved = { unresolved: "it is a binary plist that plutil could not convert" };
      } else {
        const env = plistEnvironment(xml);
        resolved = env === null ? { unresolved: "its EnvironmentVariables could not be read" } : rootFrom(env, host.home);
      }
      if ("root" in resolved && resolved.root !== root) continue;
      let blocking: boolean;
      let why: string;
      if (isLoaded) {
        const running = /^\s*state = running\s*$/m.test(printed.stdout);
        const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1];
        blocking = true;
        why = running ? `launchd has it loaded and running${pid ? ` (pid ${pid})` : ""}` : "launchd has it loaded";
      } else {
        // The manager's override wins over the plist's own Disabled key; without one, the key decides.
        overrides ??= launchdOverrides((await host.run("launchctl", ["print-disabled", target])).stdout);
        const override = overrides.get(label);
        const keyDisabled = xml !== null && /<key>Disabled<\/key>\s*<true\/>/.test(xml);
        const disabled = override === undefined ? keyDisabled : override === "disabled";
        blocking = !disabled;
        why = disabled
          ? `it is disabled${override ? " (launchctl override)" : " (its Disabled key)"} and not loaded`
          : `it is not loaded now, but launchd loads it at the next login${override === "enabled" && keyDisabled ? " (a launchctl override enables it despite its Disabled key)" : ""}`;
      }
      found.push({
        label,
        file,
        blocking: blocking || "unresolved" in resolved,
        why: "unresolved" in resolved ? `${why}; its storage root could not be read (${resolved.unresolved}), so it is treated as this one` : why,
        stop: isLoaded ? `launchctl bootout ${target}/${label}` : `launchctl disable ${target}/${label}`,
      });
    }
  }
  return found;
}
