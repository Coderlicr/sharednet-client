// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BOOTOUT_SETTLE_MS,
  captureServiceEnv,
  launchdHolds,
  launchdPlist,
  programIn,
  ServiceControl,
  serviceLocation,
  serviceProgram,
  type ServiceHost,
} from "./serve-service.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A directory of stand-in programs, so PATH lookups find something without touching the real machine. */
async function binWith(...names: string[]): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "sharednet-service-bin-"));
  cleanup.push(bin);
  for (const name of names) {
    await writeFile(join(bin, name), "#!/bin/sh\n");
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

const FALLBACK = { home: "/Users/synthetic", username: "synthetic" };
const NOT_FOUND = { exitCode: 113, stdout: "", stderr: 'Could not find service "ai.sharednet.serve" in domain for user gui: 501\n' };

describe("the environment a service keeps", () => {
  it("is the allowlist only: never a harness session variable, a token or an API key", () => {
    const captured = captureServiceEnv(
      {
        PATH: "/opt/homebrew/bin:/usr/bin",
        HOME: "/Users/synthetic",
        USER: "synthetic",
        LOGNAME: "synthetic",
        LANG: "de_DE@euro",
        HTTPS_PROXY: "http://127.0.0.1:10080",
        http_proxy: "http://127.0.0.1:10080",
        NO_PROXY: "localhost,127.0.0.1",
        SHAREDNET_BASE_URL: "https://sharednet.example",
        CODEX_HOME: "/Users/synthetic/.codex",
        CLAUDE_CONFIG_DIR: "/Users/synthetic/.claude-alt",
        XDG_CONFIG_HOME: "/Users/synthetic/.config",
        // A harness's own session, and secrets: none of them is ever written down.
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "6613bb00",
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-token",
        CLAUDE_PID: "4321",
        CODEX_SESSION_ID: "019a-thread",
        CODEX_SANDBOX: "seatbelt",
        ANTHROPIC_API_KEY: "sk-synthetic",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
        OPENAI_API_KEY: "sk-synthetic",
        SHAREDNET_API_KEY: "snk_synthetic",
        SHAREDNET_SEAT: "i_AbCdEfGhIj",
        SHAREDNET_INVITE_TOKEN: "rit_synthetic",
        TERM: "xterm-256color",
      },
      FALLBACK,
    );
    expect(captured.env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/synthetic",
      USER: "synthetic",
      LOGNAME: "synthetic",
      LANG: "de_DE@euro",
      HTTPS_PROXY: "http://127.0.0.1:10080",
      http_proxy: "http://127.0.0.1:10080",
      NO_PROXY: "localhost,127.0.0.1",
      SHAREDNET_BASE_URL: "https://sharednet.example",
      CODEX_HOME: "/Users/synthetic/.codex",
      CLAUDE_CONFIG_DIR: "/Users/synthetic/.claude-alt",
      XDG_CONFIG_HOME: "/Users/synthetic/.config",
    });
    expect(captured.skipped).toEqual([]);
  });

  it("fills in USER and LOGNAME, which `claude auth status` needs to find its keychain item", () => {
    const captured = captureServiceEnv({ PATH: "/usr/bin" }, FALLBACK);
    expect(captured.env).toMatchObject({ HOME: "/Users/synthetic", USER: "synthetic", LOGNAME: "synthetic" });
    expect(captured.filled).toEqual(["HOME", "USER", "LOGNAME"]);
  });

  it("leaves out PATH entries that belong to this process: npx's cache, an npm script's .bin, relative ones", () => {
    const captured = captureServiceEnv(
      {
        PATH: ["/Users/synthetic/.npm/_npx/0a1b2c/node_modules/.bin", "/work/project/node_modules/.bin", "/x/@npmcli/run-script/lib/node-gyp-bin", "relative/bin", "/opt/homebrew/opt/node@22/bin", "/usr/bin", "/usr/bin"].join(":"),
        HOME: "/h",
        USER: "u",
        LOGNAME: "u",
      },
      FALLBACK,
    );
    expect(captured.env.PATH).toBe("/opt/homebrew/opt/node@22/bin:/usr/bin");
    expect(captured.droppedPath).toHaveLength(4);
  });

  it("never keeps an address variable with \"@\" in it, and names it, without its value, for install to refuse", () => {
    const captured = captureServiceEnv(
      {
        PATH: "/usr/bin",
        HOME: "/h",
        USER: "u",
        LOGNAME: "u",
        HTTPS_PROXY: "someone:capture-secret-1@proxy.example:8080",
        http_proxy: "http://DOMAIN\\someone:capture-secret-2@proxy.example:8080",
        ALL_PROXY: "socks5://127.0.0.1:1080",
        NO_PROXY: "localhost",
        SHAREDNET_BASE_URL: "https://a:capture-secret-3@sharednet.example",
      },
      FALLBACK,
    );
    expect(captured.refusedAddresses).toEqual(["HTTPS_PROXY", "http_proxy", "SHAREDNET_BASE_URL"]);
    expect(captured.env).toMatchObject({ ALL_PROXY: "socks5://127.0.0.1:1080", NO_PROXY: "localhost" });
    expect(captured.env.HTTPS_PROXY).toBeUndefined();
    expect(JSON.stringify(captured)).not.toMatch(/capture-secret/);
  });
});

