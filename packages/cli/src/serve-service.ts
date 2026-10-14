import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { localError } from "./errors.ts";
import { getStoragePaths } from "./storage.ts";
import { harnessFreeEnv, onPath, type Environment } from "./wake-driver.ts";

/**
 * `sharednet serve --install`: the wake service as a per-user launchd agent (docs/serve-service.md).
 * A `serve` that `join` leaves behind is a child of whatever started it and has only the environment
 * it was started from; a reboot or a logout ends it, and nothing brings it back. Installed, launchd
 * starts it at login and again whenever it ends, with an environment written down once, at install,
 * from an allowlist. macOS only for now: Linux (systemd --user) and Windows refuse.
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
/**
 * The persisted variables whose values are addresses, where a user name or password could ride
 * along. Any of them containing `@` refuses the install (`refusedAddresses`): no form of userinfo
 * (scheme, `//`, scheme-less, `DOMAIN\user`, percent-encoded) exists without a literal `@`, so the
 * value is never parsed, and never shown.
 */
const ADDRESS_KEYS = new Set([...PROXY_KEYS, "SHAREDNET_BASE_URL"]);
/** The variables a storage root and the service's log are resolved from. */
const ROOT_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;

export interface CapturedEnvironment {
  /** Written into the service definition. */
  env: Record<string, string>;
  /** Variables present but not written, and why. */
  skipped: Array<{ name: string; why: string }>;
  /** PATH entries left out because they would not outlive this process. */
  droppedPath: string[];
  /** Filled in because the installing shell lacked them. */
  filled: string[];
  /** Address variables containing `@` (a user name or password): named only, never written; install refuses. */
  refusedAddresses: string[];
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
  const refusedAddresses: string[] = [];
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
    if (ADDRESS_KEYS.has(name) && value.includes("@")) {
      refusedAddresses.push(name);
      continue;
    }
    if (/[\r\n]/.test(value)) {
      skipped.push({ name, why: "it contains a line break, which a service definition cannot carry" });
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
  return { env: captured, skipped, droppedPath, filled, refusedAddresses };
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
      note: "started as npx -y sharednet@latest, so each start takes the newest published CLI (it needs the registry reachable then; until it is, launchd starts it again)",
    };
  }
  // Never this process's own executable: it may be a versioned path an upgrade removes, or npx's
  // cache (`npx node@24 …`), which the next npx run replaces.
  const node = onPath("node", input.env);
  if (node === null) {
    throw localError(
      "service_not_installed",
      `No node is on the PATH the service would be given (${input.env.PATH ?? "unset"}); this process runs from ${input.execPath}, which an upgrade can remove. Install from a shell whose PATH has a node install of its own (Homebrew, nvm, Volta, the nodejs.org installer).`,
    );
  }
  return {
    argv: [node, ...input.execArgv, input.entry, "serve", "--service"],
    via: "node",
    note: `started from ${input.entry}, which stays the CLI it runs until that install is upgraded or removed`,
  };
}

/**
 * The storage root a process uses, given the HOME and XDG_CONFIG_HOME it is started with, as the
 * CLI's own getStoragePaths resolves it. A relative one would resolve against a working directory
 * nobody can know for certain, so it is unresolved.
 */
export function rootFrom(env: Record<string, string | undefined>, accountHome: string): { root: string } | { unresolved: string } {
  const home = env.HOME === undefined || env.HOME === "" ? accountHome : env.HOME;
  if (!isAbsolute(home)) return { unresolved: `HOME=${home} is relative` };
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome !== undefined && configHome !== "" && !isAbsolute(configHome)) return { unresolved: `XDG_CONFIG_HOME=${configHome} is relative` };
  return { root: resolve(getStoragePaths({ HOME: home, ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}) }).configDir) };
}

export interface ServiceLocation {
  label: string;
  file: string;
}

const LABEL = "ai.sharednet.serve";

/**
 * SharedNet's own LaunchAgent for a storage root. The plain label belongs to the account home's
 * standard root, `~/.config/sharednet`, alone; every other resolved root (another XDG_CONFIG_HOME or
 * another HOME) gets a hashed one, so two roots never share a label or a file. The file is in the
 * account's `~/Library/LaunchAgents`, which launchd loads at login.
 */
