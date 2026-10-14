import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { localError } from "./errors.ts";
import { getStoragePaths } from "./storage.ts";
import { harnessFreeEnv, onPath, type Environment } from "./wake-driver.ts";

/**
 * `sharednet serve --install`: the wake service as a per-user service the system keeps running
 * (docs/serve-service.md). A `serve` that `join` leaves behind is a child of whatever started it and
 * has only the environment it was started from; a reboot or a logout ends it, and nothing brings it
 * back. Installed, launchd (macOS) or systemd --user (Linux) starts it at login and restarts it when
 * it ends, with an environment written down once, at install, from an explicit allowlist.
 */

/** The variables a service keeps from the shell that installs it. Nothing else is written down. */
export const SERVICE_ENV_KEYS = [
  // Who and where: `claude auth status` finds its keychain item by USER, and an empty USER reads as signed out.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // How the harnesses reach their APIs. Where a model API is only reachable through a proxy, a turn
  // started without it fails, and a service started at login has none unless it is written here.
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Which SharedNet, and where the CLI and the harnesses keep their state.
  "SHAREDNET_BASE_URL",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

const PROXY_KEYS = new Set(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);

export interface CapturedEnvironment {
  /** Written into the service definition. */
  env: Record<string, string>;
  /** Variables present but not written, and why. */
  skipped: Array<{ name: string; why: string }>;
  /** PATH entries left out because they would not outlive this process. */
  droppedPath: string[];
  /** Filled in because the installing shell lacked them. */
  filled: string[];
}

/**
 * A PATH entry that belongs to this one process: npx's cache (`~/.npm/_npx/<hash>/…`, replaced on
 * upgrade), the `node_modules/.bin` an npm script runs with, npm's node-gyp shim, or a relative one.
 */
function ephemeralPathEntry(entry: string): boolean {
  if (!entry || !isAbsolute(entry)) return true;
  const parts = entry.split(/[\\/]+/);
  if (parts.includes("_npx")) return true;
  if (parts.at(-1) === ".bin" && parts.at(-2) === "node_modules") return true;
  return parts.includes("node-gyp-bin");
}

/** A URL that carries a user name or password is a secret, and is never written to a service file. */
function carriesCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    // Not a URL, or a bare host:port; a credential would still show as user:pass@.
    return /^[^/\s]*:[^/\s]*@/.test(value);
  }
}

/**
 * The service's environment: the allowlist, from an environment with the host session's markers
 * already removed (harnessFreeEnv), so no harness session variable is ever written down.
 */
export function captureServiceEnv(env: Environment, fallback: { home: string; username: string }): CapturedEnvironment {
  const source = harnessFreeEnv(env);
  const captured: Record<string, string> = {};
  const skipped: Array<{ name: string; why: string }> = [];
  const droppedPath: string[] = [];
  const filled: string[] = [];
  for (const name of SERVICE_ENV_KEYS) {
    const value = source[name];
    if (value === undefined || value === "") continue;
    if (name === "PATH") {
      const kept: string[] = [];
      for (const entry of value.split(delimiter)) {
        if (ephemeralPathEntry(entry)) {
          if (entry) droppedPath.push(entry);
          continue;
        }
        if (!kept.includes(entry)) kept.push(entry);
      }
      if (kept.length > 0) captured.PATH = kept.join(delimiter);
      continue;
    }
    if (/[\r\n]/.test(value)) {
      skipped.push({ name, why: "it contains a line break, which a service definition cannot carry" });
      continue;
    }
    if (carriesCredentials(value)) {
      skipped.push({ name, why: "it carries a user name or password, which is never written to a service file" });
      continue;
    }
    captured[name] = value;
  }
  if (!captured.HOME && fallback.home) {
    captured.HOME = fallback.home;
    filled.push("HOME");
  }
  for (const name of ["USER", "LOGNAME"] as const) {
    if (!captured[name] && fallback.username) {
      captured[name] = fallback.username;
      filled.push(name);
    }
  }
  return { env: captured, skipped, droppedPath, filled };
}

export function hasProxy(env: Record<string, string>): boolean {
  return Object.keys(env).some((name) => PROXY_KEYS.has(name));
}

/** How the service starts the CLI, and why that path outlives an upgrade. */
export interface ServiceProgram {
  argv: string[];
  via: "npx" | "node";
  note: string;
}

/**
 * Run through npx, this CLI's files live in npx's cache, which an upgrade replaces: a service that
 * pointed into it would start nothing after the next `npx sharednet@latest`. So it is started the way
 * a person starts it, `npx -y sharednet@latest`, through the npx on the captured PATH; each start
 * (login, or a restart after `serve --stop`) takes the newest published CLI. Installed any other way
 * (a global install, a checkout), the file it runs from stays where it is, and it is run with the
 * `node` on PATH, whose path (unlike the versioned one this process may run from) survives upgrades.
 */
