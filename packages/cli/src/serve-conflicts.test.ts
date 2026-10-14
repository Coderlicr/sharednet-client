// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  launchdOverrides,
  launchdPrintEnvironment,
  parseShowEnvironment,
  parseSystemctlShow,
  plistEnvironment,
  rootFrom,
  systemctlShowWords,
  systemdUnitRoot,
} from "./serve-conflicts.ts";
import { ServiceControl, type ServiceHost } from "./serve-service.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function binWithNode(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "sharednet-conflicts-bin-"));
  cleanup.push(bin);
  await writeFile(join(bin, "node"), "#!/bin/sh\n");
  await chmod(join(bin, "node"), 0o755);
  return bin;
}

const program = { entry: "/opt/sharednet/bin/sharednet.js", execPath: "/usr/local/bin/node", execArgv: [] as string[] };

type Answer = { exitCode: number; stdout?: string; stderr?: string };

/** A host whose files and manager answers are scripted; `handle` may answer any command first. */
function fakeHost(platform: NodeJS.Platform, home: string, handle: (command: string, args: string[]) => Answer | undefined = () => undefined) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const host: ServiceHost = {
    platform,
    uid: 501,
    home,
    username: "synthetic",
    readFile: async (path) => files.get(path) ?? null,
    listDir: async (path) => [...files.keys()].filter((file) => dirname(file) === path).map((file) => file.slice(path.length + 1)),
    writeFile: async (path, content) => void files.set(path, content),
    remove: async (path) => files.delete(path),
    ensureDir: async () => undefined,
    sleep: async () => undefined,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      const answer = handle(command, args) ?? { exitCode: 0 };
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    },
  };
  return { host, files, calls };
}

// ---------------------------------------------------------------------------------------------
// systemd: fixtures in the form systemd 255 prints them. The first two blocks are output captured on
// Ubuntu 24.04 (systemd 255.4-1ubuntu8.17) from probe units placed in the user manager's runtime
// directory, never enabled or started, and removed afterwards; the user is renamed to synthetic.

const CAPTURED_SHOW = `ExecStart={ path=/usr/bin/env ; argv[]=/usr/bin/env -i sharednet serve --service ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }
Environment=OTHER=x XDG_CONFIG_HOME=/srv/other "SPACED=a b" "QUOTED=c\\"d" "DOLLAR=\\$x" PCT=1%
PassEnvironment=HOME LANG
UnsetEnvironment=
WorkingDirectory=!/home/synthetic
Id=sn-probe-a.service
Triggers=
TriggeredBy=
Description=sharednet probe a
LoadState=loaded
ActiveState=inactive
FragmentPath=/run/user/1000/systemd/user/sn-probe-a.service
DropInPaths=
UnitFileState=static

ExecStart={ path=/usr/bin/npx ; argv[]=/usr/bin/npx -y sharednet@latest serve --rooms all ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }
Environment=
EnvironmentFiles=/home/synthetic/.sn-probe.env (ignore_errors=yes)
PassEnvironment=
UnsetEnvironment=
WorkingDirectory=!/home/synthetic
Id=sn-probe-c.service
Triggers=
TriggeredBy=
Description=sharednet probe c
LoadState=loaded
ActiveState=inactive
FragmentPath=/run/user/1000/systemd/user/sn-probe-c.service
DropInPaths=
UnitFileState=static

Unit=sn-probe-c.service
Id=sn-probe-b.timer
Triggers=sn-probe-c.service
TriggeredBy=
Description=sharednet probe b
LoadState=loaded
ActiveState=inactive
FragmentPath=/run/user/1000/systemd/user/sn-probe-b.timer
DropInPaths=/run/user/1000/systemd/user/sn-probe-b.timer.d/override.conf
UnitFileState=static
`;

/** The unit file behind sn-probe-a: a continuation across a comment block (review 4, item 1). */
const PROBE_A_FILE = `[Service]
ExecStart=/usr/bin/env -i sharednet serve --service
Environment=OTHER=x \\
# ignored
 XDG_CONFIG_HOME=/srv/other
`;

const MANAGER_ENV = "HOME=/home/synthetic\nLANG=C.UTF-8\nLOGNAME=synthetic\nPATH=/usr/local/bin:/usr/bin:/bin\nSHELL=/bin/bash\nUSER=synthetic\nXDG_RUNTIME_DIR=/run/user/1000\n";

type Unit = Record<string, string>;