export function serviceLocation(root: string, accountHome: string): ServiceLocation {
  const standard = resolve(join(accountHome, ".config", "sharednet"));
  const label = root === standard ? LABEL : `${LABEL}.${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
  return { label, file: join(accountHome, "Library", "LaunchAgents", `${label}.plist`) };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** How long launchd waits before starting a service that ended again. */
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

/** The program a plist starts, read back from it. */
export function programIn(content: string): string[] | undefined {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
  if (array === undefined) return undefined;
  const unxml = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
}

/**
 * What the service manager is asked, and the files it reads. Tests replace it; nothing here runs
 * launchctl. `readFile` answers null only for a file that is not there; `remove` succeeds only when
 * the file is gone. Any other error is thrown, so an unreadable definition is never taken for absent.
 */
export interface ServiceHost {
  platform: string;
  uid: number;
  home: string;
  username: string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** Waits, between looks at a job launchd is still tearing down. */
  pause(ms: number): Promise<void>;
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const realServiceHost = (): ServiceHost => ({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  // The account's home, which launchd uses, even when this shell's HOME says otherwise.
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
  readFile: (path) =>
    readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  },
  remove: (path) =>
    unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  ensureDir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  pause: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 15_000, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
        resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      });
    }),
});

/**
 * How long uninstall keeps looking after a bootout that succeeded: launchd returns from bootout
 * before the job is gone (seen on macOS 26: `print` still answered for the job right after), so
 * one look straight away would refuse an uninstall that was about to be true.
 */
export const BOOTOUT_SETTLE_MS = 10_000;
const BOOTOUT_LOOK_MS = 250;

/** Whether launchd holds a label: yes, no (it said it has no such service), or unknown (any other failure). */
export type LaunchdHolds = "loaded" | "absent" | "unknown";

/**
 * Reads `launchctl print gui/<uid>/<label>`. Only launchd's own "no such service" answer (exit 113,
 * "Could not find service") proves the label is absent; a timeout, a permission or IPC error, or a
 * launchctl that did not start proves nothing.
 */
export function launchdHolds(printed: { exitCode: number; stdout: string; stderr: string }): LaunchdHolds {
  if (printed.exitCode === 0) return "loaded";
  if (printed.exitCode === 113 || /Could not find service/i.test(`${printed.stderr}\n${printed.stdout}`)) return "absent";
  return "unknown";
}

/** Whether `launchctl print` shows the job running, and its pid. */
export function launchdRunning(printed: string): { running: boolean; pid?: number } {
  const running = /^\s*state = running\s*$/m.test(printed);
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(printed)?.[1]);
  return { running, ...(running && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
}

export interface ServiceState {
  label: string;
  file: string;
  /** The storage root it serves: the one install would write, lock and name. */
  root: string;
  /** Its plist exists. */
  installed: boolean;
  /** launchd holds the label (or cannot say that it does not: see `holds`). */
  loaded: boolean;
  holds: LaunchdHolds;
  running: boolean;
  pid?: number;
  /** What the installed plist starts. */
  program?: string[];
}

function unsupported(platform: string): never {
  throw localError(
    "service_unsupported",
    platform === "linux"
      ? "Installing serve as a service is supported on macOS (launchd) only for now; systemd --user support is planned. On Linux, run sharednet serve under a supervisor of your own."
      : platform === "win32"
        ? "Installing serve as a service is not supported on Windows. Run sharednet serve in a terminal that stays open, or from Task Scheduler yourself."
        : `Installing serve as a service is supported on macOS (launchd) only, not on ${platform}. Run sharednet serve under a supervisor of your own.`,
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").slice(-1)[0]?.slice(0, 300) ?? "";
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

  /**
   * The environment the service will run with, captured once from this one, and the root it
   * resolves to. Its location, name, lock root and log all come from it. A root-defining variable it
   * cannot carry unchanged (a line break), or one that is not absolute, is refused instead of quietly
   * serving another root than the one reported.
   */
  private prepared(): { captured: CapturedEnvironment; root: string; stateDir: string } {
    const captured = captureServiceEnv(this.env, { home: this.host.home, username: this.host.username });
    for (const name of ROOT_KEYS) {
      const given = this.env[name];
      if (given === undefined || given === "") continue;
      if (captured.env[name] !== given) {
        const why = captured.skipped.find((skipped) => skipped.name === name)?.why ?? "it cannot be written into a service definition";
        throw localError("service_not_installed", `${name} cannot be carried into the service: ${why}. Install from a shell where ${name} is a plain absolute path.`);
      }
      if (!isAbsolute(given)) {
        throw localError("service_not_installed", `${name}=${given} is relative; the service would resolve it against another directory than this shell. Install from a shell where ${name} is an absolute path.`);
      }
    }
    const resolved = rootFrom({ HOME: captured.env.HOME, XDG_CONFIG_HOME: captured.env.XDG_CONFIG_HOME }, this.host.home);
    if ("unresolved" in resolved) throw localError("service_not_installed", `The storage root cannot be resolved: ${resolved.unresolved}.`);
    // launchd starts an agent with its user domain's environment (launchctl setenv) beneath the
    // plist's. A root-defining variable left out here could come from there and move the service to
    // another root than the one named, so both are always written, with the values resolved here
    // (the XDG defaults when this shell has none, which mean the same to every program that reads them).
    const home = captured.env.HOME;
    if (!home) throw localError("service_not_installed", "HOME is not set here, and the service cannot run without it.");
    for (const [name, fallback] of [["XDG_CONFIG_HOME", join(home, ".config")], ["XDG_STATE_HOME", join(home, ".local", "state")]] as const) {
      if (captured.env[name]) continue;
      captured.env[name] = fallback;
      captured.filled.push(name);
    }
    const pinned = getStoragePaths(captured.env);
    if (resolve(pinned.configDir) !== resolved.root) throw localError("service_not_installed", `The storage root resolved two ways (${resolved.root}, ${pinned.configDir}); install from a shell with plain absolute HOME and XDG_CONFIG_HOME.`);
    return { captured, root: resolved.root, stateDir: pinned.stateDir };
  }

  private where(): (ServiceLocation & { root: string }) | null {
    if (this.host.platform !== "darwin") return null;
    const { root } = this.prepared();
    return { ...serviceLocation(root, this.host.home), root };
  }

  /** Refuses, with why, where there is no launchd (Linux, Windows): before any other check. */
  assertSupported(): void {
    if (this.host.platform !== "darwin") unsupported(this.host.platform);
  }

  /** SharedNet's own service for this root as launchd sees it, or null where there is no launchd. */
  async state(): Promise<ServiceState | null> {
    const where = this.where();
    if (where === null) return null;
    const content = await this.host.readFile(where.file);
    const program = content === null ? undefined : programIn(content);
    const printed = await this.host.run("launchctl", ["print", `gui/${this.host.uid}/${where.label}`]);
    const holds = launchdHolds(printed);
    return {
      ...where,
      installed: content !== null,
      holds,
      loaded: holds !== "absent",
      ...(holds === "loaded" ? launchdRunning(printed.stdout) : { running: false }),
      ...(program ? { program } : {}),
    };
  }

  /**
   * Writes the LaunchAgent and bootstraps it. Refused, before anything is written, when SharedNet's
   * own service for this root is there already: its plist exists, or launchd holds (or cannot deny
   * holding) its label. A reinstall is an explicit uninstall first.
   */
  async install(): Promise<Record<string, unknown>> {
    this.assertSupported();
    if (this.program === null) throw localError("service_not_installed", "Only the sharednet executable can install its service.");
    const { captured, root, stateDir } = this.prepared();
    // Before anything is asked of launchd or written: a service without the proxy it was installed
    // with would install cleanly and then reach nothing, so this refuses rather than drop it.
    if (captured.refusedAddresses.length > 0) throw addressRefused(captured.refusedAddresses);
    const existing = (await this.state())!;
    if (existing.installed || existing.loaded) throw serviceInstalled(existing);
    for (const required of ["HOME", "PATH"] as const) {
      if (!captured.env[required]) throw localError("service_not_installed", `${required} is not set here, and the service cannot run without it.`);
    }
    const program = serviceProgram({ ...this.program, env: captured.env });
    const logFile = join(stateDir, "serve.log");
    const definition: ServiceDefinition = { label: existing.label, argv: program.argv, env: captured.env, logFile, workingDirectory: captured.env.HOME! };
    await this.host.writeFile(existing.file, launchdPlist(definition));
    // The log's directory must exist before launchd opens the log for the service.
    await this.host.ensureDir(stateDir);
    const target = `gui/${this.host.uid}`;
    const loaded = await this.host.run("launchctl", ["bootstrap", target, existing.file]);
    if (loaded.exitCode !== 0) {
      throw localError("service_not_loaded", `Wrote ${existing.file}, but launchctl bootstrap ${target} refused it (exit ${loaded.exitCode}): ${lastLine(loaded.stderr || loaded.stdout)}. Remove it with: sharednet serve --uninstall`);
    }
    const warnings: string[] = [
      `Only SharedNet's own service (${existing.label}, ${existing.file}) and this storage root's serve lock were checked. A supervisor you manage yourself (another LaunchAgent, cron, a login script) is not inspected: if one runs serve for ${root}, retire it, or it will keep starting serve; the service then waits for the lock rather than run beside it.`,
    ];
    if (!hasProxy(captured.env)) {
      warnings.push("No proxy variable (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY) was set here, so the service has none. If a harness reaches its API only through a proxy, uninstall and install again from a shell that has it.");
    }
    for (const skipped of captured.skipped) warnings.push(`${skipped.name} was not written: ${skipped.why}.`);
    return {
      installed: true,
      root,
      label: existing.label,
      file: existing.file,
      log: logFile,
      program: program.argv,
      program_note: program.note,
      // Every value written is from the allowlist and free of credentials, so it is shown as written.
      env: captured.env,
      ...(captured.filled.length > 0 ? { env_filled_in: captured.filled } : {}),
      ...(captured.droppedPath.length > 0 ? { path_entries_dropped: captured.droppedPath } : {}),
      warnings,
    };
  }

  /**
   * Stops the service and removes its plist, and says it did only when both are verified: launchd
   * answers that it has no such service, and the file is gone. Otherwise the plist is kept so the
   * uninstall can be retried, and the failure names the command to finish it by hand.
   */
  async uninstall(): Promise<Record<string, unknown>> {
    this.assertSupported();
    const where = this.where()!;
    const target = `gui/${this.host.uid}/${where.label}`;
    const done = await this.host.run("launchctl", ["bootout", target]);
    let after = launchdHolds(await this.host.run("launchctl", ["print", target]));
    // Still there after a bootout that succeeded: launchd may still be tearing it down. Look again,
    // for a bounded time; only its no-such-service answer ever counts as gone.
    for (let waited = 0; after === "loaded" && done.exitCode === 0 && waited < BOOTOUT_SETTLE_MS; waited += BOOTOUT_LOOK_MS) {
      await this.host.pause(BOOTOUT_LOOK_MS);
      after = launchdHolds(await this.host.run("launchctl", ["print", target]));
    }
    if (after !== "absent") {
      throw localError(
        "service_not_uninstalled",
        `launchctl bootout ${target} ${done.exitCode === 0 ? "returned" : `failed (exit ${done.exitCode}: ${lastLine(done.stderr || done.stdout)})`}, but launchd ${after === "loaded" ? "still has the job loaded" : "could not confirm the job is gone"} for storage root ${where.root}. Its plist was left at ${where.file} so this can be retried: run sharednet serve --uninstall again, or run launchctl bootout ${target} yourself and then remove ${where.file}.`,
      );
    }
    try {
      await this.host.remove(where.file);
      if ((await this.host.readFile(where.file)) !== null) throw new Error("it is still there");
    } catch (error) {
      throw localError("service_not_uninstalled", `The service for storage root ${where.root} is stopped, but its plist at ${where.file} could not be removed (${error instanceof Error ? error.message : String(error)}). Remove it yourself.`);
    }
    return { uninstalled: true, root: where.root, label: where.label, file: where.file, stopped: done.exitCode === 0 };
  }

  /**
   * Starts an installed service that is not running: bootstraps it if launchd does not have it,
   * otherwise asks for a start. A running one is left alone (no kickstart -k): never a second serve.
   */
  async start(): Promise<{ ok: boolean; message: string }> {
    const state = await this.state();
    if (state === null || !state.installed) return { ok: false, message: "no service is installed" };
    if (state.running) return { ok: true, message: `the installed service ${state.label} is running${state.pid ? ` (pid ${state.pid})` : ""}` };
    if (state.holds === "unknown") return { ok: false, message: `launchd could not say whether it has ${state.label}` };
    const done = state.holds === "loaded"
      ? await this.host.run("launchctl", ["kickstart", `gui/${this.host.uid}/${state.label}`])
      : await this.host.run("launchctl", ["bootstrap", `gui/${this.host.uid}`, state.file]);
    return done.exitCode === 0
      ? { ok: true, message: `the installed service ${state.label} was started` }
      : { ok: false, message: `the installed service ${state.label} did not start (exit ${done.exitCode}: ${lastLine(done.stderr || done.stdout)})` };
  }
}

/** The refusal for address variables with `@` in them: it names them, and never shows a value. */
function addressRefused(names: string[]) {
  const which = names.join(", ");
  return localError(
    "install_refused",
    `${which} ${names.length === 1 ? "contains" : "contain"} "@", which means a user name or password, and the service definition would store it in plain text (the value is not shown). Install from a shell where ${names.length === 1 ? "it names" : "they name"} a proxy that needs no credentials, or give the proxy its credentials another way, outside the service definition, then install again.`,
  );
}

/** The refusal when SharedNet's own service for a root is already there: the way on is --uninstall. */
export function serviceInstalled(state: ServiceState) {
  return localError(
    "service_installed",
    `SharedNet's service for storage root ${state.root} is already ${state.installed ? "installed" : state.holds === "loaded" ? "loaded" : "possibly loaded (launchd could not say otherwise)"}: ${state.label} at ${state.file}${state.running ? ` (running${state.pid ? `, pid ${state.pid}` : ""})` : ""}. To install it again: sharednet serve --uninstall, then sharednet serve --install.`,
  );
}

/** What `serve` and `join` use of the service; tests stand in for it. */
export type WakeServiceControl = Pick<ServiceControl, "assertSupported" | "state" | "install" | "uninstall" | "start">;