export function serviceProgram(input: { entry: string; execPath: string; execArgv: readonly string[]; env: Record<string, string> }): ServiceProgram {
  const viaNpx = input.entry.split(/[\\/]+/).includes("_npx");
  if (viaNpx) {
    const npx = onPath("npx", input.env);
    if (npx === null) {
      throw localError(
        "service_not_installed",
        "This CLI runs from npx's cache, which an upgrade replaces, and no npx is on PATH to start it from instead. Install it globally (npm install -g sharednet) and run sharednet serve --install from that.",
      );
    }
    return {
      argv: [npx, "-y", "sharednet@latest", "serve", "--service"],
      via: "npx",
      note: "started as npx -y sharednet@latest, so each start takes the newest published CLI (it needs the registry reachable then; until it is, the service retries)",
    };
  }
  const node = onPath("node", input.env) ?? input.execPath;
  return {
    argv: [node, ...input.execArgv, input.entry, "serve", "--service"],
    via: "node",
    note: `started from ${input.entry}, which stays the CLI it runs until that install is upgraded or removed`,
  };
}

export type ServicePlatform = "launchd" | "systemd";

export interface ServiceLocation {
  kind: ServicePlatform;
  /** The launchd label, or the systemd unit name. */
  label: string;
  /** The service definition. */
  file: string;
}

const LABEL = "ai.sharednet.serve";
const UNIT = "sharednet-serve";

/**
 * Where the service is defined. One serve per storage root (its serve.json is the lock), so a
 * service for a CLI pointed elsewhere by XDG_CONFIG_HOME gets its own name. The definition goes
 * where the service manager reads it, which is the account's home, not this shell's variables:
 * launchd loads `~/Library/LaunchAgents` at login, and a systemd --user unit directory is given by
 * `unitDir` (see userUnitDir).
 */
export function serviceLocation(platform: NodeJS.Platform, env: Environment, home: string, unitDir?: string): ServiceLocation | null {
  const configDir = getStoragePaths({ ...env, HOME: env.HOME || home }).configDir;
  const standard = join(env.HOME || home, ".config", "sharednet");
  const suffix = configDir === standard ? "" : createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  if (platform === "darwin") {
    const label = suffix ? `${LABEL}.${suffix}` : LABEL;
    return { kind: "launchd", label, file: join(home, "Library", "LaunchAgents", `${label}.plist`) };
  }
  if (platform === "linux") {
    const label = `${suffix ? `${UNIT}-${suffix}` : UNIT}.service`;
    return { kind: "systemd", label, file: join(unitDir ?? join(home, ".config", "systemd", "user"), label) };
  }
  return null;
}

/**
 * The directory a systemd --user manager reads units from, out of its own search path
 * (`systemctl --user show --property=UnitPath --value`). systemd.unit(5) puts user units in
 * `$XDG_CONFIG_HOME/systemd/user` and `$XDG_DATA_HOME/systemd/user`, but those are the variables of
 * the user manager (user@.service), not of the shell installing the unit: a CLI run with its own
 * XDG_CONFIG_HOME would otherwise write a unit nothing loads. So the manager is asked, and the
 * first persistent directory under the account's home in its path is used: `~/.config/systemd/user`
 * when it is there, as it is by default. `.control` (systemctl set-property's), transient, generator
 * and /run directories are never written to. Null when the manager names none.
 */
