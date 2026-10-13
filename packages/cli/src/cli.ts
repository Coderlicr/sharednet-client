import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePathFrom } from "node:path";

import { ApiClient, resolveBaseUrl } from "./api-client.ts";
import { CliError, asCliError, localError } from "./errors.ts";
import { READ_OPTIONS, isGuestVerb, messageQueryFrom, runGuestVerb, type CommandRunner } from "./guest.ts";
import { login } from "./login.ts";
import { goalExport, goalWatch, parseUntilList, readGoalFile, startGoal, withRequestLimit } from "./goal.ts";
import { dockerRunner, parseAgents, prepareRun, runContainers, runGoal, type DockerRunner } from "./goal-run.ts";
import { parseDuration } from "./triggers.ts";
import { refreshIfNeeded, registerInstance, resolveApiKey, selectSession } from "./session.ts";
import { deleteSession, getStoragePaths, type StoragePaths, type StoredSession } from "./storage.ts";
import type { CheckResult, SeatWake, TurnRunner } from "./wake-driver.ts";


type Environment = Record<string, string | undefined>;

export interface CliDependencies {
  env?: Environment;
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => Date;
  /** Where per-project Room state lives; defaults to the process working directory. */
  cwd?: string;
  /** Pause between empty long-polls in `wait`; tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Opens the approve page during `login`; tests capture the URL instead. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Runs the `watch --run` command; tests capture it instead of shelling out. */
  exec?: CommandRunner;
  /** Runs `docker` for `goal run`; tests replace it. */
  docker?: DockerRunner;
  /** The running CLI's entry file, mounted into `goal run`'s container; defaults to this process's. */
  cliEntry?: string;
  /** Ends a resident command such as `serve --push`; a person ends it with Ctrl-C instead. */
  signal?: AbortSignal;
  /** Runs one resumed turn of a seat's own session in `serve`; tests replace it. */
  runTurn?: TurnRunner;
  /** Whether the Claude Code chat that took a seat is still open, in `serve`; tests replace it. */
  chatOpen?: (pid: number) => boolean;
  checkWake?: (wake: SeatWake) => Promise<CheckResult>;
  /** Starts `serve` in the background after a join; only the real process (main.ts) supplies it. */
  startWakeService?: (input: { env: Environment; logFile: string }) => number | null;
}

interface ResolvedDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
  docker?: DockerRunner;
  cliEntry?: string;
  signal?: AbortSignal;
  runTurn?: TurnRunner;
  chatOpen?: (pid: number) => boolean;
  checkWake?: (wake: SeatWake) => Promise<CheckResult>;
  startWakeService?: (input: { env: Environment; logFile: string }) => number | null;
}

interface GlobalArguments {
  args: string[];
  json: boolean;
  sessionId?: string;
}

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
  /** Every value of a repeatable option, in order. */
  repeated: Map<string, string[]>;
}

/** Options that may be given more than once: a goal has as many end triggers as it needs. */
const repeatableOptionNames = new Set(["until", "agent"]);

const optionValueNames = new Set([
  "after",
  "before",
  "limit",
  "order",
  "last",
  "from-instance",
  "from-agent",
  "grep",
  "agent",
  "runtime",
  "name",
  "description",
  "content",
  "reply-to",
  "after",
  "limit",
  "with",
  "status",
  "goal",
  "until",
  "workspace",
  "out",
  "check-every",
  "agent",
  "image",
  "web-search",
  "turn-limit",
  "message-routing",
  "type",
]);
const booleanOptionNames = new Set(["new", "private", "quiet-checks", "mention-gate", "task-gate"]);

/** Room mode is fixed at creation. Omission retains the service default. */
function roomType(parsed: ParsedArguments): "board" | "compiled" | undefined {
  const value = option(parsed, "type");
  if (value !== undefined && value !== "board" && value !== "compiled") {
    throw localError("invalid_option", "--type is board or compiled.");
  }
  return value;
}

/** `--with i_a,i_b`: the Instances to seat, as the API takes them. */
function instanceList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0 || ids.some((id) => !/^i_[0-9A-Za-z]{10}$/.test(id))) {
    throw localError("invalid_option", "--with takes Instance ids such as i_AbCdEfGhIj, separated by commas.");
  }
  return ids;
}

