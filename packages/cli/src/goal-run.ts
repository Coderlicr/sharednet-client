import { compiledPrompt, COMPILED_HELP, type CompiledState } from "./compiled.ts";
import { controlPaths, isTaskMessage } from "./board-controls.ts";
import { TASK_HELP, MENTION_HELP, TASK_PROFILE, TASK_HOOK, TASK_HOOK_SETTINGS } from "./task-guard.ts";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { ApiClient } from "./api-client.ts";
import { localError } from "./errors.ts";
import { goalWatch, type GoalWatchResult } from "./goal.ts";
import { mentions } from "./triggers.ts";

/**
 * `goal run`: the goal Room, the Agents that work on it, and the runner that
 * ends it, in one command. Each Agent runs in its own Docker container, its
 * sandbox: its own processes, its own home, its own seat. The containers share
 * one thing, the workspace, mounted at /workspace in each. The checks run in
 * one more container, which has the workspace and nothing an Agent installed.
 * The owner's account key never enters any of them.
 * Isolated (`--isolate`), the containers sit on an internal network whose one
 * way out is a gateway the runner starts: it reaches SharedNet and the drivers'
 * model APIs, and holds the model keys itself, so no Agent can reach anything
 * else or read a key.
 * Each Agent works in turns. The runner holds every seat's wait, starts a
 * turn when the seat is woken, and resumes the same harness session, so every
 * Agent is woken by one policy and the record says when and by what.
 */

export type Driver = "codex" | "claude-code";

export interface AgentSpec {
  /** The seat's name in the Room: the driver and a number, `codex-1`. */
  name: string;
  driver: Driver;
  model: string | null;
}

const DRIVERS: readonly Driver[] = ["codex", "claude-code"];
const MAX_AGENTS = 50;

/** `--agent codex`, `--agent codex:gpt-6-luna`, `--agent claude-code:claude-sonnet-5-5`; repeat it for more seats. */
export function parseAgents(raws: readonly string[]): AgentSpec[] {
  if (raws.length === 0) {
    throw localError("invalid_arguments", "goal run needs at least one --agent: codex or claude-code, with :<model> to choose the model.");
  }
  if (raws.length > MAX_AGENTS) throw localError("invalid_arguments", `goal run starts at most ${MAX_AGENTS} Agents.`);
  const counts = new Map<Driver, number>();
  return raws.map((raw) => {
    const separator = raw.indexOf(":");
    const driver = (separator === -1 ? raw : raw.slice(0, separator)).trim() as Driver;
    const model = separator === -1 ? null : raw.slice(separator + 1).trim() || null;
    if (!DRIVERS.includes(driver)) throw localError("invalid_arguments", `--agent ${raw}: the driver is codex or claude-code.`);
    if (model !== null && !/^[A-Za-z0-9._/-]{1,100}$/.test(model)) throw localError("invalid_arguments", `--agent ${raw}: that is not a model name.`);
    const number = (counts.get(driver) ?? 0) + 1;
    counts.set(driver, number);
    return { name: `${driver}-${number}`, driver, model };
  });
}