export function userUnitDir(unitPath: string, home: string): string | null {
  const candidates = unitPath
    .split(/\s+/)
    .filter((entry) => entry.startsWith(`${home}/`) && entry.endsWith("/systemd/user"));
  const standard = join(home, ".config", "systemd", "user");
  return candidates.includes(standard) ? standard : (candidates[0] ?? null);
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** How long launchd and systemd wait before starting a service that ended again. */
export const RESTART_SECONDS = 30;

export interface ServiceDefinition {
  label: string;
  argv: string[];
  env: Record<string, string>;
  logFile: string;
  workingDirectory: string;
}

/**
 * A LaunchAgent: started at login (RunAtLoad) and whenever it ends (KeepAlive), at most once per
 * ThrottleInterval, writing to serve's own log. Umask 077 keeps what it creates owner-only.
 */
export function launchdPlist(definition: ServiceDefinition): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const env = Object.keys(definition.env)
    .sort()
    .map((name) => `\t\t<key>${xml(name)}</key>\n\t\t${string(definition.env[name]!)}`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- Written by sharednet serve --install. Remove it with: sharednet serve --uninstall -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t${string(definition.label)}`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...definition.argv.map((arg) => `\t\t${string(arg)}`),
    `\t</array>`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    ...(env ? [env] : []),
    `\t</dict>`,
    `\t<key>WorkingDirectory</key>`,
    `\t${string(definition.workingDirectory)}`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    `\t<key>KeepAlive</key>`,
    `\t<true/>`,
    `\t<key>ThrottleInterval</key>`,
    `\t<integer>${RESTART_SECONDS}</integer>`,
    `\t<key>Umask</key>`,
    `\t<integer>63</integer>`,
    `\t<key>StandardOutPath</key>`,
    `\t${string(definition.logFile)}`,
    `\t<key>StandardErrorPath</key>`,
    `\t${string(definition.logFile)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/*
 * systemd parses each directive its own way, so each gets its own formatter (systemd.syntax(7),
 * systemd.service(5), systemd.exec(5), systemd.unit(5) "Specifiers"). A line break cannot be
 * written in any of them, and is refused.
 */
function oneLine(directive: string, value: string): string {
  if (/[\r\n]/.test(value)) throw localError("service_not_installed", `${directive} cannot hold a line break: ${JSON.stringify(value)}`);
  return value;
}

/**
 * One word of ExecStart=: double-quoted with C escapes (systemd.syntax), `%` specifiers escaped as
 * `%%`, and `$` as `$$`, since ExecStart= alone expands `$VAR` (systemd.service, "Command lines").
 */
export function systemdExecWord(value: string): string {
  oneLine("ExecStart=", value);
  if (value === ";") throw localError("service_not_installed", "ExecStart= cannot hold a lone ; word.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * One Environment= assignment: double-quoted with C escapes, `%` escaped as `%%`. `$` is left as
 * it is: systemd.exec says Environment= performs no variable expansion and `$` has no special meaning.
 */
export function systemdEnvironment(name: string, value: string): string {
  const assignment = oneLine("Environment=", `${name}=${value}`);
  return `"${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/**
 * A path setting (WorkingDirectory=, StandardOutput=append:): never quoted, since a quote would be
 * part of the path and "\"/tmp\"" is not absolute (a fatal error); `%` escaped as `%%`, because
 * specifiers are expanded in paths; no `$` handling, since paths do not expand variables.
 */
export function systemdPath(directive: string, value: string): string {
  oneLine(directive, value);
  if (!isAbsolute(value) || value !== value.trim()) {
    throw localError("service_not_installed", `${directive} needs an absolute path without surrounding spaces, not ${JSON.stringify(value)}.`);
  }
  return value.replace(/%/g, "%%");
}

/** A systemd --user unit with the same lifecycle as the LaunchAgent. */
export function systemdUnit(definition: ServiceDefinition): string {
  return [
    `# Written by sharednet serve --install. Remove it with: sharednet serve --uninstall`,
    `[Unit]`,
    `Description=SharedNet wake service (sharednet serve)`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${definition.argv.map(systemdExecWord).join(" ")}`,
    `WorkingDirectory=${systemdPath("WorkingDirectory=", definition.workingDirectory)}`,
    ...Object.keys(definition.env)
      .sort()
      .map((name) => `Environment=${systemdEnvironment(name, definition.env[name]!)}`),
    `Restart=always`,
    `RestartSec=${RESTART_SECONDS}`,
    `UMask=0077`,
    `StandardOutput=append:${systemdPath("StandardOutput=", definition.logFile)}`,
    `StandardError=append:${systemdPath("StandardError=", definition.logFile)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/** What a service manager is asked, and the files it reads. Tests replace it; nothing here runs launchctl. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  username: string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  /** The names in a directory, or none when it cannot be read. */
  listDir(path: string): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const realServiceHost = (): ServiceHost => ({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  // The account's home, which launchd and systemd use, even when this shell's HOME says otherwise.
  home: (() => {
    try {
      return userInfo().homedir || homedir();
    } catch {
      return homedir();
    }
  })(),
  username: (() => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  })(),
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  },
  remove: (path) => unlink(path).then(
    () => true,
    () => false,
  ),
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  listDir: (path) => readdir(path).catch(() => []),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 15_000, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
        resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      });
    }),
});

export interface ServiceState {
  kind: ServicePlatform;
  label: string;
  file: string;
  installed: boolean;
  /** launchd has it bootstrapped / systemd has it enabled or active. */
  loaded: boolean;
  running: boolean;
  pid?: number;
  /** What the installed definition starts. */
  program?: string[];
}

function unsupported(platform: NodeJS.Platform): never {
  throw localError(
    "service_unsupported",
    platform === "win32"
      ? "Installing serve as a service is not supported on Windows. Run sharednet serve in a terminal that stays open, or from Task Scheduler yourself."
      : `Installing serve as a service is supported on macOS (launchd) and Linux (systemd --user), not on ${platform}. Run sharednet serve under your own supervisor.`,
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").slice(-1)[0]?.slice(0, 300) ?? "";
}

/** The program a definition file starts, read back from it. */
export function programIn(kind: ServicePlatform, content: string): string[] | undefined {
  if (kind === "launchd") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
    if (array === undefined) return undefined;
    const unxml = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
  }
  const line = /^ExecStart=(.*)$/m.exec(content)?.[1];
  if (line === undefined) return undefined;
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$"));
}

/** Whether `launchctl print gui/<uid>/<label>` shows the job running, and its pid. */
export function launchdRunning(printed: string): { running: boolean; pid?: number } {
  const running = /^\s*state = running\s*$/m.test(printed);
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(printed)?.[1]);
  return { running, ...(running && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
}

/** A definition's storage root, or why it could not be read. */
export type DefinitionRoot = { root: string } | { unresolved: string };

/**
 * One value of a systemd setting split into words the way systemd.syntax(7) "Quoting" says:
 * whitespace separates words; "…" or '…' wraps a whole word (opening at its start, closing before
 * whitespace or the end); C escapes (\n, \t, \\, \", \', \s, \xhh, \nnn, \uhhhh, \Uhhhhhhhh) apply
 * in and out of quotes. Anything outside those rules (a quote inside a word, an unknown escape, an
 * unclosed quote) is null: the caller cannot know what systemd made of it.
 */
export function systemdWords(value: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'", s: " " };
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index]!)) index += 1;
    if (index >= value.length) break;
    const quote = value[index] === '"' || value[index] === "'" ? value[index]! : null;
    if (quote) index += 1;
    let word = "";
    let closed = quote === null;
    while (index < value.length) {
      const char = value[index]!;
      if (quote !== null && char === quote) {
        index += 1;
        closed = true;
        if (index < value.length && !/\s/.test(value[index]!)) return null;
        break;
      }
      if (quote === null && /\s/.test(char)) break;
      if (quote === null && (char === '"' || char === "'")) return null;
      if (char === "\\") {
        const next = value[index + 1];
        if (next === undefined) return null;
        if (next in escapes) {
          word += escapes[next];
          index += 2;
          continue;
        }
        const hex = next === "x" ? /^[0-9a-fA-F]{2}/.exec(value.slice(index + 2)) : next === "u" ? /^[0-9a-fA-F]{4}/.exec(value.slice(index + 2)) : next === "U" ? /^[0-9a-fA-F]{8}/.exec(value.slice(index + 2)) : null;
        if (hex) {
          word += String.fromCodePoint(parseInt(hex[0], 16));
          index += 2 + hex[0].length;
          continue;
        }
        const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
        if (octal) {
          word += String.fromCharCode(parseInt(octal[0], 8));
          index += 4;
          continue;
        }
        return null;
      }
      word += char;
      index += 1;
    }
    if (!closed) return null;
    words.push(word);
  }
  return words;
}

