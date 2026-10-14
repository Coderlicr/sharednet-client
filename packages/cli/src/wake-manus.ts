import { randomUUID } from "node:crypto";

import { checkFromSteps, skipRest, type CheckOptions, type CheckResult, type CheckStep, type Delivery, type DeliveryContext, type Environment, type PluginNet, type SeatWake, type WakeInput, type WakePlugin } from "./wake-driver.ts";

/**
 * The `manus` wake plugin (docs/wake-plugins.md): a Manus task (manus.im) is the session.
 *
 * Manus is a cloud agent, so there is no program to resume. A task is continued over its REST API (v2,
 * https://open.manus.ai/docs/v2/introduction): `POST /v2/task.sendMessage` hands it the lines, and the
 * reply is read by polling `GET /v2/task.listMessages` and `GET /v2/task.detail`, as the lifecycle guide
 * prescribes (https://open.manus.ai/docs/v2/task-lifecycle). Webhooks need a public address, which a laptop
 * has not, so this polls. A seat without a task id starts a fresh task per wake (`POST /v2/task.create`).
 *
 * Lifecycle rules from that guide, and what this does with each:
 * - `stopped` is not final. `task.detail.has_running_background_jobs` decides: `true` keeps polling, `false`
 *   lets the result be consumed, and an omitted field is unknown (a later read may fill it), so it keeps
 *   polling too. The same read is made before sending into a task that is already stopped.
 * - `waiting` has three cases. `messageAskUser`/`cascadeAskUser` are answered with an ordinary message
 *   (`task.sendMessage`), which is what the next wake does. An action confirmation is a `task.confirmAction`
 *   decision that approves a side effect (a command, an email, a deploy); it is never made from a Room, and
 *   a message sent into it would skip the action, so nothing is sent while one is pending. Any other type
 *   is not dispatched either. The reply says which case it is.
 * - A reply's Markdown links are rendered as https://open.manus.ai/docs/v2/attachments says: http(s) kept,
 *   a path that matches an attachment named (never linked, a link in a Room is readable by all of it), any
 *   other destination removed.
 *
 * The key (`x-manus-api-key`) is read at delivery time from the environment variable the wake names
 * (`api_key_env`, default MANUS_API_KEY) in the process that runs `serve`; serve hands this plugin that one
 * variable and withholds it from every program it starts (wake-driver.ts withholdSecretEnv). It is never
 * written to the seat file. The key is only ever sent to https://api.manus.ai (a loopback stand-in needs
 * SHAREDNET_MANUS_ALLOW_LOOPBACK=1), and a redirect is an error, not followed.
 *
 * Every request, sleep and page of reading is bounded by the one delivery deadline (the seat's wake limit,
 * at most two hours) and by serve's stop signal.
 *
 * Race handled here: right after `sendMessage` a task may still read `stopped` from its previous run, so
 * the status is only trusted from events newer than the newest one seen before sending, and only once this
 * wake's own message (or a `running` status) has appeared. That marker's time is kept once seen, and
 * reading pages back through the events until it, so a long run cannot push it out of view.
 */

export const MANUS_API = "https://api.manus.ai";
export const MANUS_KEY_ENV = "MANUS_API_KEY";
/** A stand-in on this machine may take the key only when the person says so. */
export const ALLOW_LOOPBACK_ENV = "SHAREDNET_MANUS_ALLOW_LOOPBACK";
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
/** One request; it is also cut to what is left of the delivery. */
const REQUEST_MS = 30_000;
const CHECK_BUDGET_MS = 20_000;
/** Consecutive failed polls tolerated before the wake is given up (the task itself keeps running). */
const POLL_FAILURES = 5;
/** After a 429 on a poll the next one waits at least the double, up to this. */
const RATE_LIMIT_POLL_MS = 60_000;
/** Pages of events read back in one poll (100 each) while looking for this wake's marker. */
const MAX_PAGES = 20;
/** How soon an omitted `has_running_background_jobs` is asked again before sending into a stopped task (it backs off). */
const UNKNOWN_JOBS_WAIT_MS = 2_000;
/**
 * Manus takes about 5,000 estimated tokens of text per message and answers longer with a 400. Tokens are
 * estimated by script, not by character count: about 3 characters a token for ASCII (dense code) and 1.5
 * tokens a character for anything else (Chinese, Japanese), a deliberate overestimate, then held to 70%.
 */