function extractGlobals(argv: string[]): GlobalArguments {
  const args: string[] = [];
  let json = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--api-key" || argument.startsWith("--api-key=")) {
      throw localError(
        "credential_flag_forbidden",
        "API keys are accepted only from SHAREDNET_API_KEY or secure local credentials.",
      );
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      if (sessionId !== undefined) {
        throw localError("duplicate_option", "The --session option may be supplied only once.");
      }
      const value = argument === "--session" ? argv[++index] : argument.slice("--session=".length);
      if (!value || !/^i_[A-Za-z0-9_-]+$/.test(value)) {
        throw localError("invalid_session_id", "The --session value must be an Instance ID.");
      }
      sessionId = value;
      continue;
    }
    args.push(argument);
  }
  return { args, json, sessionId };
}

function parseArguments(args: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (repeatableOptionNames.has(name)) {
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (!value || value.startsWith("--")) {
        throw localError("missing_option_value", `The --${name} option requires a value.`);
      }
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
      if (!options.has(name)) options.set(name, value);
      continue;
    }
    if (options.has(name)) {
      throw localError("duplicate_option", `The --${name} option may be supplied only once.`);
    }
    if (booleanOptionNames.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!optionValueNames.has(name)) {
      throw localError("unknown_option", "The command contains an unknown option.");
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw localError("missing_option_value", `The --${name} option requires a value.`);
    }
    options.set(name, value);
  }
  return { options, positionals, repeated };
}

function option(arguments_: ParsedArguments, name: string): string | undefined {
  const value = arguments_.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(arguments_: ParsedArguments, name: string): string {
  const value = option(arguments_, name);
  if (!value) throw localError("missing_required_option", `The --${name} option is required.`);
  return value;
}

function assertOnlyOptions(arguments_: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of arguments_.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

function assertPositionals(arguments_: ParsedArguments, count: number): void {
  if (arguments_.positionals.length !== count) {
    throw localError("invalid_arguments", "The command received the wrong number of arguments.");
  }
}

async function withSelectedSession<T>(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
  callback: (
    client: ApiClient,
    session: StoredSession,
    paths: StoragePaths,
  ) => Promise<T>,
): Promise<T> {
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);
  let session = await selectSession(
    paths,
    baseUrl,
    globals.sessionId,
    dependencies.env,
  );
  session = await refreshIfNeeded(client, paths, session, dependencies.now());
  try {
    return await callback(client, session, paths);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) {
      await deleteSession(paths, session.instance_id);
    }
    throw error;
  }
}

async function startSession(
  commandArgs: string[],
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, ["agent", "runtime", "new", "private"]);

  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const { payload } = await registerInstance(dependencies.env, dependencies.fetch, paths, baseUrl, {
    runtimeOverride: option(parsed, "runtime"),
    forceNew: parsed.options.get("new") === true,
    agent: option(parsed, "agent"),
    freshWhenUndetected: false,
    // --private: strangers who know this Instance's id have to ask before
    // seating it. Omitted, the Principal's default applies (public).
    ...(parsed.options.get("private") === true ? { reach: "private" as const } : {}),
  });
  return {
    instance: payload.instance,
    session_id: payload.instance.id,
    heartbeat_after_seconds: payload.heartbeat_after_seconds,
  };
}

async function sessionStatus(
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, []);
  return withSelectedSession(globals, dependencies, (client, session) =>
    client.request("GET", "/instances/current", session.instance_token),
  );
}

