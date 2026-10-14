// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureServiceEnv,
  launchdPlist,
  programIn,
  ServiceControl,
  serviceLocation,
  serviceProgram,
  systemdEnvironment,
  systemdExecWord,
  systemdPath,
  systemdUnit,
  userUnitDir,
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

describe("the environment a service keeps", () => {
  it("is the allowlist only: never a harness session variable, a token or an API key", () => {
    const captured = captureServiceEnv(
      {
        PATH: "/opt/homebrew/bin:/usr/bin",
        HOME: "/Users/synthetic",
        USER: "synthetic",
        LOGNAME: "synthetic",
        LANG: "en_US.UTF-8",
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
        XDG_RUNTIME_DIR: "/run/user/501",
        TERM: "xterm-256color",
      },
      FALLBACK,
    );
    expect(captured.env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/synthetic",
      USER: "synthetic",
      LOGNAME: "synthetic",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://127.0.0.1:10080",
      http_proxy: "http://127.0.0.1:10080",
      NO_PROXY: "localhost,127.0.0.1",
      SHAREDNET_BASE_URL: "https://sharednet.example",
      CODEX_HOME: "/Users/synthetic/.codex",
      CLAUDE_CONFIG_DIR: "/Users/synthetic/.claude-alt",
      XDG_CONFIG_HOME: "/Users/synthetic/.config",
    });
    expect(captured.skipped).toEqual([]);
    expect(captured.filled).toEqual([]);
  });

  it("fills in USER and LOGNAME, which `claude auth status` needs to find its keychain item", () => {
    const captured = captureServiceEnv({ PATH: "/usr/bin" }, FALLBACK);
    expect(captured.env).toMatchObject({ HOME: "/Users/synthetic", USER: "synthetic", LOGNAME: "synthetic" });
    expect(captured.filled).toEqual(["HOME", "USER", "LOGNAME"]);
  });

  it("leaves out PATH entries that belong to this process: npx's cache, an npm script's .bin, relative ones", () => {
    const captured = captureServiceEnv(
      {
        PATH: [
          "/Users/synthetic/.npm/_npx/0a1b2c/node_modules/.bin",
          "/work/project/node_modules/.bin",
          "/Users/synthetic/.nvm/versions/node/v24.19.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
          "relative/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
          "/opt/homebrew/bin",
        ].join(":"),
        HOME: "/h",
        USER: "u",
        LOGNAME: "u",
      },
      FALLBACK,
    );
    expect(captured.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(captured.droppedPath).toHaveLength(4);
  });

  it("never writes a proxy that carries a password, and says so", () => {
    const captured = captureServiceEnv(
      { PATH: "/usr/bin", HOME: "/h", USER: "u", LOGNAME: "u", HTTPS_PROXY: "http://someone:synthetic-pass@proxy.example:8080", ALL_PROXY: "socks5://127.0.0.1:1080" },
      FALLBACK,
    );
    expect(captured.env.HTTPS_PROXY).toBeUndefined();
    expect(captured.env.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(captured.skipped).toEqual([{ name: "HTTPS_PROXY", why: expect.stringContaining("password") }]);
    expect(JSON.stringify(captured)).not.toContain("synthetic-pass");
  });
});

describe("what the service runs", () => {
  it("from npx's cache, is npx itself with sharednet@latest, never a path into the cache an upgrade replaces", async () => {
    const bin = await binWith("npx", "node");
    const program = serviceProgram({
      entry: "/Users/synthetic/.npm/_npx/0a1b2c/node_modules/.bin/sharednet",
      execPath: "/opt/homebrew/Cellar/node/24.19.0/bin/node",
      execArgv: [],
      env: { PATH: bin },
    });
    expect(program.via).toBe("npx");
    expect(program.argv).toEqual([join(bin, "npx"), "-y", "sharednet@latest", "serve", "--service"]);
    expect(program.argv.join(" ")).not.toContain("_npx");
  });

  it("from npx's cache with no npx on PATH, refuses rather than write a definition that will rot", () => {
    expect(() =>
      serviceProgram({ entry: "/Users/synthetic/.npm/_npx/0a1b2c/node_modules/sharednet/bin/sharednet.js", execPath: "/usr/bin/node", execArgv: [], env: { PATH: "" } }),
    ).toThrow(/npm install -g sharednet/);
  });

  it("from a global install or a checkout, is the node on PATH and that entry file", async () => {
    const bin = await binWith("node");
    const program = serviceProgram({
      entry: "/opt/homebrew/lib/node_modules/sharednet/bin/sharednet.js",
      execPath: "/opt/homebrew/Cellar/node/24.19.0/bin/node",
      execArgv: [],
      env: { PATH: bin },
    });
    expect(program).toMatchObject({ via: "node", argv: [join(bin, "node"), "/opt/homebrew/lib/node_modules/sharednet/bin/sharednet.js", "serve", "--service"] });
    // Without a node on PATH, the one running now.
    expect(serviceProgram({ entry: "/x/main.js", execPath: "/usr/local/bin/node", execArgv: ["--no-warnings"], env: { PATH: "" } }).argv).toEqual([
      "/usr/local/bin/node",
      "--no-warnings",
      "/x/main.js",
      "serve",
      "--service",
    ]);
  });
});

describe("the service definition", () => {
  const definition = {
    label: "ai.sharednet.serve",
    argv: ["/opt/homebrew/bin/npx", "-y", "sharednet@latest", "serve", "--service"],
    env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/synthetic", HTTPS_PROXY: "http://127.0.0.1:10080", WEIRD: `a&b<c>"d'%$e` },
    logFile: "/Users/synthetic/.local/state/sharednet/serve.log",
    workingDirectory: "/Users/synthetic",
  };

  it("is a LaunchAgent started at login and kept alive, logging where serve logs, with its values escaped", () => {
    const plist = launchdPlist(definition);
    expect(plist).toContain("<key>Label</key>\n\t<string>ai.sharednet.serve</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/synthetic\/.local\/state\/sharednet\/serve.log<\/string>/);
    expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/Users\/synthetic\/.local\/state\/sharednet\/serve.log<\/string>/);
    expect(plist).toContain("<key>HTTPS_PROXY</key>\n\t\t<string>http://127.0.0.1:10080</string>");
    expect(plist).toContain("<string>a&amp;b&lt;c&gt;&quot;d&apos;%$e</string>");
    expect(programIn("launchd", plist)).toEqual(definition.argv);
    // Exactly one <dict> pair for the environment, one for the whole: a well-formed plist shape.
    expect(plist.match(/<dict>/g)).toHaveLength(2);
    expect(plist.match(/<\/dict>/g)).toHaveLength(2);
  });

  it("is a systemd --user unit with the same lifecycle, each directive written the way systemd parses it", () => {
    const unit = systemdUnit({ ...definition, argv: ["/usr/bin/node", "/opt/sharednet/main.js", "serve", "--service"], logFile: "/home/a b/100%/serve.log" });
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/sharednet/main.js" "serve" "--service"');
    // A path setting is never quoted: WorkingDirectory="/tmp" is "not absolute", a fatal error.
    expect(unit).toContain("WorkingDirectory=/Users/synthetic\n");
    expect(unit).not.toMatch(/WorkingDirectory="/);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=30");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("StandardOutput=append:/home/a b/100%%/serve.log");
    expect(unit).toContain("StandardError=append:/home/a b/100%%/serve.log");
    expect(unit).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:10080"');
    // Environment= expands specifiers but never variables: % doubles, $ stays single.
    expect(unit).toContain(`Environment="WEIRD=a&b<c>\\"d'%%$e"`);
    expect(unit).toContain("WantedBy=default.target");
    expect(programIn("systemd", unit)).toEqual(["/usr/bin/node", "/opt/sharednet/main.js", "serve", "--service"]);
  });

  it("formats ExecStart words, Environment assignments and paths each by its own rules, and refuses what none can hold", () => {
    // ExecStart= expands both specifiers and $VARIABLES.
    expect(systemdExecWord(`/opt/a b/100%/$HOME/"q"\\x`)).toBe(`"/opt/a b/100%%/$$HOME/\\"q\\"\\\\x"`);
    expect(programIn("systemd", `ExecStart=${systemdExecWord("/opt/x$y%z")} "serve"`)).toEqual(["/opt/x$y%z", "serve"]);
    expect(systemdEnvironment("PATH", "/a$b:/c%d")).toBe(`"PATH=/a$b:/c%%d"`);
    expect(systemdPath("WorkingDirectory=", "/home/a b/%h")).toBe("/home/a b/%%h");
    expect(() => systemdPath("WorkingDirectory=", "relative")).toThrow(/absolute/);
    expect(() => systemdPath("WorkingDirectory=", " /x")).toThrow(/absolute/);
    expect(() => systemdPath("StandardOutput=", "/x\ny")).toThrow(/line break/);
    expect(() => systemdEnvironment("X", "a\nb")).toThrow(/line break/);
    expect(() => systemdExecWord(";")).toThrow(/;/);
    // Captured values with a line break are left out rather than written.
    expect(captureServiceEnv({ PATH: "/usr/bin", HOME: "/h", USER: "u", LOGNAME: "u", LANG: "x\ny" }, FALLBACK).skipped).toEqual([{ name: "LANG", why: expect.stringContaining("line break") }]);
  });

  it("goes where the user manager reads units: its own search path, not this shell's XDG_CONFIG_HOME", () => {
    // UnitPath as systemd 255 reports it on Ubuntu 24.04 (user 1003).
    const ubuntu =
      "/home/yuchen/.config/systemd/user.control /run/user/1003/systemd/user.control /run/user/1003/systemd/transient /run/user/1003/systemd/generator.early /home/yuchen/.config/systemd/user /etc/xdg/systemd/user /etc/systemd/user /run/user/1003/systemd/user /run/systemd/user /run/user/1003/systemd/generator /home/yuchen/.local/share/systemd/user /usr/local/share/systemd/user /usr/share/systemd/user /usr/local/lib/systemd/user /usr/lib/systemd/user /run/user/1003/systemd/generator.late\n";
    expect(userUnitDir(ubuntu, "/home/yuchen")).toBe("/home/yuchen/.config/systemd/user");
    // A manager started with its own XDG_CONFIG_HOME: its directory, never .control or /run.
    expect(userUnitDir("/home/u/cfg/systemd/user.control /run/user/1/systemd/user /home/u/cfg/systemd/user /home/u/.local/share/systemd/user", "/home/u")).toBe("/home/u/cfg/systemd/user");
    expect(userUnitDir("/etc/systemd/user /usr/lib/systemd/user", "/home/u")).toBeNull();
  });

  it("is named for its storage root: the standard one, or another with its own name so two never collide", () => {
    expect(serviceLocation("darwin", { HOME: "/Users/synthetic" }, "/Users/synthetic")).toEqual({
      kind: "launchd",
      label: "ai.sharednet.serve",
      file: "/Users/synthetic/Library/LaunchAgents/ai.sharednet.serve.plist",
    });
    expect(serviceLocation("darwin", { HOME: "/Users/synthetic", XDG_CONFIG_HOME: "/Users/synthetic/.config" }, "/Users/synthetic")?.label).toBe("ai.sharednet.serve");
    const other = serviceLocation("darwin", { HOME: "/Users/synthetic", XDG_CONFIG_HOME: "/tmp/elsewhere" }, "/Users/synthetic")!;
    expect(other.label).toMatch(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/);
    // The file goes in the account's home, which launchd reads, even when this shell's HOME differs.
    expect(other.file).toBe(`/Users/synthetic/Library/LaunchAgents/${other.label}.plist`);
    expect(serviceLocation("linux", { HOME: "/home/synthetic" }, "/home/synthetic")).toEqual({
      kind: "systemd",
      label: "sharednet-serve.service",
      file: "/home/synthetic/.config/systemd/user/sharednet-serve.service",
    });
    expect(serviceLocation("win32", { HOME: "C:\\Users\\synthetic" }, "/ignored")).toBeNull();
  });
});

/** A service manager that records what it is asked and answers from a script; nothing real runs. */
function fakeHost(platform: NodeJS.Platform, home: string, answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const dirs: string[] = [];
  const host: ServiceHost = {
    platform,
    uid: 501,
    home,
    username: "synthetic",
    readFile: async (path) => files.get(path) ?? null,
    listDir: async (path) => [...files.keys()].filter((file) => dirname(file) === path).map((file) => file.slice(path.length + 1)),
    writeFile: async (path, content) => void files.set(path, content),
    remove: async (path) => files.delete(path),
    ensureDir: async (path) => void dirs.push(path),
    sleep: async () => undefined,
    run: async (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1] ?? { exitCode: 0 };
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
  };
  return { host, files, calls, dirs };
}

describe("installing, inspecting and removing it", () => {
  const program = { entry: "/opt/sharednet/bin/sharednet.js", execPath: "/usr/local/bin/node", execArgv: [] as string[] };

  it("on macOS writes the LaunchAgent and bootstraps it into the login session, replacing one already loaded", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", USER: "synthetic", LOGNAME: "synthetic", PATH: bin, HTTPS_PROXY: "http://127.0.0.1:10080", CLAUDE_CODE_SESSION_ID: "6613bb00" };
    const { host, files, calls, dirs } = fakeHost("darwin", "/Users/synthetic");
    const report = await new ServiceControl(env, host, program).install();
    const file = "/Users/synthetic/Library/LaunchAgents/ai.sharednet.serve.plist";
    expect(calls).toEqual(["launchctl bootout gui/501/ai.sharednet.serve", `launchctl bootstrap gui/501 ${file}`]);
    expect(files.get(file)).toContain("<string>--service</string>");
    expect(files.get(file)).not.toContain("6613bb00");
    expect(dirs).toEqual(["/Users/synthetic/.local/state/sharednet"]);
    expect(report).toMatchObject({ installed: true, manager: "launchd", label: "ai.sharednet.serve", file, log: "/Users/synthetic/.local/state/sharednet/serve.log" });
    expect(report.warnings).toBeUndefined();
  });

  it("waits out a bootout launchd has not finished before it bootstraps again", async () => {
    const bin = await binWith("node");
    let refusals = 2;
    const { host, calls } = fakeHost("darwin", "/Users/synthetic");
    const run = host.run;
    host.run = async (command, args) => {
      if (args[0] === "bootstrap" && refusals-- > 0) {
        calls.push([command, ...args].join(" "));
        return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return run(command, args);
    };
    await new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, host, program).install();
    expect(calls.filter((call) => call.includes("bootstrap"))).toHaveLength(3);
  });

  it("says plainly when launchd refuses it, and warns when no proxy was there to keep", async () => {
    const bin = await binWith("node");
    const { host } = fakeHost("darwin", "/Users/synthetic", {
      "launchctl bootout": { exitCode: 3, stderr: "Boot-out failed: 3: No such process" },
      "launchctl bootstrap": { exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error" },
    });
    await expect(new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, host, program).install()).rejects.toMatchObject({ code: "service_not_loaded" });

    const ok = fakeHost("darwin", "/Users/synthetic");
    const report = await new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, ok.host, program).install();
    expect(report.warnings).toEqual([expect.stringContaining("No proxy variable")]);
  });

  it("reads back whether it is installed, loaded and running, and with which pid", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    const { host, files } = fakeHost("darwin", "/Users/synthetic", {
      "launchctl print": { exitCode: 0, stdout: "gui/501/ai.sharednet.serve = {\n\tactive count = 1\n\tstate = running\n\tpid = 94930\n\tprogram = /usr/local/bin/node\n}\n" },
    });
    const control = new ServiceControl(env, host, program);
    expect(await control.state()).toMatchObject({ installed: false, loaded: true, running: true, pid: 94930 });
    await control.install();
    expect(await control.state()).toMatchObject({ installed: true, program: [join(bin, "node"), program.entry, "serve", "--service"] });
    expect(files.size).toBe(1);

    const gone = fakeHost("darwin", "/Users/synthetic", { "launchctl print": { exitCode: 113, stderr: "Could not find service" } });
    expect(await new ServiceControl(env, gone.host, program).state()).toMatchObject({ installed: false, loaded: false, running: false });
  });

  it("starts an installed service that is not running, and never a second one beside a running one", async () => {
    const bin = await binWith("node");
    const env = { HOME: "/Users/synthetic", PATH: bin };
    const file = "/Users/synthetic/Library/LaunchAgents/ai.sharednet.serve.plist";

    const notLoaded = fakeHost("darwin", "/Users/synthetic", { "launchctl print": { exitCode: 113 } });
    notLoaded.files.set(file, "<plist/>");
    expect(await new ServiceControl(env, notLoaded.host, program).start()).toMatchObject({ ok: true });
    expect(notLoaded.calls.at(-1)).toBe(`launchctl bootstrap gui/501 ${file}`);

    const stopped = fakeHost("darwin", "/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = not running\n" } });
    stopped.files.set(file, "<plist/>");
    await new ServiceControl(env, stopped.host, program).start();
    expect(stopped.calls.at(-1)).toBe("launchctl kickstart gui/501/ai.sharednet.serve");

    const running = fakeHost("darwin", "/Users/synthetic", { "launchctl print": { exitCode: 0, stdout: "\tstate = running\n\tpid = 77\n" } });
    running.files.set(file, "<plist/>");
    expect(await new ServiceControl(env, running.host, program).start()).toMatchObject({ ok: true, message: expect.stringContaining("pid 77") });
    expect(running.calls.filter((call) => call.includes("kickstart") || call.includes("bootstrap"))).toEqual([]);

    const none = fakeHost("darwin", "/Users/synthetic", { "launchctl print": { exitCode: 113 } });
    expect(await new ServiceControl(env, none.host, program).start()).toEqual({ ok: false, message: "no service is installed" });
  });

  it("uninstalls by booting it out and removing the file", async () => {
    const bin = await binWith("node");
    const { host, files, calls } = fakeHost("darwin", "/Users/synthetic");
    const control = new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, host, program);
    await control.install();
    calls.length = 0;
    expect(await control.uninstall()).toMatchObject({ uninstalled: true, stopped: true, removed: true });
    expect(calls).toEqual(["launchctl bootout gui/501/ai.sharednet.serve"]);
    expect(files.size).toBe(0);
  });

  it("on Linux writes a systemd --user unit, enables and restarts it, and notes lingering", async () => {
    const bin = await binWith("node");
    const unitPath = "systemctl --user show --property=UnitPath --value";
    const { host, files, calls } = fakeHost("linux", "/home/synthetic", {
      [unitPath]: { exitCode: 0, stdout: "/home/synthetic/.config/systemd/user.control /home/synthetic/.config/systemd/user /etc/systemd/user\n" },
      "loginctl show-user synthetic": { exitCode: 0, stdout: "Linger=no\n" },
      "systemctl --user show sharednet-serve.service": { exitCode: 0, stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=4242\n" },
    });
    // This shell points XDG_CONFIG_HOME elsewhere; the unit still goes where the manager reads units.
    const control = new ServiceControl({ HOME: "/home/synthetic", USER: "synthetic", PATH: bin, XDG_CONFIG_HOME: "/home/synthetic/.config" }, host, program);
    const report = await control.install();
    expect(calls).toEqual([
      unitPath,
      unitPath,
      "systemctl --user daemon-reload",
      "systemctl --user enable sharednet-serve.service",
      "systemctl --user restart sharednet-serve.service",
      "loginctl show-user synthetic --property=Linger",
    ]);
    expect(files.get("/home/synthetic/.config/systemd/user/sharednet-serve.service")).toContain("Restart=always");
    expect(report.linger).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Lingering is off for synthetic"), expect.stringContaining("sudo loginctl enable-linger synthetic")]));
    expect(calls.some((call) => call.startsWith("sudo"))).toBe(false);
    expect(await control.state()).toMatchObject({ kind: "systemd", installed: true, loaded: true, running: true, pid: 4242 });
    calls.length = 0;
    await control.uninstall();
    expect(calls).toEqual([unitPath, "systemctl --user disable --now sharednet-serve.service", "systemctl --user daemon-reload"]);

    // With lingering on, there is nothing to say about it.
    const lingering = fakeHost("linux", "/home/synthetic", { "loginctl show-user": { exitCode: 0, stdout: "Linger=yes\n" } });
    const quiet = await new ServiceControl({ HOME: "/home/synthetic", USER: "synthetic", PATH: bin, HTTPS_PROXY: "http://127.0.0.1:1" }, lingering.host, program).install();
    expect(quiet).toMatchObject({ linger: true });
    expect(quiet.warnings).toBeUndefined();
  });

  it("on Linux writes into the manager's own unit directory when it is not ~/.config", async () => {
    const bin = await binWith("node");
    const { host, files } = fakeHost("linux", "/home/synthetic", {
      "systemctl --user show --property=UnitPath": { exitCode: 0, stdout: "/home/synthetic/cfg/systemd/user.control /run/user/1/systemd/user /home/synthetic/cfg/systemd/user\n" },
      "loginctl": { exitCode: 0, stdout: "Linger=yes\n" },
    });
    const report = await new ServiceControl({ HOME: "/home/synthetic", USER: "synthetic", PATH: bin }, host, program).install();
    expect(report.file).toBe("/home/synthetic/cfg/systemd/user/sharednet-serve.service");
    expect(files.has("/home/synthetic/cfg/systemd/user/sharednet-serve.service")).toBe(true);
  });

  it("refuses to install beside another definition that respawns serve, naming the command that stops it, and touches nothing", async () => {
    const bin = await binWith("node");
    const agents = "/Users/synthetic/Library/LaunchAgents";
    // As found on a real machine: a hand-made supervisor that restarts serve whenever it is gone.
    const supervisor = `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>ai.sharednet.listener-supervisor</string><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>/Users/synthetic/.local/share/sharednet/bin/supervise.py</string></array><key>KeepAlive</key><true/></dict></plist>`;
    const { host, files, calls } = fakeHost("darwin", "/Users/synthetic");
    files.set(`${agents}/ai.sharednet.listener-supervisor.plist`, supervisor);
    files.set(`${agents}/com.example.backup.plist`, "<plist><dict><key>Label</key><string>com.example.backup</string></dict></plist>");
    // This service for another storage root: its own slot, no conflict.
    files.set(
      `${agents}/ai.sharednet.serve.0a1b2c3d.plist`,
      "<plist><dict><key>Label</key><string>ai.sharednet.serve.0a1b2c3d</string><key>ProgramArguments</key><array><string>sharednet serve --service</string></array><key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><string>/tmp/third</string></dict></dict></plist>",
    );
    const control = new ServiceControl({ HOME: "/Users/synthetic", PATH: bin }, host, program);
    expect(await control.conflicts()).toEqual([
      { label: "ai.sharednet.listener-supervisor", file: `${agents}/ai.sharednet.listener-supervisor.plist`, stop: "launchctl bootout gui/501/ai.sharednet.listener-supervisor" },
    ]);
    await expect(control.install()).rejects.toMatchObject({ code: "service_conflict", message: expect.stringContaining("launchctl bootout gui/501/ai.sharednet.listener-supervisor") });
    expect(calls).toEqual([]);
    expect(files.has(`${agents}/ai.sharednet.serve.plist`)).toBe(false);
    expect(files.get(`${agents}/ai.sharednet.listener-supervisor.plist`)).toBe(supervisor);

    // Installing for another storage root, the same supervisor (which runs with the default root) is no
    // conflict, and the default root's service is not either; a supervisor for that root is.
    const elsewhere = { HOME: "/Users/synthetic", PATH: bin, XDG_CONFIG_HOME: "/tmp/elsewhere" };
    files.set(`${agents}/ai.sharednet.serve.plist`, "<plist><dict><key>Label</key><string>ai.sharednet.serve</string><key>ProgramArguments</key><array><string>npx</string><string>sharednet@latest</string><string>serve</string></array></dict></plist>");
    expect(await new ServiceControl(elsewhere, host, program).conflicts()).toEqual([]);
    files.set(
      `${agents}/com.example.sharednet-elsewhere.plist`,
      "<plist><dict><key>Label</key><string>com.example.sharednet-elsewhere</string><key>ProgramArguments</key><array><string>/usr/local/bin/sharednet</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><string>/tmp/elsewhere</string></dict></dict></plist>",
    );
    expect((await new ServiceControl(elsewhere, host, program).conflicts()).map((other) => other.label)).toEqual(["com.example.sharednet-elsewhere"]);
    // ...and the default root still sees only its own supervisor, not the one for /tmp/elsewhere.
    expect((await control.conflicts()).map((other) => other.label)).toEqual(["ai.sharednet.listener-supervisor"]);

    const linux = fakeHost("linux", "/home/synthetic");
    linux.files.set("/home/synthetic/.config/systemd/user/sharednet-listener.service", "[Service]\nExecStart=/usr/bin/npx -y sharednet@latest serve\n");
    linux.files.set("/home/synthetic/.config/systemd/user/sharednet-other.service", '[Service]\nEnvironment="XDG_CONFIG_HOME=/srv/other" "PATH=/usr/bin"\nExecStart=/usr/bin/npx -y sharednet@latest serve\n');
    expect((await new ServiceControl({ HOME: "/home/synthetic", PATH: bin }, linux.host, program).conflicts()).map((other) => other.stop)).toEqual([
      "systemctl --user disable --now sharednet-listener.service",
    ]);
    expect((await new ServiceControl({ HOME: "/home/synthetic", PATH: bin, XDG_CONFIG_HOME: "/srv/other" }, linux.host, program).conflicts()).map((other) => other.label)).toEqual([
      "sharednet-other.service",
    ]);
  });

  it("refuses Windows, and other systems, clearly", async () => {
    const { host } = fakeHost("win32", "C:\\Users\\synthetic");
    const control = new ServiceControl({ HOME: "C:\\Users\\synthetic", PATH: "" }, host, program);
    await expect(control.install()).rejects.toMatchObject({ code: "service_unsupported", message: expect.stringContaining("Windows") });
    expect(await control.state()).toBeNull();
    const bsd = fakeHost("freebsd", "/home/synthetic");
    await expect(new ServiceControl({ HOME: "/home/synthetic" }, bsd.host, program).uninstall()).rejects.toMatchObject({ code: "service_unsupported" });
  });

  it("refuses without HOME or PATH to run in", async () => {
    const { host } = fakeHost("darwin", "");
    await expect(new ServiceControl({}, host, program).install()).rejects.toMatchObject({ code: "service_not_installed" });
  });

  it("is written into the storage root the CLI uses, the same one serve locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-service-root-"));
    cleanup.push(root);
    await mkdir(join(root, "config"), { recursive: true });
    const bin = await binWith("node");
    const { host, files } = fakeHost("darwin", root);
    const report = await new ServiceControl({ HOME: root, PATH: bin, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }, host, program).install();
    expect(report.log).toBe(join(root, "state", "sharednet", "serve.log"));
    expect(String(report.label)).toMatch(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/);
    const plist = [...files.values()][0]!;
    expect(plist).toContain(`<key>XDG_CONFIG_HOME</key>\n\t\t<string>${join(root, "config")}</string>`);
  });
});