/** The [Service] section's settings of a unit (and its drop-ins, in order), continuation lines joined. */
function serviceSettings(contents: string[]): Array<{ key: string; value: string }> {
  const settings: Array<{ key: string; value: string }> = [];
  for (const content of contents) {
    let section = "";
    for (const line of content.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const header = /^\[(.+)\]$/.exec(trimmed);
      if (header) {
        section = header[1]!;
        continue;
      }
      const at = trimmed.indexOf("=");
      if (section === "Service" && at > 0) settings.push({ key: trimmed.slice(0, at).trim(), value: trimmed.slice(at + 1).trim() });
    }
  }
  return settings;
}

/** A path value's specifiers, as systemd expands them in Environment=: %% and %h (the home); any other is unknown. */
function expandSpecifiers(value: string, home: string): string | null {
  let unknown = false;
  const expanded = value.replace(/%(.)/g, (_, specifier: string) => {
    if (specifier === "%") return "%";
    if (specifier === "h") return home;
    unknown = true;
    return "";
  });
  return unknown || /%$/.test(value) ? null : expanded;
}

/**
 * The storage root a service definition's serve uses: from the HOME and XDG_CONFIG_HOME its manager
 * hands it, as the CLI's own getStoragePaths would. A definition that sets neither runs with the
 * manager's defaults, which is the account's standard root, `~/.config/sharednet`. Whatever this
 * cannot read for certain (a binary plist, EnvironmentFile=, PassEnvironment= of either variable, a
 * quoting or specifier it does not know) is unresolved, never quietly the standard root.
 * `contents` is a unit followed by its drop-ins, or one plist.
 */