/** A systemd --user manager answering list-unit-files, list-units, show and show-environment from `units`. */
function systemd(units: Unit[], options: { managerEnv?: string | null; listFails?: boolean } = {}) {
  const byId = new Map(units.map((unit) => [unit.Id!, unit]));
  return (command: string, args: string[]): Answer | undefined => {
    if (command !== "systemctl") return undefined;
    const [, verb] = args;
    if (verb === "list-unit-files") return options.listFails ? { exitCode: 1, stderr: "Failed to connect to bus" } : { exitCode: 0, stdout: units.map((unit) => `${unit.Id} ${unit.UnitFileState || "static"} -`).join("\n") };
    if (verb === "list-units") return { exitCode: 0, stdout: units.filter((unit) => unit.ActiveState === "active").map((unit) => `${unit.Id} loaded active running x`).join("\n") };
    if (verb === "show-environment") return options.managerEnv === null ? { exitCode: 1 } : { exitCode: 0, stdout: options.managerEnv ?? MANAGER_ENV };
    if (verb === "show" && args.some((arg) => arg.startsWith("--property=Id"))) {
      const ids = args.slice(4);
      return { exitCode: 0, stdout: ids.map((id) => Object.entries({ Id: id, LoadState: byId.has(id) ? "loaded" : "not-found", ...(byId.get(id) ?? {}) }).map(([key, value]) => `${key}=${value}`).join("\n")).join("\n\n") };
    }
    return undefined;
  };
}

describe("reading the manager's own answers", () => {
  it("takes systemd's effective Environment= from systemctl show, continuation across comments and all", () => {
    const shown = parseSystemctlShow(CAPTURED_SHOW);
    expect([...shown.keys()]).toEqual(["sn-probe-a.service", "sn-probe-c.service", "sn-probe-b.timer"]);
    expect(systemctlShowWords(shown.get("sn-probe-a.service")!.Environment!)).toEqual(["OTHER=x", "XDG_CONFIG_HOME=/srv/other", "SPACED=a b", 'QUOTED=c"d', "DOLLAR=$x", "PCT=1%"]);
    // Review 4, item 1: the file continues `Environment=OTHER=x \` across `# ignored`; systemd says /srv/other.
    expect(systemdUnitRoot(shown.get("sn-probe-a.service")!, parseShowEnvironment(MANAGER_ENV), "/home/synthetic")).toEqual({ root: "/srv/other/sharednet" });
    // An EnvironmentFile= is never read here: unresolved.
    expect(systemdUnitRoot(shown.get("sn-probe-c.service")!, parseShowEnvironment(MANAGER_ENV), "/home/synthetic")).toEqual({ unresolved: expect.stringContaining("EnvironmentFile=") });
    // Review 4, item 2: a timer's target after its drop-ins is the manager's Triggers=.
    expect(shown.get("sn-probe-b.timer")).toMatchObject({ Triggers: "sn-probe-c.service", DropInPaths: expect.stringContaining("override.conf") });
    expect(systemctlShowWords('A=1 "B=x')).toBeNull();
    expect(systemctlShowWords('A="1"')).toBeNull();
  });

  it("resolves a unit's root over the manager's environment, and refuses what it cannot know", () => {
    const manager = parseShowEnvironment(`${MANAGER_ENV}XDG_CONFIG_HOME=/srv/managed\n`);
    expect(systemdUnitRoot({ Environment: "" }, manager, "/home/synthetic")).toEqual({ root: "/srv/managed/sharednet" });
    expect(systemdUnitRoot({ Environment: "XDG_CONFIG_HOME=/srv/own" }, manager, "/home/synthetic")).toEqual({ root: "/srv/own/sharednet" });
    // The manager's environment could not be read: only a unit that sets both itself is resolved.
    expect(systemdUnitRoot({ Environment: "" }, null, "/home/synthetic")).toEqual({ unresolved: expect.stringContaining("show-environment") });
    expect(systemdUnitRoot({ Environment: "HOME=/home/x XDG_CONFIG_HOME=/srv/both" }, null, "/home/synthetic")).toEqual({ root: "/srv/both/sharednet" });
    expect(systemdUnitRoot({ Environment: "", UnsetEnvironment: "XDG_CONFIG_HOME" }, manager, "/home/synthetic")).toEqual({ unresolved: expect.stringContaining("UnsetEnvironment") });
    expect(systemdUnitRoot({ Environment: "HOME=relative" }, manager, "/home/synthetic")).toEqual({ unresolved: expect.stringContaining("relative") });
    expect(parseShowEnvironment("HOME=$'/home/\\nx'\n")).toBeNull();
    expect(rootFrom({}, "/home/synthetic")).toEqual({ root: "/home/synthetic/.config/sharednet" });
    expect(rootFrom({ XDG_CONFIG_HOME: "cfg" }, "/home/synthetic")).toEqual({ unresolved: expect.stringContaining("relative") });
  });

  it("takes a loaded launchd job's environment from launchctl print, and the override's tri-state from print-disabled", () => {
    // The shape `launchctl print gui/<uid>/<label>` prints (macOS 26), trimmed.
    const printed = `gui/501/com.example.sharednet = {
\tactive count = 1
\tstate = running

\tinherited environment = {
\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.x/Listeners
\t}

\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tenvironment = {
\t\tPATH => /opt/homebrew/bin:/usr/bin
\t\tXDG_CONFIG_HOME => /tmp/elsewhere
\t}

\tpid = 80225
}
`;
    expect(launchdPrintEnvironment(printed)).toEqual({ SSH_AUTH_SOCK: "/var/run/com.apple.launchd.x/Listeners", PATH: "/opt/homebrew/bin:/usr/bin", XDG_CONFIG_HOME: "/tmp/elsewhere" });
    const overrides = launchdOverrides('\tdisabled services = {\n\t\t"a" => enabled\n\t\t"b" => disabled\n\t\t"c" => true\n\t\t"d" => false\n\t}\n');
    expect([...overrides]).toEqual([["a", "enabled"], ["b", "disabled"], ["c", "disabled"], ["d", "enabled"]]);
    expect(plistEnvironment("<plist><dict><key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><string>&#47;srv&#x2F;e</string></dict></dict></plist>")).toEqual({ XDG_CONFIG_HOME: "/srv/e" });
    expect(plistEnvironment("<plist><dict><key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><integer>1</integer></dict></dict></plist>")).toBeNull();
  });
});