const MAX_PROMPT_TOKENS = 3_500;
const HEAD_TOKENS = 800;

interface ManusAttachment {
  filename?: string;
  path?: string;
}

interface TaskState {
  status?: string;
  task_url?: string;
  has_running_background_jobs?: boolean;
}

interface QuestionExpectation {
  options?: unknown;
  selection_mode?: string;
}

interface StatusDetail {
  waiting_for_event_id?: string;
  waiting_for_event_type?: string;
  waiting_description?: string;
}

interface ManusEvent {
  id?: string;
  type?: string;
  timestamp?: number;
  assistant_message?: { content?: string; delivery_kind?: string; attachments?: ManusAttachment[]; question_expectation?: QuestionExpectation };
  user_message?: { content?: string };
  error_message?: { content?: string };
  status_update?: { agent_status?: string; status_detail?: StatusDetail };
}

type Answer = { ok: true; body: Record<string, any> } | { ok: false; status: number; code: string; message: string; retryAfterMs?: number };

export function keyEnvOf(wake: SeatWake): string {
  return wake.api_key_env ?? MANUS_KEY_ENV;
}

/**
 * The API address of a wake, or why it may not carry a key. The key goes only to the Manus API origin;
 * a loopback stand-in is for tests and must be asked for in the environment.
 */
export function apiBase(wake: SeatWake, env: Environment = {}): { base: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(wake.command);
  } catch {
    return { error: `${wake.command} is not an address; the Manus API is ${MANUS_API}` };
  }
  if (url.origin === MANUS_API && url.username === "" && url.password === "") return { base: url.origin };
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
  if (loopback && env[ALLOW_LOOPBACK_ENV]?.trim() === "1") return { base: url.origin };
  return { error: `the Manus API key is only sent to ${MANUS_API}, not to ${url.origin} (a loopback stand-in needs ${ALLOW_LOOPBACK_ENV}=1)` };
}

/**
 * serve's execution-budget paragraph tells a harness to run `sharednet wake checkpoint`, which a cloud task
 * cannot do; the plugin keeps the budget itself, so the paragraph is left out of what Manus is sent.
 */
export function withoutBudget(prompt: string): string {
  return prompt.replace(/\n\nExecution budget:[^\n]*/, "");
}

/** A conservative token estimate by script (see MAX_PROMPT_TOKENS). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const character of text) (character.codePointAt(0)! < 0x80 ? (ascii += 1) : (wide += 1));
  return Math.ceil(ascii / 3 + wide * 1.5);
}

function weight(character: string): number {
  return character.codePointAt(0)! < 0x80 ? 1 / 3 : 1.5;
}

function headWithin(text: string, tokens: number): string {
  let used = 0;
  let out = "";
  for (const character of text) {
    used += weight(character);
    if (used > tokens) break;
    out += character;
  }
  return out;
}

function tailWithin(text: string, tokens: number): string {
  let used = 0;
  const kept: string[] = [];
  for (const character of [...text].reverse()) {
    used += weight(character);
    if (used > tokens) break;
    kept.push(character);
  }
  return kept.reverse().join("");
}

/** The wake prompt cut to what one Manus message takes: its start (where it was addressed) and its end (what is asked). */
export function fitPrompt(prompt: string): string {
  if (estimateTokens(prompt) <= MAX_PROMPT_TOKENS) return prompt;
  const mark = "\n[… middle of the room's lines cut to fit one Manus message; `sharednet read` has them …]\n";
  return `${headWithin(prompt, HEAD_TOKENS)}${mark}${tailWithin(prompt, MAX_PROMPT_TOKENS - HEAD_TOKENS - estimateTokens(mark) - 1)}`;
}

/**
 * One Markdown inline link or image starting at `open` (the `[`): its label, its destination and where it ends,
 * or null when the text there is not one. The label may hold balanced brackets; the destination is `<...>`
 * (spaces allowed) or a run without whitespace whose parentheses balance, then an optional title.
 */