export function definitionRoot(kind: ServicePlatform, contents: string | string[], home: string): DefinitionRoot {
  const all = typeof contents === "string" ? [contents] : contents;
  const env: Record<string, string> = {};
  if (kind === "launchd") {
    const content = all[0] ?? "";
    if (content.startsWith("bplist")) return { unresolved: "it is a binary plist" };
    if (!/<plist[\s>]/.test(content)) return { unresolved: "it is not an XML plist" };
    if (/<key>EnvironmentVariables<\/key>/.test(content)) {
      const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(content)?.[1];
      if (dict === undefined) return { unresolved: "its EnvironmentVariables could not be read" };
      const unxml = (value: string) =>
        value
          .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
          .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      for (const match of dict.matchAll(/<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\/>)/g)) env[unxml(match[1]!)] = unxml(match[2] ?? "");
      for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
        if (new RegExp(`<key>${name}</key>`).test(dict) && env[name] === undefined) return { unresolved: `its ${name} could not be read` };
      }
    }
  } else {
    for (const { key, value } of serviceSettings(all)) {
      if (key === "EnvironmentFile") return { unresolved: "it reads variables from an EnvironmentFile=" };
      if (key === "PassEnvironment" && /\b(HOME|XDG_CONFIG_HOME)\b/.test(value)) return { unresolved: "it passes the manager's HOME or XDG_CONFIG_HOME through (PassEnvironment=)" };
      if (key === "UnsetEnvironment" && /\b(HOME|XDG_CONFIG_HOME)\b/.test(value)) return { unresolved: "it unsets HOME or XDG_CONFIG_HOME (UnsetEnvironment=)" };
      if (key !== "Environment") continue;
      if (value === "") {
        // An empty assignment resets the list.
        for (const name of Object.keys(env)) delete env[name];
        continue;
      }
      const words = systemdWords(value);
      if (words === null) {
        if (/\b(HOME|XDG_CONFIG_HOME)=/.test(value)) return { unresolved: `its Environment=${value} could not be parsed` };
        continue;
      }
      for (const word of words) {
        const at = word.indexOf("=");
        if (at > 0) env[word.slice(0, at)] = word.slice(at + 1);
      }
    }
    for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
      if (env[name] === undefined) continue;
      const expanded = expandSpecifiers(env[name]!, home);
      if (expanded === null) return { unresolved: `its ${name}=${env[name]} uses a specifier other than %% or %h` };
      env[name] = expanded;
    }
  }
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome !== undefined && configHome !== "" && !isAbsolute(configHome)) return { unresolved: `its XDG_CONFIG_HOME=${configHome} is not absolute` };
  return { root: getStoragePaths({ HOME: env.HOME || home, ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}) }).configDir };
}

export class ServiceControl {
  private readonly env: Environment;
  private readonly host: ServiceHost;
  private readonly program: { entry: string; execPath: string; execArgv: readonly string[] } | null;

  constructor(env: Environment, host: ServiceHost, program: { entry: string; execPath: string; execArgv: readonly string[] } | null) {
    this.env = env;
    this.host = host;
    this.program = program;
  }

  /** Where the definition is, or null where there is no service manager to ask. */
  private async where(): Promise<ServiceLocation | null> {
    if (this.host.platform !== "linux") return serviceLocation(this.host.platform, this.env, this.host.home);
    const shown = await this.host.run("systemctl", ["--user", "show", "--property=UnitPath", "--value"]);
    const dir = shown.exitCode === 0 ? userUnitDir(shown.stdout, this.host.home) : null;
    return serviceLocation("linux", this.env, this.host.home, dir ?? undefined);
  }

  async location(): Promise<ServiceLocation> {
    return (await this.where()) ?? unsupported(this.host.platform);
  }