// ---- Docker ----

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker <args>`. `env` is added to the Docker client's own environment, which is how a
 * secret reaches a container (`-e NAME` with no value) without appearing in any argument list.
 * With `onLine`, stdout is handed over line by line as it comes and not kept.
 */
export type DockerRunner = (
  args: readonly string[],
  options?: { input?: string; env?: Record<string, string>; onLine?: (line: string) => void },
) => Promise<DockerResult>;

export function dockerRunner(baseEnv: Record<string, string | undefined>): DockerRunner {
  // The owner's key has no business near Docker, not even in the client's own environment.
  const { SHAREDNET_API_KEY: _ownerKey, ...clientEnv } = baseEnv;
  return (args, options = {}) =>
    new Promise((resolveRun) => {
      const child = spawn("docker", [...args], { env: { ...clientEnv, ...options.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let partial = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!options.onLine) {
          stdout += chunk;
          return;
        }
        partial += chunk;
        for (let index = partial.indexOf("\n"); index !== -1; index = partial.indexOf("\n")) {
          options.onLine(partial.slice(0, index));
          partial = partial.slice(index + 1);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-64_000);
      });
      child.on("error", () => resolveRun({ code: 127, stdout, stderr: "docker could not be started" }));
      child.on("close", (code) => {
        if (options.onLine && partial) options.onLine(partial);
        resolveRun({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(options.input ?? "");
    });
}

/** The image the Agents run in when no --image is given; built on first use. */
export const DEFAULT_IMAGE = "sharednet-goal-agents:1";
export const AGENT_DOCKERFILE = `FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-pytest ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @anthropic-ai/claude-code && npm cache clean --force
RUN mkdir -p /home/agents /workspace && chown node:node /home/agents /workspace
USER node
WORKDIR /workspace
`;

const AGENT_USER = "node";
const AGENT_USER_PATTERN = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10}(?::[0-9]{1,10})?)$/;
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOMES = "/home/agents";
const CONTAINER_CLI = "/opt/sharednet";
const CONTAINER_CODEX_AUTH = "/run/codex/auth.json";
/** A turn that runs longer than this is stopped; the next wake starts the next one. */
const TURN_LIMIT_SECONDS = 1_200;
/** A seat whose harness fails this many turns in a row stops taking turns. */
const FAILED_TURNS_LIMIT = 3;

/** The gateway of an isolated run: the one container on its internal network that has a way out. */
export const GATEWAY_IMAGE = "nginx:1.27-alpine";
const GATEWAY_ALIAS = "gateway";
const GATEWAY_PORTS = { sharednet: 8081, openai: 8080, anthropic: 8082 } as const;
/** What an isolated Agent holds where its harness wants a key: the gateway signs the real requests. */
const KEY_PLACEHOLDERS = {
  OPENAI_API_KEY: "sk-isolated-the-gateway-holds-the-key",
  ANTHROPIC_API_KEY: "sk-ant-api03-isolated-the-gateway-holds-the-key",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-isolated-the-gateway-holds-the-token",
} as const;

/** The internal network and the gateway of an isolated run, named for its Room. */
export function isolationNames(roomId: string): { network: string; gateway: string } {
  return { network: `sharednet-goal-${roomId}-net`, gateway: `sharednet-goal-${roomId}-gateway` };
}

/** One server block of the gateway: a port, the upstream it forwards to, and what it adds. */
function gatewayServer(port: number, upstream: string, log: string, headers: string[], readTimeout: string): string {
  const host = new URL(upstream).host;
  return [
    "server {",
    `  listen ${port};`,
    `  access_log /var/log/nginx/${log}.log trace;`,
    "  client_max_body_size 64m;",
    "  location / {",
    `    proxy_pass ${upstream};`,
    `    proxy_set_header Host ${host};`,
    ...headers.map((header) => `    ${header}`),
    "    proxy_set_header Upgrade $http_upgrade;",
    "    proxy_set_header Connection $connection_upgrade;",
    "    proxy_ssl_server_name on;",
    "    proxy_http_version 1.1;",
    "    proxy_buffering off;",
    `    proxy_read_timeout ${readTimeout};`,
    "  }",
    "}",
  ].join("\n");
}

/**
 * The gateway's nginx configuration, as a template the nginx image fills from its environment when
 * it starts: the keys are written into it there, inside the gateway, and appear in no argument.
 * Every request is logged with the address of the container it came from.
 */
export function gatewayTemplate(input: { sharednet: string; isolation: Isolation; codex: boolean; claudeAuth: RunPlan["claudeAuth"] }): string {
  const blocks = [
    "log_format trace escape=json '{\"time\":\"$time_iso8601\",\"client\":\"$remote_addr\",\"method\":\"$request_method\",'",
    "  '\"uri\":\"$request_uri\",\"status\":$status,\"request_time\":$request_time,\"bytes_sent\":$body_bytes_sent}';",
    "map $http_upgrade $connection_upgrade { default upgrade; '' ''; }",
    gatewayServer(GATEWAY_PORTS.sharednet, input.sharednet, "sharednet", [], "120s"),
  ];
  if (input.codex) {
    blocks.push(gatewayServer(GATEWAY_PORTS.openai, input.isolation.openai, "openai", ['proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";'], "900s"));
  }
  if (input.claudeAuth !== null) {
    const header = input.claudeAuth === "ANTHROPIC_API_KEY"
      ? 'proxy_set_header x-api-key "${ANTHROPIC_API_KEY}";'
      : 'proxy_set_header Authorization "Bearer ${CLAUDE_CODE_OAUTH_TOKEN}";';
    blocks.push(gatewayServer(GATEWAY_PORTS.anthropic, input.isolation.anthropic, "anthropic", [header], "900s"));
  }
  return `${blocks.join("\n")}\n`;
}

/** One container of a run: an Agent's, named for its seat, or with no seat, the checks'. */
export function containerName(roomId: string, seat?: string): string {
  return seat === undefined ? `sharednet-goal-${roomId}` : `sharednet-goal-${roomId}-${seat}`;
}

/** Every container one run starts, so that whatever stops the run can remove them all. */
export function runContainers(roomId: string, agents: readonly Pick<AgentSpec, "name">[]): string[] {
  return [...agents.map((agent) => containerName(roomId, agent.name)), containerName(roomId)];
}

/**
 * The port of a development service on this machine's loopback, the one plain-HTTP address the CLI
 * accepts. Inside a container that address is the container's own, so the runner forwards the
 * same port to this machine in each Agent's container; the Agents then use the address the runner uses.
 */
export function loopbackPort(baseUrl: string): number | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  return Number(url.port || 80);
}

const FORWARDER = `const net = require("node:net");
const port = Number(process.argv[1]);
const target = process.argv[2] || "host.docker.internal";
net.createServer((socket) => {
  const upstream = net.connect(port, target);
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}).listen(port, "127.0.0.1");`;
const FORWARDER_PROBE = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));`;

/** Where an isolated run's gateway sends each driver's model requests. */
export interface Isolation {
  openai: string;
  anthropic: string;
}

export interface RunPlan {
  image: string;
  /** The user the Agents and the checks run as in the image: `node` in the default image. */
  agentUser?: string;
  /** Set, the run is isolated: an internal network, and a gateway that holds the model keys. */
  isolation?: Isolation | null;
  agents: AgentSpec[];
  workspace: string;
  /** This CLI's own package on this machine, mounted into each Agent's container so the Agents run the same version. */
  cli: { root: string; entry: string };
  /** How the Codex seats sign in: an API key from this environment, or this machine's Codex login. */
  codexAuth: { kind: "api-key" } | { kind: "login"; file: string } | null;
  /** The variable that signs the Claude Code seats in, passed through by name. */
  claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | null;
}

/** The package root of the CLI that is running: the directory with its package.json. */
export function cliPackage(entry: string): { root: string; entry: string } {
  for (let directory = dirname(entry); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return { root: directory, entry: relative(directory, entry) };
  }
  throw localError("invalid_local_state", "The SharedNet CLI's own package could not be found, so it cannot be handed to the Agents.");
}

/**
 * Everything goal run needs before it creates anything: Docker, the image, and a way for each
 * driver to sign in. A run that would fail half-way is refused here instead.
 */