async function roomCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "create") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, ["name", "description", "with", "goal", "until", "type"]);
    const type = roomType(parsed);
    const name = requiredOption(parsed, "name");
    const description = option(parsed, "description");
    const withIds = instanceList(option(parsed, "with"));
    // A goal Room (decision 2026-10-05): everything about the goal is checked before the Room exists.
    const goalPath = option(parsed, "goal");
    if (goalPath === undefined && parsed.repeated.has("until")) {
      throw localError("invalid_arguments", "--until ends a goal; give the goal with --goal <file>.");
    }
    const goal =
      goalPath === undefined
        ? null
        : {
            content: await readGoalFile(dependencies.cwd, goalPath),
            until: parseUntilList(parsed.repeated.get("until") ?? [], dependencies.now().getTime()).wire,
          };
    const apiKey = goal === null ? null : await resolveApiKey(dependencies.env, getStoragePaths(dependencies.env), resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL));
    return withSelectedSession(globals, dependencies, async (client, session) => {
      const created = await client.request<{ room?: { id?: string }; [key: string]: unknown }>("POST", "/rooms", session.instance_token, {
        name,
        ...(type === undefined ? {} : { type }),
        ...(description === undefined ? {} : { description }),
        ...(withIds === undefined ? {} : { with: withIds }),
      }, { "idempotency-key": randomUUID() });
      if (goal === null || apiKey === null) return created;
      const roomId = created.room?.id;
      if (!roomId) throw new CliError("invalid_server_response", "The Room was created but its id did not come back.", 5);
      const started = await startGoal(client, apiKey, roomId, goal.content, goal.until).catch((error: unknown) => {
        // The Room stands without its goal; say which one, so it can be closed or given the goal again.
        const refused = asCliError(error);
        throw new CliError(refused.code, `${roomId} was created, but its goal was refused: ${refused.message}`, refused.exitCode, refused.requestId);
      });
      return { ...created, ...started };
    });
  }

  if (action === "list") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, []);
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("GET", "/rooms", session.instance_token),
    );
  }

  if (action === "invite") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const roomId = parsed.positionals[0]!;
    if (!/^rom_[0-9A-Za-z]{10}$/.test(roomId)) {
      throw localError("invalid_arguments", "Usage: sharednet room invite <rom_…>");
    }
    return withSelectedSession(globals, dependencies, async (client, session) => {
      const minted = await client.request<{ invite: unknown; token: string; link: string }>(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/invites`,
        session.instance_token,
      );
      // What the human forwards: the link for people, and the same invite as
      // one line for an Agent. The token is the invite; it opens this Room
      // and nothing else, so it may be handed on.
      const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
      return {
        room_id: roomId,
        invite: minted.invite,
        link: minted.link,
        for_agents: `ROOM=${roomId} TOKEN=${minted.token} BASE=${baseUrl}`,
        command: `npx -y sharednet@latest join 'ROOM=${roomId} TOKEN=${minted.token} BASE=${baseUrl}'`,
      };
    });
  }

  if (action === "add") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["with"]);
    const roomId = parsed.positionals[0]!;
    const withIds = instanceList(requiredOption(parsed, "with"));
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", `/rooms/${encodeURIComponent(roomId)}/members`, session.instance_token, {
        with: withIds,
      }),
    );
  }

  if (action === "join") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const roomId = parsed.positionals[0]!;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/join`,
        session.instance_token,
        undefined,
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "post") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["content", "reply-to"]);
    const roomId = parsed.positionals[0]!;
    const content = requiredOption(parsed, "content");
    const replyTo = option(parsed, "reply-to");
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/messages`,
        session.instance_token,
        {
          content,
          ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
        },
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "messages") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, [...READ_OPTIONS]);
    const roomId = parsed.positionals[0]!;
    const parameters = messageQueryFrom(parsed.options);
    const query = parameters.size ? `?${parameters.toString()}` : "";
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/messages${query}`,
        session.instance_token,
      ),
    );
  }

  throw localError("unknown_command", "Unknown room command.");
}

/**
 * Decisions addressed to the selected Instance: today, requests to seat it
 * in a Room while it is private. The Instance answers for itself.
 */
async function decisionCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "list") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, ["status"]);
    const status = option(parsed, "status");
    const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("GET", `/decisions${query}`, session.instance_token),
    );
  }
  if (action === "approve" || action === "deny") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const decisionId = parsed.positionals[0]!;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", `/decisions/${encodeURIComponent(decisionId)}/resolve`, session.instance_token, {
        resolution: action === "approve" ? "approved" : "denied",
      }),
    );
  }
  throw localError("unknown_command", "Unknown decision command. Use decision list, approve <id>, or deny <id>.");
}

/**
 * `goal watch <rom_…>` sits in a goal Room until one of its end triggers
 * fires, closes it with that trigger, and writes the record; `goal export
 * <rom_…>` writes the record of a Room without watching it.
 */