  /**
   * Other definitions in the same manager that run or respawn a SharedNet serve for the same storage
   * root: a hand-made supervisor would start serve again beside this service, and the two would race
   * for that root's one slot (serve.json). A definition for another storage root has its own slot
   * and is no conflict, which is why each root's service has its own name.
   *
   * Each one found is `blocking` when its manager will run it: launchd has it loaded, or will load it
   * at the next login (it is not disabled); systemd has it (or a timer that starts it) enabled or
   * active. A disabled definition that is not running does not block; install warns about it. What
   * cannot be read for certain blocks, and says why: a root that cannot be resolved (it might be this
   * one), or a state the manager would not report. Read-only: nothing found is stopped or edited.
   */
  async conflicts(): Promise<ServeDefinition[]> {
    const where = await this.where();
    if (where === null) return [];
    const dir = dirname(where.file);
    const root = getStoragePaths({ ...this.env, HOME: this.env.HOME || this.host.home }).configDir;
    const names = (await this.host.listDir(dir)).sort();
    const own = (label: string) => label === where.label || label === where.label.replace(/\.service$/, "");
    const mentionsServe = (content: string) => /sharednet/i.test(content) && /serve|supervis|listener|wake/i.test(content);
    const found: ServeDefinition[] = [];
    const scope = (resolved: DefinitionRoot): { same: boolean; unresolved?: string } =>
      "root" in resolved ? { same: resolved.root === root } : { same: true, unresolved: resolved.unresolved };

    if (where.kind === "launchd") {
      let disabled: Set<string> | null = null;
      for (const name of names) {
        if (!name.endsWith(".plist")) continue;
        const file = join(dir, name);
        const content = await this.host.readFile(file);
        if (content === null || !mentionsServe(content)) continue;
        const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(content)?.[1] ?? name.replace(/\.plist$/, "");
        if (own(label) || own(name.replace(/\.plist$/, ""))) continue;
        const { same, unresolved } = scope(definitionRoot("launchd", content, this.host.home));
        if (!same) continue;
        const printed = await this.host.run("launchctl", ["print", `gui/${this.host.uid}/${label}`]);
        let blocking: boolean;
        let why: string;
        if (printed.exitCode === 0) {
          const { running, pid } = launchdRunning(printed.stdout);
          blocking = true;
          why = running ? `launchd has it loaded and running${pid ? ` (pid ${pid})` : ""}` : "launchd has it loaded";
        } else {
          disabled ??= await this.launchdDisabled();
          const off = disabled.has(label) || /<key>Disabled<\/key>\s*<true\/>/.test(content);
          blocking = !off;
          why = off ? "it is disabled and not loaded" : "it is not loaded now, but launchd loads it at the next login";
        }
        found.push({
          label,
          file,
          blocking: blocking || unresolved !== undefined,
          why: unresolved ? `${why}; its storage root could not be read (${unresolved}), so it is treated as this one` : why,
          stop: printed.exitCode === 0 ? `launchctl bootout gui/${this.host.uid}/${label}` : `launchctl disable gui/${this.host.uid}/${label}`,
        });
      }
      return found;
    }

    // systemd: a .timer runs its Unit= (by default the .service of the same name), and that service's
    // own settings (and drop-ins) hold the environment. So timers are read only for what they start.
    const timers = new Map<string, string[]>();
    for (const name of names) {
      if (!name.endsWith(".timer")) continue;
      const content = (await this.host.readFile(join(dir, name))) ?? "";
      let target = name.replace(/\.timer$/, ".service");
      let section = "";
      for (const line of content.split(/\r?\n/)) {
        const header = /^\s*\[(.+)\]\s*$/.exec(line);
        if (header) section = header[1]!;
        const unit = /^\s*Unit\s*=\s*(\S+)\s*$/.exec(line);
        if (section === "Timer" && unit) target = unit[1]!;
      }
      timers.set(target, [...(timers.get(target) ?? []), name]);
    }
    for (const name of names) {
      if (!name.endsWith(".service") || own(name)) continue;
      const file = join(dir, name);
      const content = await this.host.readFile(file);
      if (content === null) continue;
      const dropIns: string[] = [];
      for (const conf of (await this.host.listDir(join(dir, `${name}.d`))).filter((entry) => entry.endsWith(".conf")).sort()) {
        dropIns.push((await this.host.readFile(join(dir, `${name}.d`, conf))) ?? "");
      }
      if (!mentionsServe([content, ...dropIns].join("\n"))) continue;
      const { same, unresolved } = scope(definitionRoot("systemd", [content, ...dropIns], this.host.home));
      if (!same) continue;
      const units = [...(timers.get(name) ?? []), name];
      const states: string[] = [];
      let blocking = false;
      for (const unit of units) {
        const enabled = (await this.host.run("systemctl", ["--user", "is-enabled", unit])).stdout.trim().split("\n")[0] ?? "";
        const active = (await this.host.run("systemctl", ["--user", "is-active", unit])).stdout.trim().split("\n")[0] ?? "";
        const knownEnabled = ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(enabled);
        const knownOff = ["disabled", "static", "indirect", "masked", "masked-runtime", "generated", "transient", "not-found"].includes(enabled);
        const isActive = ["active", "activating", "reloading", "refreshing", "deactivating"].includes(active);
        const isOff = ["inactive", "failed", "dead", "unknown"].includes(active);
        if (knownEnabled || isActive || !knownOff || !isOff) blocking = true;
        states.push(`${unit} is ${enabled || "of unknown enablement"} and ${active || "of unknown activity"}`);
      }
      found.push({
        label: name,
        file,
        blocking: blocking || unresolved !== undefined,
        why: `${states.join("; ")}${unresolved ? `; its storage root could not be read (${unresolved}), so it is treated as this one` : ""}`,
        stop: `systemctl --user disable --now ${units.join(" ")}`,
      });
    }
    // A timer whose service is not here starts something whose environment cannot be read.
    for (const [target, timerNames] of timers) {
      if (names.includes(target)) continue;
      for (const timer of timerNames) {
        const content = (await this.host.readFile(join(dir, timer))) ?? "";
        if (!mentionsServe(content) && !/sharednet/i.test(target)) continue;
        found.push({
          label: timer,
          file: join(dir, timer),
          blocking: true,
          why: `it starts ${target}, which is not in ${dir}, so its storage root could not be read; it is treated as this one`,
          stop: `systemctl --user disable --now ${timer}`,
        });
      }
    }
    return found;
  }

