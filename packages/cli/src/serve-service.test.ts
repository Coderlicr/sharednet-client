// @vitest-environment node

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureServiceEnv,
  launchdPlist,
  programIn,
  ServiceControl,
  serviceLocation,
  serviceProgram,
  systemdUnit,
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

  it("is a systemd --user unit with the same lifecycle, its words quoted and its specifiers escaped", () => {
    const unit = systemdUnit({ ...definition, argv: ["/usr/bin/node", "/opt/sharednet/main.js", "serve", "--service"] });
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/sharednet/main.js" "serve" "--service"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=30");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("StandardOutput=append:/Users/synthetic/.local/state/sharednet/serve.log");
    expect(unit).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:10080"');
    expect(unit).toContain(`Environment="WEIRD=a&b<c>\\"d'%%$$e"`);
    expect(unit).toContain("WantedBy=default.target");
    expect(programIn("systemd", unit)).toEqual(["/usr/bin/node", "/opt/sharednet/main.js", "serve", "--service"]);
  });

  it("is named for its storage root: the standard one, or another with its own name so two never collide", () => {
    expect(serviceLocation("darwin", { HOME: "/Users/synthetic" }, "/ignored")).toEqual({
      kind: "launchd",
      label: "ai.sharednet.serve",
      file: "/Users/synthetic/Library/LaunchAgents/ai.sharednet.serve.plist",
    });
    expect(serviceLocation("darwin", { HOME: "/Users/synthetic", XDG_CONFIG_HOME: "/Users/synthetic/.config" }, "/ignored")?.label).toBe("ai.sharednet.serve");
    const other = serviceLocation("darwin", { HOME: "/Users/synthetic", XDG_CONFIG_HOME: "/tmp/elsewhere" }, "/ignored")!;
    expect(other.label).toMatch(/^ai\.sharednet\.serve\.[0-9a-f]{8}$/);
    expect(serviceLocation("linux", { HOME: "/home/synthetic" }, "/ignored")).toEqual({
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
    const { host, files, calls } = fakeHost("linux", "/home/synthetic", {
      "systemctl --user show": { exitCode: 0, stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=4242\n" },
    });
    const control = new ServiceControl({ HOME: "/home/synthetic", USER: "synthetic", PATH: bin }, host, program);
    const report = await control.install();
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable sharednet-serve.service", "systemctl --user restart sharednet-serve.service"]);
    expect(files.get("/home/synthetic/.config/systemd/user/sharednet-serve.service")).toContain("Restart=always");
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("loginctl enable-linger synthetic")]));
    expect(await control.state()).toMatchObject({ kind: "systemd", installed: true, loaded: true, running: true, pid: 4242 });
    calls.length = 0;
    await control.uninstall();
    expect(calls).toEqual(["systemctl --user disable --now sharednet-serve.service", "systemctl --user daemon-reload"]);
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