async function goalCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "run") return goalRunCommand(parsed, globals, dependencies);
  if (action === "start") {
    assertOnlyOptions(parsed, ["name", "description", "with", "until", "type"]);
    assertPositionals(parsed, 1);
    const args = [...parsed.options].flatMap(([name, value]) =>
      (parsed.repeated.get(name) ?? [String(value)]).flatMap((item) => [`--${name}`, item]),
    );
    return roomCommand("create", [...args, "--goal", parsed.positionals[0]!, ...(option(parsed, "name") ? [] : ["--name", basename(parsed.positionals[0]!)])], globals, dependencies);
  }
  const usage =
    "Use goal start <goal file> [--type board|compiled] --until <trigger>, goal run <goal file> [--type board|compiled] --agent codex[:model] --until <trigger> [...], goal watch <rom_…> [--workspace <dir>] [--out <dir>] [--check-every 1m] [--quiet-checks], or goal export <rom_…> [--out <dir>].";
  const roomId = parsed.positionals[0];
  if ((action !== "watch" && action !== "export") || parsed.positionals.length !== 1 || !/^rom_[0-9A-Za-z]{10}$/.test(roomId ?? "")) {
    throw localError("unknown_command", usage);
  }
  const out = resolvePathFrom(dependencies.cwd, option(parsed, "out") ?? join("runs", roomId!));
  // A runner sits for hours: no one request may hold it longer than the long-poll it is.
  const limited: ResolvedDependencies = { ...dependencies, fetch: withRequestLimit(dependencies.fetch) };
  if (action === "export") {
    assertOnlyOptions(parsed, ["out"]);
    return withSelectedSession(globals, limited, (client, session) => goalExport(client, session.instance_token, roomId!, out));
  }
  assertOnlyOptions(parsed, ["workspace", "out", "check-every", "quiet-checks"]);
  const workspace = resolvePathFrom(dependencies.cwd, option(parsed, "workspace") ?? ".");
  const checkEveryMs = parsed.options.has("check-every") ? parseDuration(option(parsed, "check-every"), "--check-every") : 60_000;
  const apiKey = await resolveApiKey(dependencies.env, getStoragePaths(dependencies.env), resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL));
  const exec = (dependencies as { exec?: CommandRunner }).exec;
  return withSelectedSession(globals, limited, (client, session) =>
    goalWatch(
      client,
      session.instance_token,
      apiKey,
      { roomId: roomId!, workspace, out, checkEveryMs, quietChecks: parsed.options.get("quiet-checks") === true },
      {
        now: dependencies.now,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        stderr: dependencies.stderr,
        // Tests hand the command runner in; a real run uses the shell, in the workspace.
        ...(exec
          ? {
              check: async (command: string) => {
                const result = await exec(command, "", {});
                return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
              },
            }
          : {}),
      },
    ),
  );
}

/**
 * `goal run <goal file> --agent <driver[:model]>… --until <trigger>…`: the goal Room, the
 * Agents that work on it in a container, and the runner that ends it, in one command.
 * Everything that could fail half-way (the goal, the triggers, Docker, each driver's sign-in)
 * is checked before the Room exists.
 */
