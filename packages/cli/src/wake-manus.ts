import { checkFromSteps, skipRest, type CheckOptions, type CheckResult, type CheckStep, type Delivery, type DeliveryContext, type Environment, type PluginNet, type SeatWake, type WakeInput, type WakePlugin } from "./wake-driver.ts";

/**
 * The `manus` wake plugin (docs/wake-plugins.md): a Manus task (manus.im) is the session.
 *
 * Manus is a cloud agent, so there is no program to resume. A task is continued over its REST API (v2,
 * https://open.manus.ai/docs/v2/introduction): `POST /v2/task.sendMessage` hands it the lines, and the
 * reply is read by polling `GET /v2/task.listMessages` until the task's agent status leaves `running`
 * (https://open.manus.ai/docs/v2/task-lifecycle). Webhooks need a public address, which a laptop has
 * not, so this polls: with a growing delay, for no longer than the seat's wake limit (context.timeoutMs,
 * at most 2 hours), and it stops at the first terminal state. A seat without a task id starts a fresh task per wake (`POST /v2/task.create`).
 *
 * The key (`x-manus-api-key`) is read at delivery time from the environment variable the wake names
 * (`api_key_env`, default MANUS_API_KEY) in the process that runs `serve`. It is never written to the
 * seat file. The wake's `command` holds the API address, https only (or loopback, for a stand-in).
 *
 * Race handled here: right after `sendMessage` a task may still read `stopped` from its previous run, so
 * the status is only trusted from events newer than the newest one seen before sending, and only once
 * this wake's own message (or a `running` status) has appeared.
 */

export const MANUS_API = "https://api.manus.ai";
export const MANUS_KEY_ENV = "MANUS_API_KEY";
const RETRY_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 60_000;
/** Polls start at 3 s and back off by half again each time, up to 30 s: about 100 reads in 40 minutes, far under 100 a minute. */
const POLL_FIRST_MS = 3_000;
const POLL_MAX_MS = 30_000;
/**
 * However long the seat's wake limit is (up to 24 h), one wake waits for Manus no longer than this: a
 * task still working after it is left running and linked, not watched.
 */
const MAX_WAIT_MS = 2 * 60 * 60_000;
const REQUEST_MS = 30_000;
/** Consecutive failed polls tolerated before the wake is given up (the task itself keeps running). */
const POLL_FAILURES = 5;
/** Manus takes about 5,000 estimated tokens of text per message; longer is a 400. This stays well under. */
const PROMPT_CHARS = 12_000;

interface ManusEvent {
  id?: string;
  type?: string;
  timestamp?: number;
  assistant_message?: { content?: string; delivery_kind?: string; attachments?: Array<{ filename?: string }> };
  error_message?: { content?: string };
  status_update?: { agent_status?: string; status_detail?: { waiting_for_event_type?: string; waiting_description?: string } };
}

type Answer = { ok: true; body: Record<string, any> } | { ok: false; status: number; code: string; message: string };

export function keyEnvOf(wake: SeatWake): string {
  return wake.api_key_env ?? MANUS_KEY_ENV;
}

/** The API address of a wake, or why it may not carry a key: https, or a loopback stand-in. */
export function apiBase(wake: SeatWake): { base: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(wake.command);
  } catch {
    return { error: `${wake.command} is not an address; the Manus API is ${MANUS_API}` };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return { error: "the Manus API address must be https, so the key is not sent in the clear" };
  return { base: url.origin };
}

/**
 * serve's execution-budget paragraph tells a harness to run `sharednet wake checkpoint`, which a cloud task
 * cannot do; the plugin keeps the budget itself, so the paragraph is left out of what Manus is sent.
 */
export function withoutBudget(prompt: string): string {
  return prompt.replace(/\n\nExecution budget:[^\n]*/, "");
}