describe("what the service runs", () => {
  it("from npx's cache, is npx itself with sharednet@latest serve --service, never a path into the cache an upgrade replaces", async () => {
    const bin = await binWith("npx", "node");
    const program = serviceProgram({ entry: "/Users/synthetic/.npm/_npx/0a1b2c/node_modules/.bin/sharednet", execPath: "/opt/homebrew/Cellar/node/24.19.0/bin/node", execArgv: [], env: { PATH: bin } });
    expect(program.argv).toEqual([join(bin, "npx"), "-y", "sharednet@latest", "serve", "--service"]);
    expect(program.argv.join(" ")).not.toContain("_npx");
  });

  it("from npx's cache with no npx on PATH, refuses rather than write a definition that will rot", () => {
    expect(() => serviceProgram({ entry: "/Users/synthetic/.npm/_npx/0a1b2c/node_modules/sharednet/bin/sharednet.js", execPath: "/usr/bin/node", execArgv: [], env: { PATH: "" } })).toThrow(/npm install -g sharednet/);
  });

  it("from a global or pinned install, is the node on PATH and that entry file", async () => {
    const bin = await binWith("node");
    expect(serviceProgram({ entry: "/opt/homebrew/lib/node_modules/sharednet/bin/sharednet.js", execPath: "/opt/homebrew/Cellar/node/24.19.0/bin/node", execArgv: [], env: { PATH: bin } }).argv).toEqual([
      join(bin, "node"),
      "/opt/homebrew/lib/node_modules/sharednet/bin/sharednet.js",
      "serve",
      "--service",
    ]);
  });

  it("with no node on the captured PATH, refuses rather than fall back to this process's executable (npx's cache, or a versioned path)", async () => {
    const empty = await binWith("npx");
    for (const execPath of ["/Users/synthetic/.npm/_npx/09ae5d35/node_modules/node/bin/node", "/opt/homebrew/Cellar/node/24.19.0/bin/node"]) {
      expect(() => serviceProgram({ entry: "/opt/homebrew/lib/node_modules/sharednet/bin/sharednet.js", execPath, execArgv: [], env: { PATH: empty } })).toThrow(
        expect.objectContaining({ code: "service_not_installed", message: expect.stringContaining("No node is on the PATH") }),
      );
    }
  });
});