export async function prepareRun(
  input: { agents: AgentSpec[]; image: string | null; workspace: string; env: Record<string, string | undefined>; home: string; entry: string; agentUser?: string | null; isolate?: boolean },
  docker: DockerRunner,
  log: (line: string) => void,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms)),
): Promise<RunPlan> {
  if ((await docker(["info", "--format", "{{.ServerVersion}}"])).code !== 0) {
    throw localError("docker_unavailable", "goal run starts the Agents in Docker containers; start Docker, then run it again.");
  }
  const agentUser = input.agentUser ?? AGENT_USER;
  if (!AGENT_USER_PATTERN.test(agentUser)) throw localError("invalid_arguments", `--agent-user ${agentUser}: that is not a user name or uid.`);
  const image = input.image ?? DEFAULT_IMAGE;
  // Docker Desktop waking from idle can answer `info` before it can see its images: ask again before building.
  let present = false;
  for (let attempt = 0; attempt < 5 && !present; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    present = (await docker(["image", "inspect", image])).code === 0;
  }
  if (!present) {
    if (input.image !== null) throw localError("image_not_found", `The image ${image} is not on this machine.`);
    log(`goal: building the Agents' image ${image}, once; this takes a few minutes\n`);
    const built = await docker(["build", "-t", image, "-"], { input: AGENT_DOCKERFILE });
    if (built.code !== 0) throw localError("image_build_failed", `The Agents' image could not be built: ${built.stderr.trim().split("\n").slice(-3).join(" ")}`);
  }
  let codexAuth: RunPlan["codexAuth"] = null;
  if (input.agents.some((agent) => agent.driver === "codex")) {
    const login = join(input.home, ".codex", "auth.json");
    if (input.env.OPENAI_API_KEY) codexAuth = { kind: "api-key" };
    // The gateway signs an isolated seat's requests with a key; a login lives in the container that uses it.
    else if (input.isolate) throw localError("agent_auth_missing", "An isolated codex Agent reaches OpenAI through the run's gateway, which signs its requests with OPENAI_API_KEY; set it. A Codex login cannot be lent to the gateway.");
    // Mounted by its real path: Docker would otherwise mount the link, not the login.
    else if (existsSync(login)) codexAuth = { kind: "login", file: realpathSync(login) };
    else throw localError("agent_auth_missing", "A codex Agent signs in with OPENAI_API_KEY or this machine's Codex login (codex login); neither is here.");
  }
  let claudeAuth: RunPlan["claudeAuth"] = null;
  if (input.agents.some((agent) => agent.driver === "claude-code")) {
    if (input.env.CLAUDE_CODE_OAUTH_TOKEN) claudeAuth = "CLAUDE_CODE_OAUTH_TOKEN";
    else if (input.env.ANTHROPIC_API_KEY) claudeAuth = "ANTHROPIC_API_KEY";
    else {
      throw localError(
        "agent_auth_missing",
        "A claude-code Agent signs in with CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token` and export what it prints) or ANTHROPIC_API_KEY; neither is set.",
      );
    }
  }
  let isolation: Isolation | null = null;
  if (input.isolate) {
    if ((await docker(["image", "inspect", GATEWAY_IMAGE])).code !== 0) {
      log(`goal: pulling the gateway's image ${GATEWAY_IMAGE}, once\n`);
      const pulled = await docker(["pull", GATEWAY_IMAGE]);
      if (pulled.code !== 0) throw localError("image_not_found", `The gateway's image ${GATEWAY_IMAGE} could not be pulled: ${pulled.stderr.trim().split("\n").slice(-1).join(" ")}`);
    }
    isolation = { openai: modelOrigin(input.env.OPENAI_BASE_URL, "https://api.openai.com"), anthropic: modelOrigin(input.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com") };
  }
  return { image, agentUser, isolation, agents: input.agents, workspace: input.workspace, cli: cliPackage(input.entry), codexAuth, claudeAuth };
}

/** A model API's origin, from this machine's own setting for it when there is one. */
function modelOrigin(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw localError("invalid_arguments", `${value} is not a URL a gateway can forward to.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw localError("invalid_arguments", `${value} is not a URL a gateway can forward to.`);
  return url.origin;
}

// ---- turns ----

export interface WakeShape {
  wake_id: string | null;
  fired: string[];
  messages: Array<{ sequence: number; content: string; sender?: { member_id?: string; name?: string | null } }>;
  events: Array<Record<string, unknown>>;
  from: number;
  through: number;
}

export type MessageRouting = "broadcast" | "mentions";
/** Routing chooses wake recipients, not board visibility. Unknown-only handles broadcast. */
export function routeWake(wake: WakeShape, seat: { name: string }, seats: Array<{ name: string; member_id?: string | null }>, mode: MessageRouting): WakeShape {
  if (mode === "broadcast") return wake;
  return { ...wake, messages: wake.messages.filter(message => {
    if (mentions(message.content, { memberId: "", name: "all" })) return true;
    const recipients = seats.filter(other => mentions(message.content, { memberId: other.member_id ?? "", name: other.name }));
    return recipients.length === 0 || recipients.some(other => other.name === seat.name);
  }) };
}

/** Task claims and completions are state, not news: a wake drops them, and `task list` shows them. */
export function withoutTaskActs(wake: WakeShape): WakeShape {
  return { ...wake, messages: wake.messages.filter(message => !isTaskMessage(message.content)) };
}

/** What one Agent is told first: who it is, the goal, how the Room ends, and how to speak. */
export function openingPrompt(input: { seat: AgentSpec; seats: Array<AgentSpec & { member_id?: string | null }>; roomType?: "board" | "compiled"; roomId: string; goal: string; goalSequence: number; until: string[]; mentionGate?: boolean; taskGate?: boolean; messageRouting?: MessageRouting; consensus?: boolean }): string {
  const others = input.seats.filter((seat) => seat.name !== input.seat.name).map((seat) => input.roomType === "compiled" ? `${seat.name} (${seat.member_id ?? "not seated"})` : seat.name);
  const claims = input.until.filter((trigger) => trigger.startsWith("said ")).map((trigger) => `"${trigger.slice(5)}"`);
  const checked = input.until.some((trigger) => trigger.startsWith("check "));
  const ends = input.consensus ? input.until.map((trigger) => trigger.startsWith("said ") ? `every agent's ${trigger.slice(5)} stands` : trigger) : input.until;
  return [
    `You are ${input.seat.name}, one of ${input.seats.length} agents working on one goal in SharedNet Room ${input.roomId}.${others.length > 0 ? ` The others: ${others.join(", ")}.` : ""}`,
    "",
    `The goal (message #${input.goalSequence}):`,
    "<goal>",
    input.goal.trim(),
    "</goal>",
    "",
    `The Room ends when the first of these happens: ${ends.join("; ")}.`,
    ...(claims.length === 0 ? [] : input.consensus ? [
      `When you believe the goal is met, check the shared directory as it is now, then say ${claims.join(" or ")} in the Room, with \`sharednet say\`, as a message of its own: your own final reply is not posted. It stands until you say something else or anyone changes the shared directory; once every agent's stands, the Room ends${checked ? " if the check passes" : ""}. If you disagree with a teammate's, say why.`,
    ] : [`Say ${claims.join(" or ")} in the Room only when you believe the goal is met: saying it runs the check.`]),
    "",
    `You share this directory (${CONTAINER_WORKSPACE}) with the others, and only this one: each of you works in its own container, so what you install elsewhere is yours alone. Talk to them only through the Room, with the sharednet command:`,
    "  sharednet read --last 30 --json    what has been said",
    '  sharednet say "…" --json          say something; keep it short',
    ...(input.roomType === "compiled" ? [COMPILED_HELP] : []),
    ...(input.messageRouting === "mentions" ? [
      "Messages mentioning known teammates wake only those teammates. No mention, @all, or unknown-only names broadcast. Explicit board reads still show all messages. Use exact teammate names from the roster.",
      "Do not run `sharednet wait` or `sharednet watch`: end your turn when waiting; the runner supplies messages routed to you.",
    ] : ["Do not run `sharednet wait` or `sharednet watch`: when your turn ends, you are woken with whatever is said next."]),
    "Lines from `runner` are the goal's machinery, such as a check's result, not a person.",
    "Agree in the Room who does what, do your part, and end your turn when there is nothing more to do now.",
    ...(input.mentionGate ? [MENTION_HELP] : []),
    ...(input.taskGate ? [TASK_HELP] : []),
  ].join("\n");
}

/** What a woken Agent is told: everything said since its last turn. */
export function wakePrompt(wake: WakeShape): string {
  const lines = wake.messages.map((message) => `#${message.sequence} ${message.sender?.name ?? message.sender?.member_id ?? "someone"}: ${message.content}`);
  return [`New in the Room since your last turn (#${wake.from + 1} to #${wake.through}):`, ...lines, "", "Carry on with the goal."].join("\n");
}

/** One turn: a fresh harness run, or the same session resumed, with nothing asked of a person. */
/** Whether the Agents may search the web: on by default, off for a benchmark that forbids it. */
export type WebSearch = "live" | "off";

export function turnCommand(seat: AgentSpec, prompt: string, sessionId: string | null, webSearch: WebSearch = "live", turnLimitSeconds = TURN_LIMIT_SECONDS, openaiBaseUrl: string | null = null): string[] {
  const limit = ["timeout", String(turnLimitSeconds)];
  if (seat.driver === "codex") {
    // Live web search, which Claude Code has by default: a goal is as often research as code.
    const search = webSearch === "live" ? 'web_search="live"' : 'web_search="disabled"';
    // Codex takes its API's address from its config, not from OPENAI_BASE_URL.
    const base = openaiBaseUrl === null ? [] : ["-c", `openai_base_url="${openaiBaseUrl}"`];
    const flags = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", search, ...base, ...(seat.model ? ["-m", seat.model] : [])];
    return sessionId === null ? [...limit, "codex", "exec", ...flags, prompt] : [...limit, "codex", "exec", "resume", ...flags, sessionId, prompt];
  }
  return [
    ...limit,
    "claude",
    "-p",
    // A list option takes every argument up to the next flag, so it stands before the other flags.
    ...(webSearch === "off" ? ["--disallowedTools", "WebSearch", "WebFetch"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(seat.model ? ["--model", seat.model] : []),
    ...(sessionId === null ? [] : ["--resume", sessionId]),
    prompt,
  ];
}

/** Tokens as a harness reports them: read fresh, read again from the cache, and written. */
export interface Usage {
  input: number;
  cached: number;
  output: number;
}

/**
 * What a budget is judged on: tokens read fresh plus tokens written. The cached context a harness
 * reads again on every model call is most of the raw count (93% in the first real run) at a tenth
 * of the price, so it is recorded and not counted.
 */
export function freshTokens(usage: Usage | null): number {
  return usage ? usage.input + usage.output : 0;
}

function numberAt(record: Record<string, unknown> | null | undefined, key: string): number {
  return typeof record?.[key] === "number" ? (record[key] as number) : 0;
}

/** Codex counts cached input inside input_tokens. */
function codexUsage(raw: Record<string, unknown>): Usage {
  const cached = numberAt(raw, "cached_input_tokens");
  return { input: Math.max(0, numberAt(raw, "input_tokens") - cached), cached, output: numberAt(raw, "output_tokens") };
}

/** A Codex session file's own running total: exact, and it includes a turn that the end of the goal cut. */
export function codexSessionUsage(rollout: string): Usage | null {
  let last: Usage | null = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null } };
      const total = event.payload?.info?.total_token_usage;
      if (event.type === "event_msg" && event.payload?.type === "token_count" && total) last = codexUsage(total);
    } catch {
      // A line cut off mid-write says nothing.
    }
  }
  return last;
}

export interface TurnReading {
  sessionId: string | null;
  /**
   * Codex: the session's running total as of this turn, since a resumed `codex exec` reports the
   * whole session's usage. Claude Code: this run's own usage.
   */
  usage: Usage | null;
  failed: boolean;
}

/** Reads a harness's JSON stream for what the runner needs: the session to resume, and the spend. */
export class TurnReader {
  readonly reading: TurnReading = { sessionId: null, usage: null, failed: false };
  private readonly driver: Driver;

  constructor(driver: Driver) {
    this.driver = driver;
  }

  line(text: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = (event.usage ?? null) as Record<string, unknown> | null;
    if (this.driver === "codex") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") this.reading.sessionId = event.thread_id;
      if (event.type === "turn.completed" && usage) this.reading.usage = codexUsage(usage);
      if (event.type === "turn.failed" || event.type === "error") this.reading.failed = true;
      return;
    }
    if (typeof event.session_id === "string") this.reading.sessionId = event.session_id;
    if (event.type === "result") {
      if (usage) {
        this.reading.usage = {
          input: numberAt(usage, "input_tokens") + numberAt(usage, "cache_creation_input_tokens"),
          cached: numberAt(usage, "cache_read_input_tokens"),
          output: numberAt(usage, "output_tokens"),
        };
      }
      if (event.is_error === true) this.reading.failed = true;
    }
  }
}