async function goalRunCommand(parsed: ParsedArguments, globals: GlobalArguments, dependencies: ResolvedDependencies): Promise<unknown> {
  assertOnlyOptions(parsed, ["agent", "until", "workspace", "out", "name", "image", "check-every", "quiet-checks", "web-search", "turn-limit", "type", "mention-gate", "task-gate", "message-routing"]);
  const type = roomType(parsed);
  const messageRouting = option(parsed, "message-routing");
  if (messageRouting !== undefined && messageRouting !== "broadcast" && messageRouting !== "mentions") throw localError("invalid_arguments", "--message-routing must be broadcast or mentions.");
  if (type === "compiled" && (parsed.options.has("mention-gate") || parsed.options.has("task-gate") || messageRouting === "mentions")) {
    throw localError("invalid_arguments", "The mention/task gates are for plain board Rooms.");
  }
  if (parsed.positionals.length !== 1) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet goal run <goal file> [--type board|compiled] --agent codex[:model] [--agent claude-code[:model]]... --until <trigger> [--until ...] [--workspace <dir>] [--out <dir>] [--name <name>] [--image <image>] [--check-every 1m] [--quiet-checks] [--web-search live|off] [--turn-limit 20m] [--mention-gate] [--task-gate] [--message-routing broadcast|mentions]",
    );
  }
  const webSearch = option(parsed, "web-search") ?? "live";
  if (webSearch !== "live" && webSearch !== "off") {
    throw localError("invalid_arguments", "--web-search is live or off.");
  }
  const turnLimitMs = parsed.options.has("turn-limit") ? parseDuration(option(parsed, "turn-limit"), "--turn-limit") : undefined;
  if (turnLimitMs !== undefined && turnLimitMs < 60_000) {
    throw localError("invalid_arguments", "--turn-limit is at least 1m.");
  }
  const content = await readGoalFile(dependencies.cwd, parsed.positionals[0]!);
  const until = parseUntilList(parsed.repeated.get("until") ?? [], dependencies.now().getTime(), { budget: true });
  const agents = parseAgents(parsed.repeated.get("agent") ?? []);
  const workspace = resolvePathFrom(dependencies.cwd, option(parsed, "workspace") ?? ".");
  if (!(await stat(workspace).then((entry) => entry.isDirectory(), () => false))) {
    throw localError("invalid_arguments", `--workspace ${workspace} is not a directory.`);
  }
  const checkEveryMs = parsed.options.has("check-every") ? parseDuration(option(parsed, "check-every"), "--check-every") : 60_000;
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const apiKey = await resolveApiKey(dependencies.env, getStoragePaths(dependencies.env), baseUrl);
  const docker = dependencies.docker ?? dockerRunner(dependencies.env);
  const plan = await prepareRun(
    {
      agents,
      image: option(parsed, "image") ?? null,
      workspace,
      env: dependencies.env,
      home: dependencies.env.HOME ?? homedir(),
      entry: dependencies.cliEntry ?? realpathSync(process.argv[1]!),
    },
    docker,
    dependencies.stderr,
  );
  const limited: ResolvedDependencies = { ...dependencies, fetch: withRequestLimit(dependencies.fetch) };
  return withSelectedSession(globals, limited, async (client, session) => {
    const created = await client.request<{ room?: { id?: string } }>(
      "POST",
      "/rooms",
      session.instance_token,
      { name: option(parsed, "name") ?? basename(workspace), ...(type === undefined ? {} : { type }) },
      { "idempotency-key": randomUUID() },
    );
    const roomId = created.room?.id;
    if (!roomId) throw new CliError("invalid_server_response", "The Room was created but its id did not come back.", 5);
    const started = await startGoal(client, apiKey, roomId, content, until.wire).catch((error: unknown) => {
      const refused = asCliError(error);
      throw new CliError(refused.code, `${roomId} was created, but its goal was refused: ${refused.message}`, refused.exitCode, refused.requestId);
    });
    const invite = await client.request<{ token?: string }>("POST", `/rooms/${encodeURIComponent(roomId)}/invites`, session.instance_token);
    if (!invite?.token) throw new CliError("invalid_server_response", "The Agents' invite did not come back.", 5);
    const out = resolvePathFrom(dependencies.cwd, option(parsed, "out") ?? join("runs", roomId));
    dependencies.stderr(`goal: ${roomId} is open; the record goes to ${out}\n`);
    // Ctrl-C ends the run without leaving Agents at work in containers nobody watches.
    const interrupt = () => {
      spawnSync("docker", ["rm", "--force", ...runContainers(roomId, plan.agents)]);
      dependencies.stderr(`goal: stopped; the Agents' containers are gone and ${roomId} is still open\n`);
      process.exit(130);
    };
    if (!dependencies.docker) process.once("SIGINT", interrupt);
    try {
      return await runGoal(
        client,
        session.instance_token,
        apiKey,
        {
          plan,
          roomType: type ?? "board",
          roomId,
          inviteToken: invite.token,
          goal: content,
          goalSequence: (started.message as { sequence?: number } | undefined)?.sequence ?? 1,
          until: until.wire,
          baseUrl,
          out,
          checkEveryMs,
          quietChecks: parsed.options.get("quiet-checks") === true,
          mentionGate: parsed.options.get("mention-gate") === true,
          taskGate: parsed.options.get("task-gate") === true,
          ...(messageRouting ? { messageRouting } : {}),
          webSearch,
          ...(turnLimitMs === undefined ? {} : { turnLimitMs }),
        },
        { docker, now: dependencies.now, ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}), stderr: dependencies.stderr },
      );
    } finally {
      process.off("SIGINT", interrupt);
    }
  });
}