function parseLink(text: string, open: number): { label: string; destination: string; end: number } | null {
  let depth = 1;
  let i = open + 1;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") depth += 1;
    else if (text[i] === "]") depth -= 1;
  }
  if (depth !== 0 || text[i] !== "(") return null;
  const label = text.slice(open + 1, i - 1);
  let j = i + 1;
  while (/\s/.test(text[j] ?? "")) j += 1;
  let destination: string;
  if (text[j] === "<") {
    const close = text.indexOf(">", j + 1);
    if (close === -1 || text.slice(j + 1, close).includes("\n")) return null;
    destination = text.slice(j + 1, close);
    j = close + 1;
  } else {
    const from = j;
    let parens = 0;
    for (; j < text.length && !/\s/.test(text[j]!); j += 1) {
      if (text[j] === "\\") j += 1;
      else if (text[j] === "(") parens += 1;
      else if (text[j] === ")") {
        if (parens === 0) break;
        parens -= 1;
      }
    }
    destination = text.slice(from, j);
  }
  while (/\s/.test(text[j] ?? "")) j += 1;
  const quote = text[j];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    const close = text.indexOf(closer, j + 1);
    if (close === -1) return null;
    j = close + 1;
    while (/\s/.test(text[j] ?? "")) j += 1;
  }
  if (text[j] !== ")") return null;
  return { label, destination, end: j + 1 };
}

/**
 * Markdown links and images of an assistant message, as the attachments guide has a client render them:
 * http(s) destinations stay; an absolute path that matches an attachment's `path` becomes the label with the
 * file's name (no URL: the download link is signed and a Room's readers are many); anything else, including
 * `manus-webdev://`, is removed as a whole node and the text around it stays.
 */
export function cleanLinks(text: string, attachments: ManusAttachment[] = []): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text[i] === "[" ? i : text[i] === "!" && text[i + 1] === "[" ? i + 1 : -1;
    const node = start === -1 ? null : parseLink(text, start);
    if (node === null) {
      out += text[i];
      i += 1;
      continue;
    }
    if (/^https?:\/\//i.test(node.destination)) out += text.slice(i, node.end);
    else {
      let path = node.destination;
      try {
        path = decodeURIComponent(node.destination);
      } catch {
        // keep it as written
      }
      const file = path.startsWith("/") ? attachments.find((attachment) => attachment.path === path) : undefined;
      if (file) out += `${node.label || file.filename || "file"} (attachment ${file.filename ?? "file"}, in the Manus task)`;
    }
    i = node.end;
  }
  return out;
}

/** The delivery's limits, shared by every request and sleep of it. */
interface Limits {
  io: Required<PluginNet>;
  deadline: number;
  signal: AbortSignal | undefined;
}

const remaining = (limits: Limits) => limits.deadline - limits.io.now();
const stopping = (limits: Limits) => limits.signal?.aborted === true;

async function call(base: string, key: string, limits: Limits, method: "GET" | "POST", path: string, params: Record<string, string | number> | Record<string, unknown>): Promise<Answer> {
  const left = remaining(limits);
  if (stopping(limits)) return { ok: false, status: 0, code: "aborted", message: "serve is stopping" };
  if (left <= 0) return { ok: false, status: 0, code: "deadline", message: "the delivery's time is spent" };
  const url = new URL(path, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_MS, left));
  const onStop = () => controller.abort();
  limits.signal?.addEventListener("abort", onStop, { once: true });
  // The key goes to this one origin, and a redirect is an error: it would carry the header elsewhere.
  const init: RequestInit = { method, headers: { "x-manus-api-key": key, accept: "application/json" }, signal: controller.signal, redirect: "error" };
  if (method === "GET") for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  else {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(params);
  }
  try {
    let response: Response;
    try {
      response = await limits.io.fetch(url, init);
    } catch (error) {
      const why = stopping(limits) ? "serve is stopping" : controller.signal.aborted ? "no answer within the delivery's time" : error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, code: stopping(limits) ? "aborted" : "network", message: why };
    }
    if (response.status >= 300 && response.status < 400) return { ok: false, status: response.status, code: "redirect", message: "Manus answered with a redirect, which is not followed" };
    let body: Record<string, any> = {};
    try {
      body = (await response.json()) as Record<string, any>;
    } catch {
      // not JSON: keep the status
    }
    if (response.ok && body.ok !== false) return { ok: true, body };
    const error = (body.error ?? {}) as { code?: string; message?: string };
    const wait = Number(response.headers.get("retry-after"));
    return { ok: false, status: response.status, code: error.code ?? `http_${response.status}`, message: (error.message ?? `HTTP ${response.status}`).slice(0, 200), ...(Number.isFinite(wait) && wait > 0 ? { retryAfterMs: Math.min(wait, 300) * 1000 } : {}) };
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", onStop);
  }
}