/**
 * systemd's own parser, where it exists: whether a unit loads is what the tests above cannot prove. On Linux CI
 * (ubuntu, systemd 255) it is required, so a missing systemd-analyze fails rather than skips.
 */
const analyzer = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
const hasAnalyzer = analyzer.status === 0;
const analyzerRequired = (process.platform === "linux" && Boolean(process.env.CI)) || process.env.SHAREDNET_REQUIRE_SYSTEMD_ANALYZE === "1";

function verifyUnit(file: string): { status: number | null; output: string } {
  // A user manager needs XDG_RUNTIME_DIR; without one (a CI runner), the system-mode parser reads the same directives.
  let result = spawnSync("systemd-analyze", ["--user", "verify", file], { encoding: "utf8" });
  if (result.status !== 0 && /Failed to initialize manager/.test(`${result.stderr}${result.stdout}`)) {
    result = spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.runIf(hasAnalyzer || analyzerRequired)("the unit in systemd's own parser (systemd-analyze verify)", () => {
  async function unitFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sharednet-unit-"));
    cleanup.push(dir);
    const file = join(dir, "sharednet-serve-verify.service");
    await writeFile(file, content);
    return file;
  }

  it("loads, with spaces, %, $, quotes and backslashes in every directive", async () => {
    expect(hasAnalyzer, `systemd-analyze is required here: ${analyzer.error ?? analyzer.stderr}`).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "sharednet-unit work %h "));
    cleanup.push(dir);
    const unit = systemdUnit({
      label: "sharednet-serve-verify.service",
      argv: [process.execPath, "-e", `0 // $HOME %h "q" \\x`],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HTTPS_PROXY: "http://127.0.0.1:10080", ODD: `a$b%c "q" \\back` },
      logFile: join(dir, "log 100%", "serve.log"),
      workingDirectory: dir.replace(/\/$/, ""),
    });
    const file = await unitFile(unit);
    const verified = verifyUnit(file);
    expect(verified.output).not.toMatch(/sharednet-serve-verify/);
    expect(verified.status).toBe(0);
  });

  it("refuses what the first version wrote (a quoted WorkingDirectory), so a pass above means something", async () => {
    const unit = systemdUnit({ label: "x.service", argv: [process.execPath], env: {}, logFile: "/tmp/serve.log", workingDirectory: "/tmp" }).replace(
      "WorkingDirectory=/tmp",
      'WorkingDirectory="/tmp"',
    );
    const verified = verifyUnit(await unitFile(unit));
    expect(verified.status).not.toBe(0);
    expect(verified.output).toMatch(/WorkingDirectory= path is not absolute/);
  });
});