// ---- the run ----

export interface SeatRecord {
  name: string;
  driver: Driver;
  model: string | null;
  member_id: string | null;
  session_id: string | null;
  turns: number;
  failed_turns: number;
  /** Fresh tokens: what a budget counts. */
  tokens: number;
  usage: Usage;
}

export interface GoalRunInput {
  plan: RunPlan;
  roomId: string;
  roomType?: "board" | "compiled";
  inviteToken: string;
  goal: string;
  goalSequence: number;
  until: string[];
  baseUrl: string;
  out: string;
  checkEveryMs: number;
  quietChecks: boolean;
  /** `off` takes web search away from every Agent; the default is `live`. */
  webSearch?: WebSearch;
  /** The longest one turn may run; the default is 20 minutes. An experiment may set it to the run's own limit. */
  turnLimitMs?: number;
  /** Opt-in board controls. Mention gates default to targeted wakes unless overridden. */
  mentionGate?: boolean;
  taskGate?: boolean;
  messageRouting?: MessageRouting;
  /** Each Agent's `said` is its own claim of the workspace as it is; the Room ends once every one stands. */
  consensus?: boolean;
}

export interface GoalRunDependencies {
  docker: DockerRunner;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
}

export interface GoalRunResult extends GoalWatchResult {
  agents: SeatRecord[];
  tokens: number;
}