  /** The labels `launchctl print-disabled` reports as disabled in this login session. */
  private async launchdDisabled(): Promise<Set<string>> {
    const printed = await this.host.run("launchctl", ["print-disabled", `gui/${this.host.uid}`]);
    const labels = new Set<string>();
    for (const match of printed.stdout.matchAll(/^\s*"([^"]+)"\s*=>\s*(disabled|true)\s*$/gm)) labels.add(match[1]!);
    return labels;
  }

  /** The service as its manager sees it, or null where there is no service manager to ask. */
  async state(): Promise<ServiceState | null> {
    const where = await this.where();
    if (where === null) return null;
    const content = await this.host.readFile(where.file);
    const program = content === null ? undefined : programIn(where.kind, content);
    const base = { ...where, installed: content !== null, ...(program ? { program } : {}) };
    if (where.kind === "launchd") {
      const printed = await this.host.run("launchctl", ["print", `gui/${this.host.uid}/${where.label}`]);
      if (printed.exitCode !== 0) return { ...base, loaded: false, running: false };
      return { ...base, loaded: true, ...launchdRunning(printed.stdout) };
    }
    const shown = await this.host.run("systemctl", ["--user", "show", where.label, "--property=LoadState,ActiveState,UnitFileState,MainPID"]);
    if (shown.exitCode !== 0) return { ...base, loaded: false, running: false };
    const property = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(shown.stdout)?.[1]?.trim() ?? "";
    const running = property("ActiveState") === "active";
    const pid = Number(property("MainPID"));
    return {
      ...base,
      loaded: property("LoadState") === "loaded" && (property("UnitFileState") === "enabled" || running),
      running,
      ...(running && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    };
  }

  /**
   * Writes the definition and has the manager start it. Installing again replaces it and restarts
   * the service with the new definition. A serve already running by hand keeps the machine's one
   * connector slot (serve.json); the service waits for it to stop and then takes over.
   */
  async install(): Promise<Record<string, unknown>> {
    const where = await this.location();
    if (this.program === null) throw localError("service_not_installed", "Only the sharednet executable can install its service.");
    const others = await this.conflicts();
    if (others.some((other) => other.blocking)) throw supervisorConflict(others);
    const captured = captureServiceEnv(this.env, { home: this.host.home, username: this.host.username });
    for (const required of ["HOME", "PATH"] as const) {
      if (!captured.env[required]) throw localError("service_not_installed", `${required} is not set here, and the service cannot run without it.`);
    }
    const program = serviceProgram({ ...this.program, env: captured.env });
    const paths = getStoragePaths(captured.env);
    const logFile = join(paths.stateDir, "serve.log");
    const definition: ServiceDefinition = { label: where.label, argv: program.argv, env: captured.env, logFile, workingDirectory: captured.env.HOME! };
    // Formatted before anything is written, so a value systemd cannot hold refuses the install.
    const content = where.kind === "launchd" ? launchdPlist(definition) : systemdUnit(definition);
    await this.host.writeFile(where.file, content);
    // The log's directory must exist before the manager opens the log for the service.
    await this.host.ensureDir(paths.stateDir);
    if (where.kind === "launchd") {
      const target = `gui/${this.host.uid}`;
      // Bootstrapping a label that is already loaded fails; installing again means replacing it.
      const replaced = (await this.host.run("launchctl", ["bootout", `${target}/${where.label}`])).exitCode === 0;
      // launchd finishes a bootout after it returns; until then a bootstrap of the label fails (5: I/O error).
      let loaded = await this.host.run("launchctl", ["bootstrap", target, where.file]);
      for (let attempt = 0; replaced && loaded.exitCode !== 0 && attempt < 5; attempt += 1) {
        await this.host.sleep(1_000);
        loaded = await this.host.run("launchctl", ["bootstrap", target, where.file]);
      }
      if (loaded.exitCode !== 0) {
        throw localError("service_not_loaded", `Wrote ${where.file}, but launchctl bootstrap ${target} refused it (exit ${loaded.exitCode}): ${lastLine(loaded.stderr || loaded.stdout)}`);
      }
    } else {
      for (const args of [["--user", "daemon-reload"], ["--user", "enable", where.label], ["--user", "restart", where.label]]) {
        const done = await this.host.run("systemctl", args);
        if (done.exitCode !== 0) {
          throw localError("service_not_loaded", `Wrote ${where.file}, but systemctl ${args.join(" ")} failed (exit ${done.exitCode}): ${lastLine(done.stderr || done.stdout)}`);
        }
      }
    }
    const warnings: string[] = others.filter((other) => !other.blocking).map(inactiveDefinitionWarning);
    if (!hasProxy(captured.env)) {
      warnings.push("No proxy variable (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY) was set here, so the service has none. If a harness reaches its API only through a proxy, install again from a shell that has it.");
    }
    for (const skipped of captured.skipped) warnings.push(`${skipped.name} was not written: ${skipped.why}.`);
    let linger: boolean | null = null;
    if (where.kind === "systemd") {
      // Without lingering, logind stops a user's manager, and this service with it, when the last
      // session ends (an SSH disconnect included), and starts it only at the next login.
      const user = captured.env.USER ?? this.host.username;
      const shown = await this.host.run("loginctl", ["show-user", user, "--property=Linger"]);
      const value = /^Linger=(yes|no)\s*$/m.exec(shown.stdout)?.[1];
      linger = value === "yes" ? true : value === "no" ? false : null;
      if (linger !== true) {
        warnings.push(
          `${linger === false ? "Lingering is off" : "Whether lingering is on could not be read"} for ${user}: systemd stops this service when ${user}'s last session ends (an SSH disconnect included) and starts it again only at the next login. To keep it running, have an administrator run: sudo loginctl enable-linger ${user}`,
        );
      }
    }
    return {
      installed: true,
      manager: where.kind,
      label: where.label,
      file: where.file,
      log: logFile,
      program: program.argv,
      program_note: program.note,
      // Every value written is from the allowlist and free of credentials, so it is shown as written.
      env: captured.env,
      ...(captured.filled.length > 0 ? { env_filled_in: captured.filled } : {}),
      ...(captured.droppedPath.length > 0 ? { path_entries_dropped: captured.droppedPath } : {}),
      ...(where.kind === "systemd" ? { linger } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Stops the service and removes its definition. A serve started by hand is not touched. */
  async uninstall(): Promise<Record<string, unknown>> {
    const where = await this.location();
    let unloaded = false;
    if (where.kind === "launchd") {
      unloaded = (await this.host.run("launchctl", ["bootout", `gui/${this.host.uid}/${where.label}`])).exitCode === 0;
    } else {
      unloaded = (await this.host.run("systemctl", ["--user", "disable", "--now", where.label])).exitCode === 0;
    }
    const removed = await this.host.remove(where.file);
    if (where.kind === "systemd") await this.host.run("systemctl", ["--user", "daemon-reload"]);
    return { uninstalled: removed || unloaded, manager: where.kind, label: where.label, file: where.file, stopped: unloaded, removed };
  }

  /**
   * Starts an installed service that is not running: loads it if its manager does not have it,
   * otherwise asks for a start. A running one is left alone (no kickstart -k): never a second serve.
   */
  async start(): Promise<{ ok: boolean; message: string }> {
    const state = await this.state();
    if (state === null || !state.installed) return { ok: false, message: "no service is installed" };
    if (state.running) return { ok: true, message: `the installed service ${state.label} is running${state.pid ? ` (pid ${state.pid})` : ""}` };
    let done: { exitCode: number; stdout: string; stderr: string };
    if (state.kind === "launchd") {
      done = state.loaded
        ? await this.host.run("launchctl", ["kickstart", `gui/${this.host.uid}/${state.label}`])
        : await this.host.run("launchctl", ["bootstrap", `gui/${this.host.uid}`, state.file]);
    } else {
      done = await this.host.run("systemctl", ["--user", "start", state.label]);
    }
    return done.exitCode === 0
      ? { ok: true, message: `the installed service ${state.label} was started` }
      : { ok: false, message: `the installed service ${state.label} did not start (exit ${done.exitCode}: ${lastLine(done.stderr || done.stdout)})` };
  }
}

/** The refusal for another definition that runs or respawns serve, with the command that stops each. */
/** Another definition that runs or respawns serve for this storage root (ServiceControl.conflicts). */
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

/** The refusal for the blocking ones, each with why it blocks and the command that stops it. */
export function supervisorConflict(others: ServeDefinition[]) {
  return localError(
    "service_conflict",
    [
      `Another service definition here runs or respawns a SharedNet serve for this storage root, and would race this service for its one slot. Stop it, move its file out of the way so it does not come back, then install again:`,
      ...others.filter((other) => other.blocking).map((other) => `  ${other.stop}    # ${other.file}: ${other.why}`),
    ].join("\n"),
  );
}

/** What install says about a definition that serves this root but will not run (disabled, inactive). */
export function inactiveDefinitionWarning(other: ServeDefinition): string {
  return `${other.label} (${other.file}) also runs serve for this storage root, but ${other.why}, so it does not block this install; enabling it again would race the service.`;
}

/** What `serve` and `join` use of the service; tests stand in for it. */
export type WakeServiceControl = Pick<ServiceControl, "state" | "install" | "uninstall" | "start" | "conflicts">;