function net(api: PluginNet | undefined): Required<PluginNet> {
  return {
    fetch: api?.fetch ?? globalThis.fetch,
    sleep:
      api?.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          signal?.addEventListener("abort", done, { once: true });
        })),
    now: api?.now ?? Date.now,
  };
}

/** A failed call as the delivery it should be: busy when nothing was lost and trying again may work, else failed. */
function refused(answer: Extract<Answer, { ok: false }>, what: string, keyEnv: string, posted = false): Delivery {
  if (answer.status === 429) return { kind: "busy", why: `Manus rate limit on ${what}`, retryMs: RATE_LIMIT_RETRY_MS };
  const unclear = answer.code === "network" || answer.code === "deadline" || answer.code === "aborted" || answer.status >= 500;
  // A read that failed lost nothing. A write that failed unclearly may have been taken: sending it again
  // could start a second task or ask twice (each costs credits), so it is reported instead of retried.
  if (unclear && !posted) return { kind: "busy", why: `Manus ${what} did not go through (${answer.message})`, retryMs: RETRY_MS };
  if (unclear) return { kind: "failed", why: `Manus ${what} may or may not have gone through (${answer.message}); not sent again`, detail: `${answer.code} (HTTP ${answer.status})`, timedOut: false };
  const why = answer.status === 401 ? `Manus rejected the API key in ${keyEnv}` : `Manus ${what}: ${answer.message}`;
  return { kind: "failed", why, detail: `${answer.code} (HTTP ${answer.status})`, timedOut: false };
}

const failed = (why: string): Delivery => ({ kind: "failed", why, detail: "", timedOut: false });

/** What a pending `waiting` is, per https://open.manus.ai/docs/v2/task-lifecycle#handling-waiting-status. */
type Waiting = { kind: "question" } | { kind: "confirmation"; type: string; description: string } | { kind: "unknown"; type: string };

/** The action confirmations the guide lists; each is a `task.confirmAction` decision. */
const CONFIRMATIONS = new Set([
  "needConnectMyBrowser",
  "gmailSendAction",
  "outlookSendMailsAction",
  "deployAction",
  "terminalExecute",
  "videoGenerate",
  "apiHighCreditNotice",
  "googleCalendarCreate",
  "googleCalendarUpdate",
  "googleCalendarDelete",
  "outlookCalendarCreate",
  "outlookCalendarUpdate",
  "outlookCalendarDelete",
  "shopifyAction",
  "instagramCreateResult",
  "metaMarketingAction",
  "metaMarketingActionResult",
  "selfConfigSaveAction",
  "webdevRunAction",
  "webdevRequestSecrets",
  "connectorOauthExpired",
  "mapreduceAction",
]);

export function classifyWaiting(detail: StatusDetail | undefined): Waiting {
  const type = detail?.waiting_for_event_type;
  if (type === "messageAskUser" || type === "cascadeAskUser") return { kind: "question" };
  if (type && detail?.waiting_for_event_id && CONFIRMATIONS.has(type)) return { kind: "confirmation", type, description: (detail.waiting_description ?? "").slice(0, 160) };
  return { kind: "unknown", type: type ?? "no type given" };
}

function waitingNote(waiting: Waiting, link: string, choices?: string): string {
  if (waiting.kind === "question") {
    return `Manus asked this and is waiting.${choices ? ` ${choices}` : ""} @-mention this seat with your answer: it is sent to the task as an ordinary message (task.sendMessage). ${link}`;
  }
  if (waiting.kind === "confirmation") {
    return `Manus is waiting for your confirmation of an action (${waiting.type}${waiting.description ? `: ${waiting.description}` : ""}). That is a task.confirmAction decision, which this seat never makes from a Room: decide in Manus at ${link}. An @-mention here sends nothing while it is pending, because a message would skip the action.`;
  }
  return `Manus is waiting for something this seat does not recognise (${waiting.type}). Nothing was sent. Open the task in Manus: ${link}`;
}