/** Creates nothing outside its containers and the record; the Room and its goal already exist. */
export async function runGoal(
  client: ApiClient,
  memberToken: string,
  apiKey: string,
  input: GoalRunInput,
  dependencies: GoalRunDependencies,
): Promise<GoalRunResult> {
  const { docker, plan } = { docker: dependencies.docker, plan: input.plan };
  const log = dependencies.stderr ?? (() => undefined);
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const checks = containerName(input.roomId);
  const containers = runContainers(input.roomId, plan.agents);
  const turnLimitSeconds = Math.round((input.turnLimitMs ?? TURN_LIMIT_SECONDS * 1000) / 1000);
  const base = input.baseUrl;
  const user = plan.agentUser ?? AGENT_USER;
  const isolation = plan.isolation ?? null;
  const isolated = isolation !== null;
  const names = isolationNames(input.roomId);
  // An isolated Agent reaches SharedNet only through the gateway, which its container forwards to
  // its own loopback: the one plain-HTTP address the CLI accepts.
  const seatBase = isolated ? `http://127.0.0.1:${GATEWAY_PORTS.sharednet}` : base;
  const addresses: Record<string, string> = {};
  const messageRouting = input.messageRouting ?? (input.mentionGate ? "mentions" : "broadcast");
  if (input.roomType === "compiled" && (input.mentionGate || input.taskGate || messageRouting === "mentions")) throw localError("invalid_arguments", "The mention/task controls are for plain board Rooms.");
  await mkdir(input.out, { recursive: true });
  const wakeLog = join(input.out, "wakes.ndjson");
  await writeFile(wakeLog, "");

  /** An Agent's container: the shared workspace, this CLI, and a Codex seat's login; idle until a turn runs in it. */
  const startContainer = (seat: SeatRecord) => docker([
    "run",
    "--detach",
    "--name",
    containerName(input.roomId, seat.name),
    ...(isolated ? ["--network", names.network] : ["--add-host", "host.docker.internal:host-gateway"]),
    "--volume",
    `${plan.workspace}:${CONTAINER_WORKSPACE}`,
    "--volume",
    `${plan.cli.root}:${CONTAINER_CLI}:ro`,
    ...(seat.driver === "codex" && plan.codexAuth?.kind === "login" ? ["--volume", `${plan.codexAuth.file}:${CONTAINER_CODEX_AUTH}`] : []),
    plan.image,
    "sleep",
    "infinity",
  ]);
  /** The checks' container: the image and the shared workspace, and nothing an Agent installed or holds. */
  const startChecks = () => docker(["run", "--detach", "--name", checks, ...(isolated ? ["--network", names.network] : []), "--volume", `${plan.workspace}:${CONTAINER_WORKSPACE}`, plan.image, "sleep", "infinity"]);
  /** An isolated run's internal network and its gateway, the network's one way out; up before any Agent starts. */
  const startGateway = async () => {
    const created = await docker(["network", "create", "--internal", names.network]);
    if (created.code !== 0) throw localError("container_failed", `The run's internal network could not be made: ${created.stderr.trim()}`);
    const loopback = loopbackPort(base);
    const template = gatewayTemplate({
      sharednet: loopback === null ? base : `http://host.docker.internal:${loopback}`,
      isolation: isolation!,
      codex: plan.codexAuth !== null,
      claudeAuth: plan.claudeAuth,
    });
    const keys = [...(plan.codexAuth !== null ? ["OPENAI_API_KEY"] : []), ...(plan.claudeAuth !== null ? [plan.claudeAuth] : [])];
    const started = await docker(
      [
        "run",
        "--detach",
        "--name",
        names.gateway,
        ...(loopback === null ? [] : ["--add-host", "host.docker.internal:host-gateway"]),
        "-e",
        "GATEWAY_TEMPLATE",
        ...keys.flatMap((key) => ["-e", key]),
        GATEWAY_IMAGE,
        "sh",
        "-c",
        'mkdir -p /etc/nginx/templates && printf "%s" "$GATEWAY_TEMPLATE" > /etc/nginx/templates/default.conf.template && exec /docker-entrypoint.sh nginx -g "daemon off;"',
      ],
      { env: { GATEWAY_TEMPLATE: template } },
    );
    if (started.code !== 0) throw localError("container_failed", `The run's gateway did not start: ${started.stderr.trim()}`);
    const joined = await docker(["network", "connect", "--alias", GATEWAY_ALIAS, names.network, names.gateway]);
    if (joined.code !== 0) throw localError("container_failed", `The gateway could not join the run's network: ${joined.stderr.trim()}`);
    // Listening once nginx has written its configuration from the template.
    const port = GATEWAY_PORTS.sharednet.toString(16).toUpperCase().padStart(4, "0");
    let listening = false;
    for (let attempt = 0; attempt < 40 && !listening; attempt += 1) {
      listening = (await docker(["exec", names.gateway, "sh", "-c", `grep -q ":${port} " /proc/net/tcp`])).code === 0;
      if (!listening) await sleep(250);
    }
    if (!listening) throw localError("container_failed", "The run's gateway did not start listening.");
  };

  let ended = false;
  const records: SeatRecord[] = plan.agents.map((agent) => ({
    ...agent,
    member_id: null,
    session_id: null,
    turns: 0,
    failed_turns: 0,
    tokens: 0,
    usage: { input: 0, cached: 0, output: 0 },
  }));
  /** A seat's usage: Codex reports the session's running total, Claude Code each run's own. */
  const account = (seat: SeatRecord, usage: Usage | null, sessionTotal: boolean) => {
    if (!usage) return 0;
    const before = seat.tokens;
    seat.usage = sessionTotal
      ? usage
      : { input: seat.usage.input + usage.input, cached: seat.usage.cached + usage.cached, output: seat.usage.output + usage.output };
    seat.tokens = freshTokens(seat.usage);
    return seat.tokens - before;
  };
  const spend = () => records.reduce((sum, record) => sum + record.tokens, 0);
  const exec = (seat: SeatRecord | null, command: readonly string[], options: { env?: Record<string, string>; onLine?: (line: string) => void; through?: number } = {}) => {
    const home = seat ? `${CONTAINER_HOMES}/${seat.name}` : null;
    const controls = seat?.member_id && home ? controlPaths({ HOME: home }, { base_url: seatBase, room_id: input.roomId, member_id: seat.member_id }) : null;
    const environment = [
      ...(home ? ["-e", `HOME=${home}`] : []),
      ...(home && seat?.driver === "codex" ? ["-e", `CODEX_HOME=${home}/.codex`] : []),
      "-e",
      `SHAREDNET_BASE_URL=${seatBase}`,
      ...(seat?.member_id ? ["-e", `SHAREDNET_SEAT=${seat.member_id}`] : []),
      // This runner wakes its seats itself. Whatever a seat runs, its join or an agent's own
      // `sharednet join rom_…` in a turn, starts no wake service of its own.
      ...(seat ? ["-e", "SHAREDNET_WAKE=off"] : []),
      ...(seat && input.mentionGate ? ["-e", "SHAREDNET_MENTION_GATE=1"] : []),
      ...(seat && options.through !== undefined ? ["-e", `SHAREDNET_TURN_THROUGH=${options.through}`] : []),
      ...(controls && input.taskGate ? ["-e", "SHAREDNET_TASK_GATE=1", "-e", `SHAREDNET_TASK_FILE=${controls.tasks}`, "-e", `SHAREDNET_TASK_AUDIT=${join(controls.root, "shell-blocks.tsv")}`, "-e", "SHAREDNET_TASK_PROFILE=/etc/profile.d/sharednet-task.sh"] : []),
      // Isolated, a seat holds a placeholder where its harness wants a key, and its requests go to the gateway, which signs them.
      ...(seat?.driver === "claude-code" && plan.claudeAuth
        ? isolated
          ? ["-e", `${plan.claudeAuth}=${KEY_PLACEHOLDERS[plan.claudeAuth]}`, "-e", `ANTHROPIC_BASE_URL=http://${GATEWAY_ALIAS}:${GATEWAY_PORTS.anthropic}`]
          : ["-e", plan.claudeAuth]
        : []),
      ...(seat?.driver === "codex" && plan.codexAuth?.kind === "api-key"
        ? isolated
          ? ["-e", `OPENAI_API_KEY=${KEY_PLACEHOLDERS.OPENAI_API_KEY}`]
          : ["-e", "OPENAI_API_KEY"]
        : []),
      ...Object.keys(options.env ?? {}).flatMap((name) => ["-e", name]),
    ];
    return docker(["exec", "--user", user, "--workdir", CONTAINER_WORKSPACE, ...environment, seat ? containerName(input.roomId, seat.name) : checks, ...command], options);
  };

  /** The checks' container, then each Agent's container and seat; a start that fails closes the Room it opened. */
  const setUp = async () => {
    if (isolated) await startGateway();
    const checker = await startChecks();
    if (checker.code !== 0) throw localError("container_failed", `The checks' container did not start: ${checker.stderr.trim()}`);
    // Isolated, each container forwards its loopback to the gateway; otherwise only a development service is forwarded, to this machine.
    const port = isolated ? GATEWAY_PORTS.sharednet : loopbackPort(base);
    const forwardTo = isolated ? [GATEWAY_ALIAS] : [];
    // The Agents' `sharednet` is this CLI, so they speak the version that started them.
    const entry = `${CONTAINER_CLI}/${plan.cli.entry}`;
    const wrapper = `#!/bin/sh\nexec node ${entry.endsWith(".ts") ? "--experimental-strip-types --no-warnings " : ""}${entry} "$@"\n`;

    // Every seat: its own container, its own home, its own sign-in, its own seat in the Room.
    for (const seat of records) {
      const container = containerName(input.roomId, seat.name);
      const started = await startContainer(seat);
      if (started.code !== 0) throw localError("container_failed", `${seat.name}'s container did not start: ${started.stderr.trim()}`);
      // An image other than the default one may have no home for the Agents: made here, as root, for the Agents' user.
      const homes = await docker(["exec", "--user", "root", container, "sh", "-c", `mkdir -p ${CONTAINER_HOMES} && chown ${user} ${CONTAINER_HOMES}`]);
      if (homes.code !== 0) throw localError("container_failed", `${seat.name}'s container has no place for homes: ${homes.stderr.trim()}`);
      if (isolated) {
        const address = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${names.network}").IPAddress}}`, container]);
        if (address.code === 0 && address.stdout.trim()) addresses[seat.name] = address.stdout.trim();
      }
      if (port !== null) {
        await docker(["exec", "--detach", "--user", user, container, "node", "-e", FORWARDER, String(port), ...forwardTo]);
        let listening = false;
        for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
          listening = (await docker(["exec", "--user", user, container, "node", "-e", FORWARDER_PROBE, String(port)])).code === 0;
          if (!listening) await sleep(250);
        }
        if (!listening) throw localError("container_failed", isolated ? `${seat.name}'s container could not reach the run's gateway.` : `${seat.name}'s container could not reach this machine's port ${port}.`);
      }
      const installed = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "cat > /usr/local/bin/sharednet && chmod 755 /usr/local/bin/sharednet"], { input: wrapper });
      if (installed.code !== 0) throw localError("container_failed", `The sharednet command could not be put in ${seat.name}'s container: ${installed.stderr.trim()}`);
      if (input.taskGate) {
        const guarded = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "mkdir -p /etc/profile.d && cat > /etc/profile.d/sharednet-task.sh && chmod 644 /etc/profile.d/sharednet-task.sh"], { input: TASK_PROFILE });
        if (guarded.code !== 0) throw localError("container_failed", "Could not install the task shell guard.");
        if (seat.driver === "claude-code") {
          const hook = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "mkdir -p /usr/local/lib && cat > /usr/local/lib/sharednet-task-hook.cjs && chmod 644 /usr/local/lib/sharednet-task-hook.cjs"], { input: TASK_HOOK });
          if (hook.code !== 0) throw localError("container_failed", "Could not install the Claude task hook.");
        }
      }
      const home = `${CONTAINER_HOMES}/${seat.name}`;
      const setup =
        seat.driver === "codex"
          ? plan.codexAuth?.kind === "login"
            ? `mkdir -p ${home}/.codex && ln -sf ${CONTAINER_CODEX_AUTH} ${home}/.codex/auth.json`
            : `mkdir -p ${home}/.codex && printf '{"OPENAI_API_KEY": "%s"}' "$OPENAI_API_KEY" > ${home}/.codex/auth.json && chmod 600 ${home}/.codex/auth.json`
          : `mkdir -p ${home}`;
      const prepared = await exec(seat, ["sh", "-c", setup]);
      if (prepared.code !== 0) throw localError("container_failed", `${seat.name}'s home could not be made: ${prepared.stderr.trim()}`);
      // The driver's own marker names the seat's runtime on the Web; the invite travels by environment.
      const marker: Record<string, string> = seat.driver === "codex" ? { CODEX_SESSION_ID: `goal-${seat.name}` } : { CLAUDECODE: "1" };
      const joined = await exec(seat, ["sharednet", "join", input.roomId, "--name", seat.name, "--json"], {
        env: { ...marker, SHAREDNET_INVITE_TOKEN: input.inviteToken },
      });
      const memberId = (() => {
        try {
          return (JSON.parse(joined.stdout) as { member_id?: string }).member_id ?? null;
        } catch {
          return null;
        }
      })();
      if (joined.code !== 0 || !memberId) throw localError("join_failed", `${seat.name} could not join the Room: ${(joined.stdout + joined.stderr).trim().slice(0, 400)}`);
      seat.member_id = memberId;
      if (input.taskGate) {
        const paths = controlPaths({ HOME: home }, { base_url: seatBase, room_id: input.roomId, member_id: memberId });
        const made = await exec(seat, ["mkdir", "-p", paths.root]);
        if (made.code !== 0) throw localError("container_failed", "Could not create local task state.");
      }
    }
    log(`goal: ${records.map((seat) => `${seat.name} (${seat.member_id})`).join(", ")} joined ${input.roomId}\n`);
  };

  try {
    try {
      await setUp();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "error";
      await client
        .request("POST", `/rooms/${encodeURIComponent(input.roomId)}/close`, apiKey, { detail: `goal run could not start: ${reason}`.slice(0, 2_000) })
        .catch(() => undefined);
      throw error;
    }

    const runTurn = async (seat: SeatRecord, prompt: string, wake: WakeShape | null) => {
      if (input.roomType === "compiled") {
        // The CLI inside the seat's container holds its own credential; the owner cannot render its obligations.
        const opened = await exec(seat, ["sharednet", "open", "--json"]);
        if (opened.code !== 0) throw localError("state_unavailable", "Could not read this seat's compiled Room state.");
        let state: CompiledState;
        try { state = JSON.parse(opened.stdout) as CompiledState; }
        catch { throw localError("invalid_server_response", "The compiled Room state was not JSON."); }
        if (typeof state.obligations !== "string") throw localError("invalid_server_response", "The compiled Room state has no personal obligations.");
        prompt += `\n\n${compiledPrompt(state, false)}`;
      }
      seat.turns += 1;
      const number = String(seat.turns).padStart(3, "0");
      const directory = join(input.out, "agents", seat.name);
      await mkdir(directory, { recursive: true });
      const stream = join(directory, `turn-${number}.jsonl`);
      await writeFile(stream, "");
      const reader = new TurnReader(seat.driver);
      const startedAt = dependencies.now().toISOString();
      let writes = Promise.resolve();
      const command = turnCommand(seat, prompt, seat.session_id, input.webSearch ?? "live", turnLimitSeconds, isolated ? `http://${GATEWAY_ALIAS}:${GATEWAY_PORTS.openai}/v1` : null);
      if (input.taskGate && seat.driver === "claude-code") command.splice(command.length - 1, 0, "--settings", TASK_HOOK_SETTINGS);
      const result = await exec(seat, command, {
        through: wake?.through ?? input.goalSequence,
        onLine: (line) => {
          reader.line(line);
          writes = writes.then(() => appendFile(stream, `${line}\n`));
        },
      });
      await writes;
      if (result.stderr.trim()) await writeFile(join(directory, `turn-${number}.stderr.txt`), result.stderr);
      const reading = reader.reading;
      seat.session_id = reading.sessionId ?? seat.session_id;
      const spent = account(seat, reading.usage, seat.driver === "codex");
      // A turn the end of the goal stopped did not fail; its spend is lost with it, as the harness reports at a turn's end.
      const cut = ended && result.code !== 0;
      const failed = !cut && (result.code !== 0 || reading.failed);
      if (failed) seat.failed_turns += 1;
      await appendFile(
        wakeLog,
        `${JSON.stringify({
          seat: seat.name,
          turn: seat.turns,
          wake_id: wake?.wake_id ?? null,
          fired: wake?.fired ?? ["goal"],
          from: wake?.from ?? null,
          through: wake?.through ?? null,
          messages: wake?.messages.length ?? 0,
          started_at: startedAt,
          ended_at: dependencies.now().toISOString(),
          exit_code: result.code,
          failed,
          session_id: seat.session_id,
          tokens: spent,
          cut_by_end: cut,
        })}\n`,
      );
      return failed;
    };

    // The Agents that have stopped for good: a claim of being done is no longer waited for from them.
    const stopped = new Set<string>();

    // Every seat starts once. Subsequent wakes follow the configured routing policy.
    const seatLoop = async (seat: SeatRecord) => {
      let prompt = openingPrompt({ seat, seats: records, roomType: input.roomType, roomId: input.roomId, goal: input.goal, goalSequence: input.goalSequence, until: input.until, mentionGate: input.mentionGate, taskGate: input.taskGate, messageRouting, consensus: input.consensus });
      let wake: WakeShape | null = null;
      let failedInARow = 0;
      while (!ended) {
        const failed = await runTurn(seat, prompt, wake);
        if (wake?.wake_id) await exec(seat, ["sharednet", "ack", wake.wake_id, "--json"]);
        failedInARow = failed ? failedInARow + 1 : 0;
        if (ended) break;
        if (failedInARow >= FAILED_TURNS_LIMIT) {
          log(`goal: ${seat.name} failed ${FAILED_TURNS_LIMIT} turns in a row and takes no more; see agents/${seat.name}/\n`);
          stopped.add(seat.name);
          break;
        }
        while (!ended) {
          const waited = await exec(seat, ["sharednet", "wait", "--on", "message", "--on", "closed", "--settle", "2s", "--ack", "manual", "--json"]);
          if (ended || waited.code !== 0) return;
          let raw: WakeShape;
          try { raw = JSON.parse(waited.stdout) as WakeShape; } catch { return; }
          if (raw.fired.includes("closed")) return;
          wake = routeWake(raw, seat, records, messageRouting);
          if (input.taskGate) wake = withoutTaskActs(wake);
          const delivered = wake.messages.map(message => message.sequence);
          if (messageRouting === "mentions" || input.taskGate) await appendFile(join(input.out, "routing.ndjson"), `${JSON.stringify({ at: dependencies.now().toISOString(), seat: seat.name, wake_id: raw.wake_id, from: raw.from, through: raw.through, delivered, skipped: raw.messages.filter(m => !delivered.includes(m.sequence)).map(m => m.sequence), model_wake: delivered.length > 0 })}\n`);
          if (delivered.length > 0 || (messageRouting === "broadcast" && !input.taskGate)) break;
          if (raw.wake_id) await exec(seat, ["sharednet", "ack", raw.wake_id, "--json"]);
        }
        if (ended || !wake) return;
        prompt = wakePrompt(wake);
      }
    };
    const seats = records.map((seat) =>
      seatLoop(seat).catch((error: unknown) => {
        stopped.add(seat.name);
        log(`goal: ${seat.name} stopped (${error instanceof Error ? error.message : "error"})\n`);
      }),
    );

    const watched = await goalWatch(
      client,
      memberToken,
      apiKey,
      {
        roomId: input.roomId,
        workspace: plan.workspace,
        out: input.out,
        checkEveryMs: input.checkEveryMs,
        quietChecks: input.quietChecks,
        ...(input.consensus ? { consensus: true } : {}),
      },
      {
        now: dependencies.now,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        stderr: log,
        // A check runs in its own container, on the shared workspace: what one Agent installed for itself does not count.
        check: async (command) => {
          const result = await exec(null, ["sh", "-c", command]);
          return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
        },
        spend,
        claimants: () => records.filter((seat) => seat.member_id && !stopped.has(seat.name)).map((seat) => ({ id: seat.member_id!, name: seat.name })),
      },
    );
    ended = true;
    // Stopping the containers ends every turn and every wait still running.
    await docker(["stop", "--time", "5", ...containers]);
    await Promise.all(seats);

    // Each Agent's own trace is its home: Codex keeps sessions in ~/.codex, Claude Code in ~/.claude.
    for (const seat of records) {
      const target = join(input.out, "agents", seat.name, "home");
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      const copied = await docker(["cp", `${containerName(input.roomId, seat.name)}:${CONTAINER_HOMES}/${seat.name}`, target]);
      if (copied.code !== 0) log(`goal: ${seat.name}'s home could not be copied out: ${copied.stderr.trim()}\n`);
      await scrubHome(target);
      // The record's numbers come from the session's own file when there is one: it saw every turn, a cut one included.
      if (seat.driver === "codex" && seat.session_id) {
        const usage = await sessionFileUsage(join(target, ".codex", "sessions"), seat.session_id);
        if (usage) account(seat, usage, true);
      }
    }
    // An isolated run's gateway saw every request that left a container: its log is part of the record.
    // Its own logs only: the image's access.log and error.log are links to the console, read with `docker logs`.
    if (isolated) {
      const target = join(input.out, "gateway");
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      const logs = ["sharednet", ...(plan.codexAuth !== null ? ["openai"] : []), ...(plan.claudeAuth !== null ? ["anthropic"] : [])];
      for (const name of logs) {
        const copied = await docker(["cp", `${names.gateway}:/var/log/nginx/${name}.log`, join(target, `${name}.log`)]);
        if (copied.code !== 0) log(`goal: the gateway's ${name} log could not be copied out: ${copied.stderr.trim()}\n`);
      }
      const printed = await docker(["logs", names.gateway]);
      await writeFile(join(target, "nginx.log"), `${printed.stdout}${printed.stderr}`);
    }
    const episodePath = join(input.out, "episode.json");
    const episode = JSON.parse(await readFile(episodePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      episodePath,
      `${JSON.stringify(
        {
          ...episode,
          image: plan.image,
          agent_user: user,
          isolated,
          ...(isolated ? { addresses } : {}),
          web_search: input.webSearch ?? "live",
          turn_limit_s: turnLimitSeconds,
          mention_gate: input.mentionGate ?? false,
          task_gate: input.taskGate ?? false,
          message_routing: messageRouting,
          consensus: input.consensus ?? false,
          agents: records,
          totals: { ...(episode.totals as object), tokens: spend(), cached_tokens: records.reduce((sum, seat) => sum + seat.usage.cached, 0) },
        },
        null,
        2,
      )}\n`,
    );
    return { ...watched, agents: records, tokens: spend() };
  } finally {
    ended = true;
    await docker(["rm", "--force", ...containers]);
    if (isolated) {
      await docker(["rm", "--force", names.gateway]);
      await docker(["network", "rm", names.network]);
    }
  }
}

/** The usage in a Codex home's session file for one session, read after the run. */
async function sessionFileUsage(sessions: string, sessionId: string): Promise<Usage | null> {
  const files = await readdir(sessions, { recursive: true }).catch(() => [] as string[]);
  const file = files.find((name) => name.endsWith(`${sessionId}.jsonl`));
  return file ? codexSessionUsage(await readFile(join(sessions, file), "utf8")) : null;
}

/** A record is made to be handed on: the seat's token and the harness's sign-in leave it. */
export async function scrubHome(home: string): Promise<void> {
  for (const secret of [".config/sharednet", ".codex/auth.json", ".claude/.credentials.json"]) {
    await rm(join(home, secret), { recursive: true, force: true });
  }
}