describe("the LaunchAgent", () => {
  it("is started at login and kept alive, logging where serve logs, with its values escaped", () => {
    const argv = ["/opt/homebrew/bin/npx", "-y", "sharednet@latest", "serve", "--service"];
    const plist = launchdPlist({
      label: "ai.sharednet.serve",
      argv,
      env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/synthetic", WEIRD: `a&b<c>"d'%$e` },
      logFile: "/Users/synthetic/.local/state/sharednet/serve.log",
      workingDirectory: "/Users/synthetic",
    });
    expect(plist).toContain("<key>Label</key>\n\t<string>ai.sharednet.serve</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/synthetic\/.local\/state\/sharednet\/serve.log<\/string>/);
    expect(plist).toContain("<string>a&amp;b&lt;c&gt;&quot;d&apos;%$e</string>");
    expect(programIn(plist)).toEqual(argv);
  });

  it("is named for its resolved root: the plain label for the account home's standard root alone", () => {
    expect(serviceLocation("/Users/account/.config/sharednet", "/Users/account")).toEqual({ label: "ai.sharednet.serve", file: "/Users/account/Library/LaunchAgents/ai.sharednet.serve.plist" });
    const other = serviceLocation("/tmp/alternate/.config/sharednet", "/Users/account");
    expect(other.label).toMatch(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/);
    expect(other.file).toBe(`/Users/account/Library/LaunchAgents/${other.label}.plist`);
    expect(serviceLocation("/srv/x/sharednet", "/Users/account").label).not.toBe(other.label);
  });

  it("reads launchd's answer: only its own no-such-service proves absence", () => {
    expect(launchdHolds({ exitCode: 0, stdout: "\tstate = running\n", stderr: "" })).toBe("loaded");
    expect(launchdHolds(NOT_FOUND)).toBe("absent");
    expect(launchdHolds({ exitCode: 1, stdout: "", stderr: "Bad request.\nCould not find service" })).toBe("absent");
    for (const failure of [{ exitCode: 1, stdout: "", stderr: "" }, { exitCode: 5, stdout: "", stderr: "Input/output error" }, { exitCode: -1, stdout: "", stderr: "spawn launchctl ETIMEDOUT" }]) {
      expect(launchdHolds(failure)).toBe("unknown");
    }
  });
});

/** launchd and the disk, scripted; nothing real runs. `files` is the disk; `answers` is launchctl by command prefix. */
function fakeHost(home: string, answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}, platform = "darwin") {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const dirs: string[] = [];
  const failures: { read?: string; remove?: string } = {};
  const host: ServiceHost = {
    platform,
    uid: 501,
    home,
    username: "synthetic",
    readFile: async (path) => {
      if (failures.read === path) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return files.get(path) ?? null;
    },
    writeFile: async (path, content) => void files.set(path, content),
    remove: async (path) => {
      if (failures.remove === path) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      files.delete(path);
    },
    ensureDir: async (path) => void dirs.push(path),
    pause: async () => undefined,
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1] ?? (args[0] === "print" ? NOT_FOUND : { exitCode: 0 });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
  };
  return { host, files, calls, dirs, failures };
}