async function execute(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const [resource, action, ...commandArgs] = globals.args;
  if (resource === "login") {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", "The --session option is not valid for sharednet login.");
    }
    return login(globals.args.slice(1), dependencies);
  }
  if (isGuestVerb(resource)) {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", `The --session option is not valid for sharednet ${resource}.`);
    }
    return runGuestVerb(resource, globals.args.slice(1), dependencies);
  }
  if (resource === "session" && action === "start") {
    return startSession(commandArgs, dependencies);
  }
  if (resource === "session" && action === "status") {
    return sessionStatus(commandArgs, globals, dependencies);
  }
  if (resource === "room") {
    return roomCommand(action, commandArgs, globals, dependencies);
  }
  if (resource === "decision") {
    return decisionCommand(action, commandArgs, globals, dependencies);
  }
  if (resource === "goal") {
    return goalCommand(action, commandArgs, globals, dependencies);
  }
  throw localError(
    "unknown_command",
    "Use login, whoami, join/say/read/wait/ack/watch/handed/add/rooms/requests/accept/deny/reach/timer, task claim/done/list, wake/wake set/off/check, balance/redeem/pay/ledger, upload/download/files, act/open/deliver, or session start/status, room create/list/invite/add/join/post/messages, goal start/run/watch/export, and decision list/approve/deny.",
  );
}

function isHookOutput(payload: unknown): payload is { hook: true; lines: string[] } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { hook?: unknown }).hook === true &&
    Array.isArray((payload as { lines?: unknown }).lines)
  );
}

function writeSuccess(
  payload: unknown,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  // A hook's stdout goes straight into an Agent's context: plain lines, and
  // nothing at all when the Room was quiet.
  if (!json && isHookOutput(payload)) {
    if (payload.lines.length > 0) dependencies.stdout(`${payload.lines.join("\n")}\n`);
    return;
  }
  dependencies.stdout(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

function writeFailure(
  error: CliError,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  if (json) {
    dependencies.stderr(
      `${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { request_id: error.requestId } : {}),
        },
      })}\n`,
    );
    return;
  }
  const requestSuffix = error.requestId ? ` (${error.requestId})` : "";
  dependencies.stderr(`${error.code}: ${error.message}${requestSuffix}\n`);
}

export async function runCli(
  argv: string[],
  supplied: CliDependencies = {},
): Promise<number> {
  const dependencies: ResolvedDependencies = {
    env: supplied.env ?? process.env,
    fetch: supplied.fetch ?? globalThis.fetch,
    stdout: supplied.stdout ?? ((value) => process.stdout.write(value)),
    stderr: supplied.stderr ?? ((value) => process.stderr.write(value)),
    now: supplied.now ?? (() => new Date()),
    cwd: supplied.cwd ?? process.cwd(),
    ...(supplied.sleep ? { sleep: supplied.sleep } : {}),
    ...(supplied.openBrowser ? { openBrowser: supplied.openBrowser } : {}),
    ...(supplied.exec ? { exec: supplied.exec } : {}),
    ...(supplied.docker ? { docker: supplied.docker } : {}),
    ...(supplied.cliEntry ? { cliEntry: supplied.cliEntry } : {}),
    ...(supplied.signal ? { signal: supplied.signal } : {}),
    ...(supplied.runTurn ? { runTurn: supplied.runTurn } : {}),
    ...(supplied.chatOpen ? { chatOpen: supplied.chatOpen } : {}),
    ...(supplied.checkWake ? { checkWake: supplied.checkWake } : {}),
    ...(supplied.startWakeService ? { startWakeService: supplied.startWakeService } : {}),
  };
  let json = argv.includes("--json");
  try {
    const globals = extractGlobals(argv);
    json = globals.json;
    const payload = await execute(globals, dependencies);
    writeSuccess(payload, globals.json, dependencies);
    return 0;
  } catch (error) {
    const cliError = asCliError(error);
    writeFailure(cliError, json, dependencies);
    return cliError.exitCode;
  }
}