describe("conflicts under systemd --user, as the manager reports them", () => {
  const home = "/home/synthetic";
  const exec = (args: string) => `{ path=/usr/bin/npx ; argv[]=/usr/bin/npx ${args} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const service = (id: string, extra: Unit = {}): Unit => ({
    Id: id,
    Description: "x",
    ExecStart: exec("-y sharednet@latest serve"),
    Environment: "",
    EnvironmentFiles: "",
    UnsetEnvironment: "",
    FragmentPath: `${home}/.config/systemd/user/${id}`,
    DropInPaths: "",
    Triggers: "",
    UnitFileState: "enabled",
    ActiveState: "active",
    ...extra,
  });
  const control = async (units: Unit[], env: Record<string, string> = {}, options: Parameters<typeof systemd>[1] = {}) => {
    const fake = fakeHost("linux", home, systemd(units, options));
    return { fake, control: new ServiceControl({ HOME: home, PATH: await binWithNode(), ...env }, fake.host, program) };
  };

  it("review 4, item 1: a continuation across a comment resolves as systemd resolves it", async () => {
    const units = [service("sharednet-a.service", { Environment: "OTHER=x XDG_CONFIG_HOME=/srv/other", FragmentPath: `${home}/.config/systemd/user/sharednet-a.service` })];
    const { fake, control: there } = await control(units, { XDG_CONFIG_HOME: "/srv/other" });
    fake.files.set(`${home}/.config/systemd/user/sharednet-a.service`, PROBE_A_FILE);
    expect((await there.conflicts()).map((found) => found.label)).toEqual(["sharednet-a.service"]);
    const { control: standard } = await control(units);
    expect(await standard.conflicts()).toEqual([]);
  });

  it("review 4, item 2: a timer whose Unit= comes from a drop-in makes its static target block", async () => {
    const units = [
      service("sharednet-listener.service", { UnitFileState: "static", ActiveState: "inactive" }),
      {
        Id: "sharednet-poll.timer",
        Description: "poll",
        Triggers: "sharednet-listener.service",
        FragmentPath: `${home}/.config/systemd/user/sharednet-poll.timer`,
        DropInPaths: `${home}/.config/systemd/user/sharednet-poll.timer.d/override.conf`,
        UnitFileState: "enabled",
        ActiveState: "active",
      },
    ];
    const { control: here } = await control(units);
    expect(await here.conflicts()).toEqual([
      expect.objectContaining({
        label: "sharednet-listener.service",
        blocking: true,
        why: expect.stringContaining("sharednet-poll.timer is enabled and active"),
        stop: "systemctl --user disable --now sharednet-poll.timer sharednet-listener.service",
      }),
    ]);
  });

  it("review 4, item 3: an enabled unit anywhere on the manager's search path is seen, not only in one directory", async () => {
    const units = [service("sharednet-data.service", { FragmentPath: `${home}/.local/share/systemd/user/sharednet-data.service`, UnitFileState: "enabled", ActiveState: "inactive" })];
    const { control: here } = await control(units);
    expect(await here.conflicts()).toEqual([expect.objectContaining({ label: "sharednet-data.service", file: `${home}/.local/share/systemd/user/sharednet-data.service`, blocking: true })]);
  });

  it("takes the manager's environment into the root, and blocks conservatively when it cannot be read", async () => {
    const units = [service("sharednet-inherit.service")];
    const managed = { managerEnv: `${MANAGER_ENV}XDG_CONFIG_HOME=/srv/managed\n` };
    expect(await (await control(units, {}, managed)).control.conflicts()).toEqual([]);
    expect((await (await control(units, { XDG_CONFIG_HOME: "/srv/managed" }, managed)).control.conflicts()).map((found) => found.label)).toEqual(["sharednet-inherit.service"]);
    const unknown = await (await control([service("sharednet-inherit.service", { UnitFileState: "disabled", ActiveState: "inactive" })], { XDG_CONFIG_HOME: "/srv/somewhere" }, { managerEnv: null })).control.conflicts();
    expect(unknown).toEqual([expect.objectContaining({ blocking: true, why: expect.stringContaining("show-environment") })]);
  });

  it("blocks only what will run: disabled and inactive warns, enabled or active or unknown blocks, masked is skipped", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["disabled", "inactive", false],
      ["static", "failed", false],
      ["enabled", "inactive", true],
      ["disabled", "active", true],
      ["weird", "inactive", true],
      ["disabled", "", true],
    ];
    for (const [enabled, active, blocking] of cases) {
      const { control: here } = await control([service("sharednet-listener.service", { UnitFileState: enabled, ActiveState: active })]);
      expect((await here.conflicts())[0]?.blocking, `${enabled}/${active}`).toBe(blocking);
    }
    const { control: masked } = await control([service("sharednet-listener.service", { LoadState: "masked", UnitFileState: "masked", ActiveState: "inactive" })]);
    expect(await masked.conflicts()).toEqual([]);
    // Install goes ahead beside a disabled, inactive one, and says it was there.
    const { fake, control: quiet } = await control([service("sharednet-listener.service", { UnitFileState: "disabled", ActiveState: "inactive" })], { USER: "synthetic" });
    const report = await quiet.install();
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("sharednet-listener.service is disabled and inactive")]));
    expect(fake.calls).toContain("systemctl --user restart sharednet-serve.service");
  });

  it("ignores units that are not about SharedNet, and its own unit", async () => {
    const units = [
      service("dbus.service", { Description: "D-Bus User Message Bus", ExecStart: exec("dbus-daemon --session") }),
      service("sharednet-serve.service"),
    ];
    expect(await (await control(units)).control.conflicts()).toEqual([]);
  });

  it("when the manager cannot be asked, reports every unit file that mentions SharedNet as unresolved and blocking", async () => {
    const { fake, control: here } = await control([], {}, { listFails: true });
    fake.files.set(`${home}/.local/share/systemd/user/sharednet-x.service`, "[Service]\nExecStart=/usr/bin/sharednet serve\n");
    fake.files.set(`${home}/.config/systemd/user/other.service`, "[Service]\nExecStart=/bin/true\n");
    expect(await here.conflicts()).toEqual([
      expect.objectContaining({ label: "sharednet-x.service", blocking: true, why: expect.stringContaining("could not be asked") }),
    ]);
  });
});

describe("conflicts under launchd, as the manager reports them", () => {
  const home = "/Users/synthetic";
  const agents = `${home}/Library/LaunchAgents`;
  const plist = (label: string, extra = "") =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${home}/.local/share/sharednet/bin/supervise.py</string></array>${extra}</dict></plist>`;
  const launchd = (answers: { loaded?: Record<string, string>; disabled?: string; plutil?: Answer }) => (command: string, args: string[]): Answer | undefined => {
    if (command === "plutil") return answers.plutil ?? { exitCode: 1 };
    if (command !== "launchctl") return undefined;
    if (args[0] === "print-disabled") return { exitCode: 0, stdout: answers.disabled ?? "" };
    if (args[0] === "print") {
      const label = args[1]!.split("/").slice(2).join("/");
      const printed = answers.loaded?.[label];
      return printed === undefined ? { exitCode: 113, stderr: "Could not find service" } : { exitCode: 0, stdout: printed };
    }
    return undefined;
  };
  const control = async (handle: ReturnType<typeof launchd>, env: Record<string, string> = {}) => {
    const fake = fakeHost("darwin", home, handle);
    return { fake, control: new ServiceControl({ HOME: home, PATH: await binWithNode(), ...env }, fake.host, program) };
  };

  it("a loaded job blocks, scoped by the environment launchctl print reports; another root's does not", async () => {
    const running = "\tstate = running\n\tpid = 80225\n";
    const elsewhere = "\tstate = running\n\tenvironment = {\n\t\tXDG_CONFIG_HOME => /tmp/elsewhere\n\t}\n";
    const { fake, control: here } = await control(launchd({ loaded: { "ai.sharednet.listener-supervisor": running, "com.example.sharednet-elsewhere": elsewhere } }));
    fake.files.set(`${agents}/ai.sharednet.listener-supervisor.plist`, plist("ai.sharednet.listener-supervisor"));
    // Its plist claims another root, but launchd runs it with what print shows.
    fake.files.set(`${agents}/com.example.sharednet-elsewhere.plist`, plist("com.example.sharednet-elsewhere", "<key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><string>/Users/synthetic/.config</string></dict>"));
    expect(await here.conflicts()).toEqual([
      {
        label: "ai.sharednet.listener-supervisor",
        file: `${agents}/ai.sharednet.listener-supervisor.plist`,
        blocking: true,
        why: "launchd has it loaded and running (pid 80225)",
        stop: "launchctl bootout gui/501/ai.sharednet.listener-supervisor",
      },
    ]);
    await expect(here.install()).rejects.toMatchObject({ code: "service_conflict", message: expect.stringContaining("launchctl bootout gui/501/ai.sharednet.listener-supervisor") });
    expect(fake.calls.every((call) => call.startsWith("launchctl print"))).toBe(true);
    const there = new ServiceControl({ HOME: home, PATH: await binWithNode(), XDG_CONFIG_HOME: "/tmp/elsewhere" }, fake.host, program);
    expect((await there.conflicts()).map((found) => found.label)).toEqual(["com.example.sharednet-elsewhere"]);
  });

  it("review 4, item 4: launchctl's explicit override wins over the plist's Disabled key, both ways", async () => {
    const cases: Array<[string, string, boolean]> = [
      ['\t"ai.sharednet.listener-supervisor" => enabled\n', "<key>Disabled</key><true/>", true],
      ['\t"ai.sharednet.listener-supervisor" => disabled\n', "", false],
      ["", "<key>Disabled</key><true/>", false],
      ["", "", true],
    ];
    for (const [disabled, key, blocking] of cases) {
      const { fake, control: here } = await control(launchd({ disabled }));
      fake.files.set(`${agents}/ai.sharednet.listener-supervisor.plist`, plist("ai.sharednet.listener-supervisor", key));
      const [found] = await here.conflicts();
      expect(found?.blocking, `${disabled.trim() || "no override"} / ${key || "no key"}`).toBe(blocking);
      expect(found?.stop).toBe("launchctl disable gui/501/ai.sharednet.listener-supervisor");
    }
  });

  it("reads a binary plist through plutil, and blocks conservatively when it cannot", async () => {
    const converted = plist("com.example.sharednet-bin", "<key>EnvironmentVariables</key><dict><key>XDG_CONFIG_HOME</key><string>/tmp/third</string></dict>");
    const { fake, control: here } = await control(launchd({ plutil: { exitCode: 0, stdout: converted } }));
    fake.files.set(`${agents}/com.example.sharednet-bin.plist`, "bplist00 sharednet serve");
    expect(await here.conflicts()).toEqual([]);
    expect(fake.calls).toContain(`plutil -convert xml1 -o - ${agents}/com.example.sharednet-bin.plist`);
    const { fake: broken, control: unread } = await control(launchd({ disabled: '\t"com.example.sharednet-bin" => disabled\n' }));
    broken.files.set(`${agents}/com.example.sharednet-bin.plist`, "bplist00 sharednet serve");
    expect(await unread.conflicts()).toEqual([expect.objectContaining({ blocking: true, why: expect.stringContaining("plutil could not convert") })]);
  });

  it("also reads the machine's /Library/LaunchAgents, which launchd loads into the login session", async () => {
    const { fake, control: here } = await control(launchd({ loaded: { "org.example.sharednet-wake": "\tstate = waiting\n" } }));
    fake.files.set("/Library/LaunchAgents/org.example.sharednet-wake.plist", plist("org.example.sharednet-wake"));
    expect(await here.conflicts()).toEqual([expect.objectContaining({ label: "org.example.sharednet-wake", blocking: true, why: "launchd has it loaded" })]);
  });
});