describe("installing, inspecting and removing it", () => {
  const program = { entry: "/opt/sharednet/bin/sharednet.js", execPath: "/usr/local/bin/node", execArgv: [] as string[] };
  const plistFile = "/Users/synthetic/Library/LaunchAgents/ai.sharednet.serve.plist";

  it("writes the LaunchAgent and bootstraps it, and names the label, file and root, warning about supervisors of one's own", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", USER: "synthetic", LOGNAME: "synthetic", PATH: bin, HTTPS_PROXY: "http://127.0.0.1:10080", CLAUDE_CODE_SESSION_ID: "6613bb00" };
    const { host, files, calls, dirs } = fakeHost("/Users/synthetic");
    const report = await new ServiceControl(env, host, program).install();
    expect(calls).toEqual(["launchctl print gui/501/ai.sharednet.serve", `launchctl bootstrap gui/501 ${plistFile}`]);
    expect(files.get(plistFile)).toContain("<string>--service</string>");
    expect(files.get(plistFile)).not.toContain("6613bb00");
    expect(dirs).toEqual(["/Users/synthetic/.local/state/sharednet"]);
    expect(report).toMatchObject({ installed: true, root: "/Users/synthetic/.config/sharednet", label: "ai.sharednet.serve", file: plistFile, log: "/Users/synthetic/.local/state/sharednet/serve.log" });
    expect(report.warnings).toEqual([expect.stringMatching(/Only SharedNet's own service \(ai\.sharednet\.serve, .*\).*supervisor you manage yourself.*retire it/)]);
  });

  it("refuses when its own plist exists, or launchd holds or cannot deny holding its label, and writes nothing", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    const present = fakeHost("/Users/synthetic");
    present.files.set(plistFile, "<plist/>");
    await expect(new ServiceControl(env, present.host, program).install()).rejects.toMatchObject({
      code: "service_installed",
      message: expect.stringMatching(/storage root \/Users\/synthetic\/\.config\/sharednet is already installed: ai\.sharednet\.serve at .*sharednet serve --uninstall/),
    });
    expect(present.files.get(plistFile)).toBe("<plist/>");
    for (const print of [{ exitCode: 0, stdout: "\tstate = running\n\tpid = 4321\n" }, { exitCode: 5, stderr: "Input/output error" }]) {
      const held = fakeHost("/Users/synthetic", { "launchctl print": print });
      await expect(new ServiceControl(env, held.host, program).install()).rejects.toMatchObject({ code: "service_installed" });
      expect(held.files.size).toBe(0);
      expect(held.calls.some((call) => call.includes("bootstrap"))).toBe(false);
    }
    // An unreadable plist is not an absent one.
    const unreadable = fakeHost("/Users/synthetic");
    unreadable.failures.read = plistFile;
    await expect(new ServiceControl(env, unreadable.host, program).install()).rejects.toThrow(/permission denied/);
    // Another root's service is another label and file: it does not stand in the way.
    const other = fakeHost("/Users/synthetic");
    other.files.set(plistFile, "<plist/>");
    expect(await new ServiceControl({ ...env, XDG_CONFIG_HOME: "/tmp/elsewhere" }, other.host, program).install()).toMatchObject({ root: "/tmp/elsewhere/sharednet", label: expect.stringMatching(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/) });
  });

  it("derives label, file, root and log from one captured environment, and refuses a root variable it cannot carry", async () => {
    const bin = await binWith("node");
    for (const [env, why] of [
      [{ HOME: "/Users/synthetic", PATH: bin, XDG_CONFIG_HOME: "/tmp/odd\nroot" }, "line break"],
      [{ HOME: "/Users/synthetic", PATH: bin, XDG_STATE_HOME: "relative-state" }, "relative"],
      [{ HOME: "/Users/synthetic", PATH: bin, XDG_CONFIG_HOME: "cfg" }, "relative"],
      [{ HOME: "relative/home", PATH: bin }, "relative"],
    ] as const) {
      const { host, files, calls } = fakeHost("/Users/synthetic");
      await expect(new ServiceControl(env, host, program).install(), JSON.stringify(env)).rejects.toMatchObject({ code: "service_not_installed", message: expect.stringContaining(why) });
      expect(files.size).toBe(0);
      expect(calls).toEqual([]);
    }
    // Another HOME is another root, with its own label, and the plist carries exactly what was reported.
    const { host, files } = fakeHost("/Users/account");
    const report = await new ServiceControl({ HOME: "/tmp/alternate", PATH: bin, XDG_STATE_HOME: "/tmp/alternate/state" }, host, program).install();
    expect(report).toMatchObject({ root: "/tmp/alternate/.config/sharednet", label: expect.stringMatching(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/), log: "/tmp/alternate/state/sharednet/serve.log" });
    const plist = files.get(String(report.file))!;
    expect(plist).toContain("<key>HOME</key>\n\t\t<string>/tmp/alternate</string>");
    expect(plist).toContain("<key>StandardOutPath</key>\n\t<string>/tmp/alternate/state/sharednet/serve.log</string>");
    expect(plist).toContain("<key>XDG_CONFIG_HOME</key>\n\t\t<string>/tmp/alternate/.config</string>");
  });

  it("always writes the root-defining variables, so launchd's own domain environment cannot move the service to another root", async () => {
    const bin = await binWith("node");
    const { host, files } = fakeHost("/Users/synthetic");
    // A shell with neither XDG variable: the plist still names both, resolved to what was reported.
    const report = await new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, host, program).install();
    expect(report).toMatchObject({
      root: "/Users/synthetic/.config/sharednet",
      log: "/Users/synthetic/.local/state/sharednet/serve.log",
      env: { HOME: "/Users/synthetic", XDG_CONFIG_HOME: "/Users/synthetic/.config", XDG_STATE_HOME: "/Users/synthetic/.local/state" },
      env_filled_in: expect.arrayContaining(["XDG_CONFIG_HOME", "XDG_STATE_HOME"]),
    });
    const plist = files.get(plistFile)!;
    expect(plist).toContain("<key>XDG_CONFIG_HOME</key>\n\t\t<string>/Users/synthetic/.config</string>");
    expect(plist).toContain("<key>XDG_STATE_HOME</key>\n\t\t<string>/Users/synthetic/.local/state</string>");
  });

  it("refuses to install when any persisted address variable contains \"@\", naming it and never showing its value, and writes nothing", async () => {
    const bin = await binWith("node");
    // No parsing: any literal "@" refuses. Each secret is distinct, so a leak names the form that leaked.
    const corpus: Array<[string, string]> = [
      ["DOMAIN\\user:at-secret-1@proxy.example:8080", "at-secret-1"],
      ["http://DOMAIN\\user:at-secret-2@proxy.example:8080", "at-secret-2"],
      ["//user:at-secret-3@proxy.example:8080", "at-secret-3"],
      ["user:at-secret-4@proxy.example:8080", "at-secret-4"],
      ["http://user:at-secret-5@proxy.example:8080", "at-secret-5"],
      ["http://user:at\\secret-6@proxy.example:8080", "at\\secret-6"],
      ["//at-secret-7@proxy.example:8080", "at-secret-7"],
      ["http://us%40er:at%3Asecret-8@proxy.example:8080", "at%3Asecret-8"],
      ["http://proxy.example/at-secret-9@x", "at-secret-9"],
    ];
    const json = (secret: string) => JSON.stringify(secret).slice(1, -1);
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "SHAREDNET_BASE_URL"]) {
      for (const [value, secret] of corpus) {
        const { host, files, calls, dirs } = fakeHost("/Users/synthetic");
        const error = await new ServiceControl({ HOME: "/Users/synthetic", PATH: bin, HTTPS_PROXY: "http://127.0.0.1:10080", [name]: value }, host, program).install().then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error, `${name}=${value}`).toMatchObject({ code: "install_refused", message: expect.stringContaining(`${name} contains "@"`) });
        // The refusal itself never carries the value, however it is serialized.
        const shown = `${String((error as Error).message)} ${JSON.stringify(error)}`;
        expect(shown, `${name}=${value} in the error`).not.toContain(secret);
        expect(shown, `${name}=${value} in the error, serialized`).not.toContain(json(secret));
        // Refused before anything is written or asked of launchd.
        expect(files.size, `${name}=${value}`).toBe(0);
        expect(dirs).toEqual([]);
        expect(calls).toEqual([]);
      }
    }
    // Several at once are all named.
    const several = fakeHost("/Users/synthetic");
    await expect(new ServiceControl({ HOME: "/Users/synthetic", PATH: bin, HTTPS_PROXY: "u:s1@p", ALL_PROXY: "u:s2@p" }, several.host, program).install()).rejects.toMatchObject({
      message: expect.stringMatching(/^HTTPS_PROXY, ALL_PROXY contain "@"/),
    });
    // Values without "@" still install, and are written as given.
    const { host, files } = fakeHost("/Users/synthetic");
    const clean = { HTTPS_PROXY: "http://127.0.0.1:10080", http_proxy: "//proxy.example:8080", ALL_PROXY: "socks5h://127.0.0.1:1080", all_proxy: "proxy.example:3128", SHAREDNET_BASE_URL: "https://sharednet.example" };
    const report = await new ServiceControl({ HOME: "/Users/synthetic", PATH: bin, ...clean }, host, program).install();
    expect(report).toMatchObject({ installed: true, env: clean });
    for (const [name, value] of Object.entries(clean)) expect(files.get(plistFile)).toContain(`<key>${name}</key>\n\t\t<string>${value}</string>`);
  });

  it("reads back whether it is installed, loaded and running, and with which pid", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    const running = fakeHost("/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = running\n\tpid = 94930\n" } });
    expect(await new ServiceControl(env, running.host, program).state()).toMatchObject({ installed: false, loaded: true, holds: "loaded", running: true, pid: 94930, root: "/Users/synthetic/.config/sharednet" });
    const { host } = fakeHost("/Users/synthetic");
    const control = new ServiceControl(env, host, program);
    await control.install();
    expect(await control.state()).toMatchObject({ installed: true, loaded: false, holds: "absent", program: [join(bin, "node"), program.entry, "serve", "--service"] });
  });

  it("starts an installed service that is not running, and never a second one beside a running one", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    const notLoaded = fakeHost("/Users/synthetic");
    notLoaded.files.set(plistFile, "<plist/>");
    expect(await new ServiceControl(env, notLoaded.host, program).start()).toMatchObject({ ok: true });
    expect(notLoaded.calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${plistFile}`);
    const stopped = fakeHost("/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = not running\n" } });
    stopped.files.set(plistFile, "<plist/>");
    await new ServiceControl(env, stopped.host, program).start();
    expect(stopped.calls.at(-1)).toBe("launchctl kickstart gui/501/ai.sharednet.serve");
    const running = fakeHost("/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = running\n\tpid = 77\n" } });
    running.files.set(plistFile, "<plist/>");
    expect(await new ServiceControl(env, running.host, program).start()).toMatchObject({ ok: true, message: expect.stringContaining("pid 77") });
    expect(running.calls.filter((call) => /kickstart|bootstrap/.test(call))).toEqual([]);
  });

  it("uninstalls only when launchd says the job is gone and the file is verified removed; otherwise keeps the plist and says how to retry", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    // Verified: launchd's no-such-service, then the file gone.
    const ok = fakeHost("/Users/synthetic");
    ok.files.set(plistFile, "<plist/>");
    expect(await new ServiceControl(env, ok.host, program).uninstall()).toMatchObject({ uninstalled: true, root: "/Users/synthetic/.config/sharednet", stopped: true });
    expect(ok.files.size).toBe(0);
    // bootout failed and launchd still has it, or cannot say: the plist stays.
    for (const print of [{ exitCode: 0, stdout: "\tstate = running\n" }, { exitCode: 1, stderr: "" }, { exitCode: -1, stderr: "spawn launchctl ETIMEDOUT" }]) {
      const stuck = fakeHost("/Users/synthetic", { "launchctl bootout": { exitCode: 5, stderr: "Boot-out failed: 5: Input/output error" }, "launchctl print": print });
      stuck.files.set(plistFile, "<plist/>");
      await expect(new ServiceControl(env, stuck.host, program).uninstall()).rejects.toMatchObject({
        code: "service_not_uninstalled",
        message: expect.stringMatching(/left at .*ai\.sharednet\.serve\.plist.*sharednet serve --uninstall again.*launchctl bootout gui\/501\/ai\.sharednet\.serve/s),
      });
      expect(stuck.files.get(plistFile)).toBe("<plist/>");
    }
    // A bootout that succeeded while launchd still tears the job down: it looks again until launchd
    // answers no-such-service (seen for real: print still answered right after bootout returned 0).
    const settling = fakeHost("/Users/synthetic");
    settling.files.set(plistFile, "<plist/>");
    let looks = 0;
    const scripted = settling.host.run;
    settling.host.run = async (command, args) => (args[0] === "print" && ++looks <= 3 ? { exitCode: 0, stdout: "\tstate = running\n", stderr: "" } : scripted(command, args));
    expect(await new ServiceControl(env, settling.host, program).uninstall()).toMatchObject({ uninstalled: true, stopped: true });
    expect(looks).toBe(4);
    expect(settling.files.size).toBe(0);
    // One that never goes is looked at for a bounded time only, then refused with the plist kept.
    const lingering = fakeHost("/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = running\n" } });
    lingering.files.set(plistFile, "<plist/>");
    await expect(new ServiceControl(env, lingering.host, program).uninstall()).rejects.toMatchObject({ code: "service_not_uninstalled", message: expect.stringContaining("still has the job loaded") });
    expect(lingering.calls.filter((call) => call.startsWith("launchctl print")).length).toBe(BOOTOUT_SETTLE_MS / 250 + 1);
    expect(lingering.files.get(plistFile)).toBe("<plist/>");
    // The job is gone but the file will not go, or cannot be read back: no success claimed.
    const pinned = fakeHost("/Users/synthetic");
    pinned.files.set(plistFile, "<plist/>");
    pinned.failures.remove = plistFile;
    await expect(new ServiceControl(env, pinned.host, program).uninstall()).rejects.toMatchObject({ code: "service_not_uninstalled", message: expect.stringContaining("could not be removed") });
    const unreadable = fakeHost("/Users/synthetic");
    unreadable.files.set(plistFile, "<plist/>");
    unreadable.failures.read = plistFile;
    await expect(new ServiceControl(env, unreadable.host, program).uninstall()).rejects.toMatchObject({ code: "service_not_uninstalled" });
  });

  it("refuses Linux and Windows clearly, and reports no service there", async () => {
    for (const [platform, says] of [["linux", "systemd --user support is planned"], ["win32", "Windows"], ["freebsd", "freebsd"]] as const) {
      const { host, calls } = fakeHost("/home/synthetic", {}, platform);
      const control = new ServiceControl({ HOME: "/home/synthetic", PATH: "/usr/bin" }, host, program);
      await expect(control.install()).rejects.toMatchObject({ code: "service_unsupported", message: expect.stringContaining(says) });
      await expect(control.uninstall()).rejects.toMatchObject({ code: "service_unsupported" });
      expect(await control.state()).toBeNull();
      expect(calls).toEqual([]);
    }
  });
});