/** The choices an agent question offers (question_expectation), as a sentence; free text is always allowed. */
function choicesOf(expectation: QuestionExpectation | undefined): string | undefined {
  const options = Array.isArray(expectation?.options) ? expectation.options.filter((option): option is string => typeof option === "string" && option.trim() !== "") : [];
  if (options.length === 0) return undefined;
  const shown = options.slice(0, 20).map((option, index) => `${index + 1}) ${cleanLinks(option.trim()).slice(0, 120)}`).join(" ");
  return `Choices: ${shown} (${expectation?.selection_mode === "multiple" ? "you may pick several" : "pick one"}, or answer in your own words).`;
}

/** The newest status event of a list, by time. */
function latestStatus(events: ManusEvent[]): ManusEvent | undefined {
  return events.filter((event) => event.type === "status_update" && typeof event.timestamp === "number").sort((a, b) => a.timestamp! - b.timestamp!).pop();
}

function replyOf(turn: ManusEvent[], question = false): { text: string; files: string[]; choices?: string } | null {
  const said = turn.filter((event) => event.type === "assistant_message" && (event.assistant_message?.content ?? "").trim() !== "");
  const asked = question ? [...said].reverse().find((event) => choicesOf(event.assistant_message?.question_expectation) !== undefined) : undefined;
  const chosen = asked ?? [...said].reverse().find((event) => event.assistant_message?.delivery_kind === "result") ?? said[said.length - 1];
  if (!chosen) return null;
  const attachments = chosen.assistant_message?.attachments ?? [];
  const choices = choicesOf(chosen.assistant_message?.question_expectation);
  return { text: cleanLinks(chosen.assistant_message!.content!.trim(), attachments).trim(), files: attachments.map((file) => file.filename ?? "file"), ...(choices ? { choices } : {}) };
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
    const where = apiBase(wake, context.env);
    if ("error" in where) return failed(where.error);
    const io = net(context.api);
    // The seat's wake limit bounds the whole delivery, lookups and send included, and never more than MAX_WAIT_MS.
    const budgetMs = Math.min(context.timeoutMs, MAX_WAIT_MS);
    const limits: Limits = { io, deadline: io.now() + budgetMs, signal: context.signal };
    const api = (method: "GET" | "POST", path: string, params: Record<string, string | number> | Record<string, unknown>) => call(where.base, key, limits, method, path, params);
    // Manus echoes the message back as a user_message event; the nonce is how this wake's own is told from any other
    // message or trigger that starts a run on the same task.
    const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
    const message = { content: `${fitPrompt(withoutBudget(input.prompt))}\n\n[sharednet-wake ${nonce}]` };
    const nap = (ms: number) => io.sleep(Math.min(ms, Math.max(0, remaining(limits))), limits.signal);

    let taskId = wake.session;
    let taskUrl: string | undefined;
    let baseline = 0;
    if (taskId) {
      const look = async (): Promise<{ task: TaskState } | { failure: Extract<Answer, { ok: false }> }> => {
        const read = await api("GET", "/v2/task.detail", { task_id: taskId! });
        return read.ok ? { task: (read.body.task ?? {}) as TaskState } : { failure: read };
      };
      let seen = await look();
      // Nothing is sent until the task is known to be safe to send into, on the freshest read: every refresh is
      // judged again (a stopped task can be running by the next one), and an omitted jobs field is unknown, not false.
      let waitMs = UNKNOWN_JOBS_WAIT_MS;
      for (;;) {
        if ("failure" in seen) return refused(seen.failure, "task lookup", keyEnv);
        const task = seen.task;
        taskUrl = task.task_url ?? taskUrl;
        // A task that is working would take this message into its current run; leave the line for later instead.
        if (task.status === "running") return { kind: "busy", why: "its Manus task is still running", retryMs: RETRY_MS };
        if (task.status !== "stopped") break;
        // A stopped task whose background work is still going may wake itself and change the results.
        if (task.has_running_background_jobs === false) break;
        if (task.has_running_background_jobs === true) return { kind: "busy", why: "its Manus task has background work still running", retryMs: RETRY_MS };
        if (stopping(limits)) return { kind: "busy", why: "serve is stopping", retryMs: RETRY_MS };
        await nap(waitMs);
        waitMs = Math.min(Math.round(waitMs * 1.5), POLL_MAX_MS);
        if (remaining(limits) <= 0) return failed(`Manus does not say whether background work is running on its task (has_running_background_jobs is not reported), so nothing was sent; the task is at ${taskUrl ?? `https://manus.im/app/${taskId}`}`);
        seen = await look();
      }
      const task = (seen as { task: TaskState }).task;
      const recent = await api("GET", "/v2/task.listMessages", { task_id: taskId, order: "desc", limit: 100 });
      if (!recent.ok) return refused(recent, "message lookup", keyEnv);
      const events = (recent.body.messages ?? []) as ManusEvent[];
      baseline = Math.max(0, ...events.map((event) => event.timestamp ?? 0));
      // A message into a pending action confirmation would skip the action, and a question is the only waiting a message answers.
      const status = latestStatus(events);
      if (task.status === "waiting" || status?.status_update?.agent_status === "waiting") {
        const waiting = classifyWaiting(status?.status_update?.status_detail);
        if (waiting.kind !== "question") return failed(`${waitingNote(waiting, taskUrl ?? `https://manus.im/app/${taskId}`)} Nothing was sent.`);
      }
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
    const minutes = Math.max(1, Math.round(budgetMs / 60_000));
    let unsettled = "";
    const spent = () => failed(`Manus is still working after ${minutes} minutes (this seat's wake limit${unsettled ? `; ${unsettled}` : ""}); the task keeps running at ${link}`);

    // Reads this wake's events back through the pages, newest first, until the floor: the marker time once
    // known, else the baseline. The marker is kept in `anchor`, so it cannot be lost to later events.
    let anchor: number | null = null;
    const readNew = async (): Promise<{ events: ManusEvent[] } | { error: Extract<Answer, { ok: false }> }> => {
      const floor = anchor ?? baseline;
      const events: ManusEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const read = await api("GET", "/v2/task.listMessages", { task_id: taskId!, order: "desc", limit: 100, ...(cursor ? { cursor } : {}) });
        if (!read.ok) return { error: read };
        const got = (read.body.messages ?? []) as ManusEvent[];
        events.push(...got);
        const oldest = Math.min(Infinity, ...got.map((event) => event.timestamp ?? Infinity));
        if (!read.body.has_more || typeof read.body.next_cursor !== "string" || got.length === 0 || oldest <= floor) break;
        cursor = read.body.next_cursor;
      }
      return { events };
    };

    // Failures are counted per kind of request, so a success of one does not hide the repeated failure of the other.
    let listFailures = 0;
    let detailFailures = 0;
    let interval = POLL_FIRST_MS;
    /** A 429 is the service saying slow down: wait as it says (or doubled, up to a minute), and do not count it as a failure. */
    const slowDown = (answer: Extract<Answer, { ok: false }>) => {
      interval = Math.max(answer.retryAfterMs ?? 0, Math.min(interval * 2, RATE_LIMIT_POLL_MS));
    };
    for (;;) {
      if (stopping(limits)) return failed(`serve was stopping while Manus was working; the task keeps running at ${link}`);
      const left = remaining(limits);
      if (left <= 0) return spent();
      await io.sleep(Math.min(interval, left), limits.signal);
      interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
      if (stopping(limits)) return failed(`serve was stopping while Manus was working; the task keeps running at ${link}`);
      const read = await readNew();
      if ("error" in read) {
        const page = read.error;
        if (page.code === "deadline") return spent();
        if (page.code === "aborted") continue;
        if (page.status === 429) {
          slowDown(page);
          continue;
        }
        if (page.status === 401 || page.status === 404) return refused(page, "reading the reply", keyEnv);
        if (++listFailures >= POLL_FAILURES) return failed(`Manus could not be read after the message was sent (${page.message}); the task may still answer at ${link}`);
        continue;
      }
      listFailures = 0;
      const fresh = read.events
        .filter((event) => typeof event.timestamp === "number" && event.timestamp > baseline)
        .reverse();
      if (anchor === null) {
        // Only the user event that carries this wake's own nonce proves a run is this wake's: not any other
        // message, and not a `running` status, which another message or a trigger can start as well.
        const mine = fresh.find((event) => event.type === "user_message" && (event.user_message?.content ?? "").includes(nonce));
        if (!mine) continue;
        anchor = mine.timestamp!;
      }
      const turn = fresh.filter((event) => event.timestamp! >= anchor!);
      const end = latestStatus(turn);
      const state = end?.status_update?.agent_status;
      if (state === "error") {
        const problem = turn.filter((event) => event.type === "error_message").pop()?.error_message?.content;
        return failed(`its Manus task failed${problem ? `: ${problem.slice(0, 160)}` : ""} (${link})`);
      }
      if (state === "stopped") {
        // Stopped is not final: background work may still change the result. Only a fresh read that says the task
        // is stopped and `has_running_background_jobs: false` settles it; a task already running again does not.
        const detail = await api("GET", "/v2/task.detail", { task_id: taskId! });
        if (!detail.ok) {
          if (detail.code === "deadline") return spent();
          if (detail.code === "aborted") continue;
          if (detail.status === 429) {
            slowDown(detail);
            continue;
          }
          if (++detailFailures >= POLL_FAILURES) return failed(`Manus could not be read after the message was sent (${detail.message}); the task may still answer at ${link}`);
          continue;
        }
        detailFailures = 0;
        const now = (detail.body.task ?? {}) as TaskState;
        const jobs = now.has_running_background_jobs;
        if (now.status !== "stopped") {
          unsettled = `the task was ${now.status ?? "in an unknown state"} again`;
          continue;
        }
        if (jobs !== false) {
          unsettled = jobs === true ? "background work was still running" : "whether background work is running was not reported";
          continue;
        }
        const reply = replyOf(turn);
        if (!reply) return failed(`its Manus task finished without a message (${link})`);
        const notes = reply.files.length > 0 ? [`Manus attached ${reply.files.join(", ")}; they are in the task: ${link}`] : [];
        return { kind: "replied", reply: [reply.text, ...notes.map((note) => `(${note})`)].join("\n\n") };
      }
      if (state === "waiting") {
        const waiting = classifyWaiting(end!.status_update?.status_detail);
        const reply = replyOf(turn, waiting.kind === "question");
        return { kind: "replied", reply: [...(reply ? [reply.text] : []), `(${waitingNote(waiting, link, reply?.choices)})`].join("\n\n") };
      }
      // running: keep polling
    }
  },
  async check(wake: SeatWake, env: Environment, _run, options: CheckOptions = { call: false }): Promise<CheckResult> {
    // The steps of docs/wake-plugins.md "Checking a wake", for an API: `program` is the key and the address
    // (nothing to start), `signed_in` asks Manus who the key is, `session` asks for the seat's task. No step
    // makes a Manus turn, since that costs credits; the first wake is the proof.
    const steps: CheckStep[] = [];
    const keyEnv = keyEnvOf(wake);
    const key = env[keyEnv]?.trim();
    const where = apiBase(wake, env);
    if (!key) steps.push({ step: "program", status: "failed", message: `${keyEnv} is not set in this environment` });
    else if ("error" in where) steps.push({ step: "program", status: "failed", message: where.error });
    else steps.push({ step: "program", status: "ok", message: `Manus API at ${where.base}, key in ${keyEnv}` });
    if (!key || "error" in where) return skipRest(steps, options, "the API address or key is not usable");
    const io = net(options.api);
    const limits: Limits = { io, deadline: io.now() + CHECK_BUDGET_MS, signal: undefined };
    const me = await call(where.base, key, limits, "GET", "/v2/user.me", {});
    steps.push(
      me.ok
        ? { step: "signed_in", status: "ok", message: `Manus accepted the API key in ${keyEnv}` }
        : me.status === 401 || me.status === 403
          ? { step: "signed_in", status: "failed", message: `Manus rejected the API key in ${keyEnv}` }
          : { step: "signed_in", status: "warning", message: `Manus user.me: ${me.message}` },
    );
    if (wake.session) {
      const detail = await call(where.base, key, limits, "GET", "/v2/task.detail", { task_id: wake.session });
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