/** The wake prompt cut to what one Manus message takes: its start (where it was addressed) and its end (what is asked). */
export function fitPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_CHARS) return prompt;
  const head = prompt.slice(0, 2_000);
  const tail = prompt.slice(prompt.length - (PROMPT_CHARS - 2_000));
  return `${head}\n[… middle of the room's lines cut to fit one Manus message; \`sharednet read\` has them …]\n${tail}`;
}

async function call(base: string, key: string, net: Required<PluginNet>, method: "GET" | "POST", path: string, params: Record<string, string> | Record<string, unknown>): Promise<Answer> {
  const url = new URL(path, base);
  const init: RequestInit = { method, headers: { "x-manus-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_MS) };
  if (method === "GET") for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  else {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(params);
  }
  let response: Response;
  try {
    response = await net.fetch(url, init);
  } catch (error) {
    return { ok: false, status: 0, code: "network", message: error instanceof Error ? error.message : String(error) };
  }
  let body: Record<string, any> = {};
  try {
    body = (await response.json()) as Record<string, any>;
  } catch {
    // not JSON: keep the status
  }
  if (response.ok && body.ok !== false) return { ok: true, body };
  const error = (body.error ?? {}) as { code?: string; message?: string };
  return { ok: false, status: response.status, code: error.code ?? `http_${response.status}`, message: (error.message ?? `HTTP ${response.status}`).slice(0, 200) };
}

function net(context: { api?: PluginNet } | undefined): Required<PluginNet> {
  return {
    fetch: context?.api?.fetch ?? globalThis.fetch,
    sleep: context?.api?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: context?.api?.now ?? Date.now,
  };
}

/** A failed call as the delivery it should be: busy when nothing was lost and trying again may work, else failed. */
function refused(answer: Extract<Answer, { ok: false }>, what: string, keyEnv: string, posted = false): Delivery {
  if (answer.status === 429) return { kind: "busy", why: `Manus rate limit on ${what}`, retryMs: RATE_LIMIT_RETRY_MS };
  const unclear = answer.code === "network" || answer.status >= 500;
  // A read that failed lost nothing. A write that failed unclearly may have been taken: sending it again
  // could start a second task or ask twice (each costs credits), so it is reported instead of retried.
  if (unclear && !posted) return { kind: "busy", why: `Manus ${what} did not go through (${answer.message})`, retryMs: RETRY_MS };
  if (unclear) return { kind: "failed", why: `Manus ${what} may or may not have gone through (${answer.message}); not sent again`, detail: `${answer.code} (HTTP ${answer.status})`, timedOut: false };
  const why = answer.status === 401 ? `Manus rejected the API key in ${keyEnv}` : `Manus ${what}: ${answer.message}`;
  return { kind: "failed", why, detail: `${answer.code} (HTTP ${answer.status})`, timedOut: false };
}

const failed = (why: string): Delivery => ({ kind: "failed", why, detail: "", timedOut: false });

/** The events of this wake's turn, oldest first: those after `baseline`, from our own message on. */
function turnEvents(events: ManusEvent[], baseline: number): ManusEvent[] | null {
  const fresh = events.filter((event) => typeof event.timestamp === "number" && event.timestamp > baseline).reverse();
  const mine = fresh.find((event) => event.type === "user_message");
  const running = fresh.find((event) => event.type === "status_update" && event.status_update?.agent_status === "running");
  if (!mine && !running) return null;
  const from = mine?.timestamp ?? running!.timestamp!;
  return fresh.filter((event) => event.timestamp! >= from);
}

/** Reads a turn: still running (null), or how it ended. */
function outcomeOf(turn: ManusEvent[]): { status: "stopped" | "waiting" | "error"; waiting?: string } | null {
  const statuses = turn.filter((event) => event.type === "status_update");
  const last = statuses[statuses.length - 1]?.status_update;
  const status = last?.agent_status;
  if (status === "stopped" || status === "error") return { status };
  if (status === "waiting") return { status, waiting: last?.status_detail?.waiting_description ?? last?.status_detail?.waiting_for_event_type ?? "input" };
  return null;
}

function replyOf(turn: ManusEvent[]): { text: string; files: string[] } | null {
  const said = turn.filter((event) => event.type === "assistant_message" && (event.assistant_message?.content ?? "").trim() !== "");
  const chosen = [...said].reverse().find((event) => event.assistant_message?.delivery_kind === "result") ?? said[said.length - 1];
  if (!chosen) return null;
  const files = (chosen.assistant_message?.attachments ?? []).map((file) => file.filename ?? "file");
  return { text: chosen.assistant_message!.content!.trim(), files };
}

export const manusPlugin: WakePlugin = {
  driver: "manus",
  label: "Manus",
  // A cloud task has no process or environment to recognise: the seat is bound by `wake set manus`.
  capture: () => null,
  async deliver(wake: SeatWake, input: WakeInput, context: DeliveryContext): Promise<Delivery> {
    const keyEnv = keyEnvOf(wake);
    const key = context.env[keyEnv]?.trim();
    if (!key) return failed(`${keyEnv} is not set in the environment of sharednet serve`);
    const where = apiBase(wake);
    if ("error" in where) return failed(where.error);
    const io = net(context);
    const api = (method: "GET" | "POST", path: string, params: Record<string, string> | Record<string, unknown>) => call(where.base, key, io, method, path, params);
    // The seat's wake limit (wake limit, 40 minutes by default) bounds the whole delivery, the lookups and the
    // send included, and never more than MAX_WAIT_MS.
    const deadline = io.now() + Math.min(context.timeoutMs, MAX_WAIT_MS);
    const message = { content: fitPrompt(withoutBudget(input.prompt)) };

    let taskId = wake.session;
    let taskUrl: string | undefined;
    let baseline = 0;
    if (taskId) {
      // A task that is working would take this message into its current run; leave the line for later instead.
      const detail = await api("GET", "/v2/task.detail", { task_id: taskId });
      if (!detail.ok) return refused(detail, "task lookup", keyEnv);
      const task = (detail.body.task ?? {}) as { status?: string; task_url?: string };
      taskUrl = task.task_url;
      if (task.status === "running") return { kind: "busy", why: "its Manus task is still running", retryMs: RETRY_MS };
      const latest = await api("GET", "/v2/task.listMessages", { task_id: taskId, order: "desc", limit: 1 });
      if (!latest.ok) return refused(latest, "message lookup", keyEnv);
      baseline = Math.max(0, ...((latest.body.messages ?? []) as ManusEvent[]).map((event) => event.timestamp ?? 0));
      const sent = await api("POST", "/v2/task.sendMessage", { task_id: taskId, message });
      if (!sent.ok) return refused(sent, "send", keyEnv, true);
    } else {
      const created = await api("POST", "/v2/task.create", { message, interactive_mode: false, title: `SharedNet ${input.seat} in ${input.roomId}`.slice(0, 120) });
      if (!created.ok) return refused(created, "task creation", keyEnv, true);
      taskId = typeof created.body.task_id === "string" ? created.body.task_id : undefined;
      if (!taskId) return failed("Manus created a task but returned no task id");
      taskUrl = typeof created.body.task_url === "string" ? created.body.task_url : undefined;
    }
    const link = taskUrl ?? `https://manus.im/app/${taskId}`;

    let failures = 0;
    let interval = POLL_FIRST_MS;
    for (;;) {
      const left = deadline - io.now();
      if (left <= 0) return failed(`Manus is still working after ${Math.max(1, Math.round(Math.min(context.timeoutMs, MAX_WAIT_MS) / 60_000))} minutes (this seat's wake limit); the task keeps running at ${link}`);
      await io.sleep(Math.min(interval, left));
      interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
      const page = await api("GET", "/v2/task.listMessages", { task_id: taskId, order: "desc", limit: 100 });
      if (!page.ok) {
        if (page.status === 401 || page.status === 404) return refused(page, "reading the reply", keyEnv);
        if (++failures >= POLL_FAILURES) return failed(`Manus could not be read after the message was sent (${page.message}); the task may still answer at ${link}`);
      } else {
        failures = 0;
        const turn = turnEvents((page.body.messages ?? []) as ManusEvent[], baseline);
        const ended = turn ? outcomeOf(turn) : null;
        if (turn && ended) {
          // Stopped, waiting or failed is the end: stop reading as soon as it shows. The one exception is a
          // stop with nothing said yet while background work is still running, which may still say it.
          if (ended.status === "stopped" && !replyOf(turn)) {
            const detail = await api("GET", "/v2/task.detail", { task_id: taskId });
            if (detail.ok && detail.body.task?.has_running_background_jobs === true) continue;
          }
          if (ended.status === "error") {
            const problem = turn.filter((event) => event.type === "error_message").pop()?.error_message?.content;
            return failed(`its Manus task failed${problem ? `: ${problem.slice(0, 160)}` : ""} (${link})`);
          }
          const reply = replyOf(turn);
          if (!reply) return failed(`its Manus task ${ended.status === "waiting" ? "is waiting" : "finished"} without a message (${link})`);
          const notes = [
            ...(reply.files.length > 0 ? [`Manus attached ${reply.files.join(", ")}; they are in the task: ${link}`] : []),
            ...(ended.status === "waiting" ? [`Manus is waiting for ${ended.waiting}; answer by @-mentioning this seat, or open ${link}`] : []),
          ];
          return { kind: "replied", reply: [reply.text, ...notes.map((note) => `(${note})`)].join("\n\n") };
        }
      }
    }
  },
  async check(wake: SeatWake, env: Environment, _run, options: CheckOptions = { call: false }): Promise<CheckResult> {
    // The steps of docs/wake-plugins.md "Checking a wake", for an API: `program` is the key and the address
    // (nothing to start), `signed_in` asks Manus who the key is, `session` asks for the seat's task. No step
    // makes a Manus turn, since that costs credits; the first wake is that proof.
    const steps: CheckStep[] = [];
    const keyEnv = keyEnvOf(wake);
    const key = env[keyEnv]?.trim();
    const where = apiBase(wake);
    if (!key) steps.push({ step: "program", status: "failed", message: `${keyEnv} is not set in this environment` });
    else if ("error" in where) steps.push({ step: "program", status: "failed", message: where.error });
    else steps.push({ step: "program", status: "ok", message: `Manus API at ${where.base}, key in ${keyEnv}` });
    if (!key || "error" in where) return skipRest(steps, options, "the API address or key is not usable");
    const io = net({ api: options.api });
    const me = await call(where.base, key, io, "GET", "/v2/user.me", {});
    steps.push(
      me.ok
        ? { step: "signed_in", status: "ok", message: `Manus accepted the API key in ${keyEnv}` }
        : me.status === 401 || me.status === 403
          ? { step: "signed_in", status: "failed", message: `Manus rejected the API key in ${keyEnv}` }
          : { step: "signed_in", status: "warning", message: `Manus user.me: ${me.message}` },
    );
    if (wake.session) {
      const detail = await call(where.base, key, io, "GET", "/v2/task.detail", { task_id: wake.session });
      steps.push(
        detail.ok
          ? { step: "session", status: "ok", message: `task ${wake.session} exists (${String(detail.body.task?.status ?? "status unknown")})` }
          : detail.status === 404 || detail.code === "not_found"
            ? { step: "session", status: "failed", message: `Manus has no task ${wake.session} for this key; set it again with \`wake set manus --resume <task id>\`` }
            : { step: "session", status: "warning", message: `task ${wake.session} could not be looked up: ${detail.message}` },
      );
    } else {
      steps.push({ step: "session", status: "ok", message: "no task id: every wake starts a new task" });
    }
    if (options.call) steps.push({ step: "call", status: "skipped", message: "a Manus turn costs credits; the first wake is the proof" });
    return checkFromSteps(steps);
  },
};
