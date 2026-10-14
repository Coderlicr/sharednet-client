// @vitest-environment node

import { describe, expect, it } from "vitest";

import { livePrompt, type DeliveryContext, type PluginNet, type SeatWake, type WakeInput } from "./wake-driver.ts";
import { apiBase, fitPrompt, manusPlugin, MANUS_API, withoutBudget } from "./wake-manus.ts";
import { describeWake, parseSeatWake, pluginFor, seatWakeFrom, wakePlugins } from "./wake-plugins.ts";

// Everything here is synthetic: a stand-in for api.manus.ai that answers from a script, and a key that
// is not a key. Nothing touches the network, a credential file or a real Manus account.
const KEY = "synthetic-key-not-a-secret";
const TASK = "taskSyntheticId000000a";

const about = { roomId: "rom_AbCdEfGhIj", seat: "manus-helper", memberId: "i_SeatSeatSe", messages: [{ sequence: 7, content: "@manus-helper summarise the build", sender: { name: "ann" } }], from: 6, through: 7 };
const input: WakeInput = { ...about, prompt: "TURN PROMPT", livePrompt: livePrompt(about) };
const wake: SeatWake = { driver: "manus", session: TASK, cwd: "/work", command: MANUS_API };

type Event = Record<string, unknown>;
const user = (timestamp: number, content = "TURN PROMPT"): Event => ({ id: `u${timestamp}`, type: "user_message", timestamp, user_message: { content } });
const said = (timestamp: number, content: string, extra: Record<string, unknown> = {}): Event => ({ id: `a${timestamp}`, type: "assistant_message", timestamp, assistant_message: { content, ...extra } });
const status = (timestamp: number, agent_status: string, status_detail?: Record<string, unknown>): Event => ({ id: `s${timestamp}`, type: "status_update", timestamp, status_update: { agent_status, ...(status_detail ? { status_detail } : {}) } });

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, any> | null;
  headers: Record<string, string>;
}

/**
 * A scripted Manus. `events` is what task.listMessages returns on the n-th read (newest first, as the
 * API does by default); `detail` what task.detail says. Anything unscripted is a test failure.
 */
function manus(script: {
  detail?: Array<Record<string, unknown>>;
  reads?: Event[][];
  send?: { status: number; body: Record<string, unknown> };
  create?: { status: number; body: Record<string, unknown> };
  me?: { status: number; body: Record<string, unknown> };
  throwOn?: string[];
}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const detail = [...(script.detail ?? [])];
  const reads = [...(script.reads ?? [])];
  const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const api: PluginNet = {
    now: () => clock,
    sleep: async (ms) => void (sleeps.push(ms), (clock += ms)),
    fetch: async (target, init) => {
      const url = new URL(String(target));
      const call: Call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      };
      calls.push(call);
      if (script.throwOn?.includes(`${call.method} ${call.path}`)) throw new TypeError("fetch failed");
      if (call.path === "/v2/task.detail") return respond(200, { ok: true, task: detail.shift() ?? detail[0] ?? { id: TASK, status: "stopped" } });
      if (call.path === "/v2/task.listMessages") {
        const next = reads.length > 1 ? reads.shift()! : (reads[0] ?? []);
        return respond(200, { ok: true, task_id: TASK, messages: call.query.limit === "1" ? next.slice(0, 1) : next, has_more: false });
      }
      if (call.path === "/v2/task.sendMessage") return respond(script.send?.status ?? 200, script.send?.body ?? { ok: true, task_id: TASK });
      if (call.path === "/v2/task.create") return respond(script.create?.status ?? 200, script.create?.body ?? { ok: true, task_id: TASK, task_url: `https://manus.im/app/${TASK}` });
      if (call.path === "/v2/user.me") return respond(script.me?.status ?? 200, script.me?.body ?? { ok: true, user_id: "u_1" });
      throw new Error(`unscripted ${call.method} ${call.path}`);
    },
  };
  const context = (env: Record<string, string | undefined> = { MANUS_API_KEY: KEY }, timeoutMs = 20 * 60_000): DeliveryContext => ({
    env,
    timeoutMs,
    chatOpen: () => false,
    run: async () => {
      throw new Error("a Manus wake runs no program");
    },
    api,
  });
  return { calls, api, context, sleeps, clock: () => clock };
}

const OLD = [status(100, "stopped"), said(99, "earlier answer", { delivery_kind: "result" }), user(90, "earlier question")];

describe("the manus plugin in the registry", () => {
  it("is known by its driver, never recognised from an environment, and a seat needs no task id", () => {
    expect(wakePlugins.map((plugin) => plugin.driver)).toEqual(["codex", "claude-code", "manus", "command"]);
    expect(pluginFor("manus").label).toBe("Manus");
    expect(manusPlugin.capture({ MANUS_API_KEY: KEY, PATH: "" }, "/w")).toBeNull();
    expect(seatWakeFrom({ MANUS_API_KEY: KEY, PATH: "" }, "/w")).toBeNull();
    expect(parseSeatWake({ driver: "manus", cwd: "/w", command: MANUS_API })).toEqual({ driver: "manus", cwd: "/w", command: MANUS_API });
    expect(parseSeatWake({ driver: "manus", session: TASK, cwd: "/w", command: MANUS_API, api_key_env: "TEAM_MANUS_KEY" })).toEqual({ driver: "manus", session: TASK, cwd: "/w", command: MANUS_API, api_key_env: "TEAM_MANUS_KEY" });
    // The field names a variable; anything that is not a name (a key pasted in by mistake) is dropped, not kept.
    expect(parseSeatWake({ driver: "manus", cwd: "/w", command: MANUS_API, api_key_env: "sk-live-abc 123" })).toEqual({ driver: "manus", cwd: "/w", command: MANUS_API });
    expect(parseSeatWake({ driver: "codex", session: "019a", cwd: "/w", command: "codex", api_key_env: "X" })).toEqual({ driver: "codex", session: "019a", cwd: "/w", command: "codex" });
    expect(describeWake(wake)).toBe(`manus ${TASK}`);
  });

  it("sends the key only over https, or to a loopback stand-in", () => {
    expect(apiBase(wake)).toEqual({ base: "https://api.manus.ai" });
    expect(apiBase({ ...wake, command: "http://127.0.0.1:8080" })).toEqual({ base: "http://127.0.0.1:8080" });
    expect(apiBase({ ...wake, command: "http://api.manus.ai" })).toMatchObject({ error: expect.stringContaining("https") });
    expect(apiBase({ ...wake, command: "manus" })).toMatchObject({ error: expect.stringContaining("not an address") });
  });
});

describe("the manus plugin: continuing a task", () => {
  it("sends the lines to the task and replies with its result once the run has stopped", async () => {
    const { calls, context } = manus({
      detail: [{ id: TASK, status: "stopped", task_url: `https://manus.im/app/${TASK}` }, { id: TASK, status: "stopped", has_running_background_jobs: false }],
      reads: [
        OLD.slice(0, 1), // the baseline read: newest event is at 100
        [user(200), ...OLD], // our message is in, no status yet
        [status(204, "stopped"), said(203, "The build is green: 412 tests.", { delivery_kind: "result" }), said(202, "Running the tests...", { delivery_kind: "progress" }), status(201, "running"), user(200), ...OLD],
      ],
    });
    const delivery = await manusPlugin.deliver(wake, input, context());
    expect(delivery).toEqual({ kind: "replied", reply: "The build is green: 412 tests." });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v2/task.detail",
      "GET /v2/task.listMessages",
      "POST /v2/task.sendMessage",
      "GET /v2/task.listMessages",
      "GET /v2/task.listMessages",
    ]);
    const send = calls.find((call) => call.path === "/v2/task.sendMessage")!;
    expect(send.body).toEqual({ task_id: TASK, message: { content: "TURN PROMPT" } });
    expect(send.headers["x-manus-api-key"]).toBe(KEY);
    expect(calls[0]!.query).toEqual({ task_id: TASK });
    // The key travels in a header, never in a URL.
    expect(calls.map((call) => call.path + JSON.stringify(call.query)).join(" ")).not.toContain(KEY);
  });

  it("does not take the run's previous ending for this wake's", async () => {
    // Right after the send the task still reads `stopped` from before; only events past the baseline count.
    const { calls, context } = manus({
      reads: [OLD.slice(0, 1), OLD, OLD, [status(250, "stopped"), said(249, "done", { delivery_kind: "result" }), user(240), ...OLD]],
      detail: [{ id: TASK, status: "stopped" }],
    });
    expect(await manusPlugin.deliver(wake, input, context())).toEqual({ kind: "replied", reply: "done" });
    expect(calls.filter((call) => call.path === "/v2/task.listMessages")).toHaveLength(4);
  });

  it("stops reading as soon as the run has stopped with something said, even with background work running", async () => {
    const { calls, context } = manus({
      detail: [{ id: TASK, status: "stopped" }, { id: TASK, status: "stopped", has_running_background_jobs: true }],
      reads: [OLD.slice(0, 1), [status(301, "stopped"), said(300, "first look", { delivery_kind: "result" }), user(299), ...OLD], [status(401, "stopped"), said(400, "later", { delivery_kind: "result" }), user(299), ...OLD]],
    });
    expect(await manusPlugin.deliver(wake, input, context())).toEqual({ kind: "replied", reply: "first look" });
    // one lookup before sending, one baseline read, the send, one poll: nothing after the terminal state
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v2/task.detail", "GET /v2/task.listMessages", "POST /v2/task.sendMessage", "GET /v2/task.listMessages"]);
  });

  it("keeps waiting only when it stopped with nothing said while background work runs", async () => {
    const { calls, context } = manus({
      detail: [{ id: TASK, status: "stopped" }, { id: TASK, status: "stopped", has_running_background_jobs: true }],
      reads: [OLD.slice(0, 1), [status(301, "stopped"), user(299), ...OLD], [status(401, "stopped"), said(400, "final numbers", { delivery_kind: "result" }), status(301, "stopped"), user(299), ...OLD]],
    });
    expect(await manusPlugin.deliver(wake, input, context())).toEqual({ kind: "replied", reply: "final numbers" });
    expect(calls.filter((call) => call.path === "/v2/task.detail")).toHaveLength(2);
  });

  it("falls back to the last message when none is marked a result, and names attached files without linking them", async () => {
    const { context } = manus({
      reads: [OLD.slice(0, 1), [status(504, "stopped"), said(503, "Report attached.", { attachments: [{ filename: "report.pdf", url: "https://files.example/secret-link" }] }), user(500), ...OLD]],
      detail: [{ id: TASK, status: "stopped", task_url: `https://manus.im/app/${TASK}` }],
    });
    const delivery = await manusPlugin.deliver(wake, input, context());
    expect(delivery).toEqual({ kind: "replied", reply: `Report attached.\n\n(Manus attached report.pdf; they are in the task: https://manus.im/app/${TASK})` });
    expect(delivery.kind === "replied" && delivery.reply).not.toContain("secret-link");
  });

  it("hands a question the agent is waiting on to the room", async () => {
    const { context } = manus({
      reads: [OLD.slice(0, 1), [status(602, "waiting", { waiting_for_event_type: "messageAskUser" }), said(601, "Which branch should I build?"), user(600), ...OLD]],
    });
    const delivery = await manusPlugin.deliver(wake, input, context());
    expect(delivery.kind === "replied" && delivery.reply).toContain("Which branch should I build?");
    expect(delivery.kind === "replied" && delivery.reply).toContain("Manus is waiting for messageAskUser");
  });

  it("fails with the agent's own words when the task errors", async () => {
    const { context } = manus({
      reads: [OLD.slice(0, 1), [status(702, "error"), { id: "e1", type: "error_message", timestamp: 701, error_message: { content: "sandbox crashed" } }, user(700), ...OLD]],
    });
    expect(await manusPlugin.deliver(wake, input, context())).toMatchObject({ kind: "failed", why: expect.stringContaining("sandbox crashed"), timedOut: false });
  });

  it("polls with a growing delay up to a cap, and gives up with a link when the seat's wake limit is spent", async () => {
    const { calls, context, sleeps } = manus({ reads: [OLD.slice(0, 1), [status(801, "running"), user(800), ...OLD]] });
    const delivery = await manusPlugin.deliver(wake, input, context({ MANUS_API_KEY: KEY }, 5 * 60_000));
    expect(delivery).toMatchObject({ kind: "failed", timedOut: false });
    expect(delivery.kind === "failed" && delivery.why).toContain(`still working after 5 minutes (this seat's wake limit); the task keeps running at https://manus.im/app/${TASK}`);
    expect(sleeps.slice(0, 7)).toEqual([3000, 4500, 6750, 10125, 15188, 22782, 30000]);
    expect(Math.max(...sleeps)).toBe(30_000);
    // the last sleep is cut to what is left, and the total never passes the limit
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5 * 60_000);
    expect(calls.filter((call) => call.path === "/v2/task.listMessages")).toHaveLength(sleeps.length + 1);
  });

  it("never waits past two hours however long the wake limit is", async () => {
    const { context, sleeps } = manus({ reads: [OLD.slice(0, 1), [status(801, "running"), user(800), ...OLD]] });
    const delivery = await manusPlugin.deliver(wake, input, context({ MANUS_API_KEY: KEY }, 24 * 60 * 60_000));
    expect(delivery.kind === "failed" && delivery.why).toContain("after 120 minutes");
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120 * 60_000);
  });

  it("leaves serve's execution-budget paragraph out of what Manus is sent, since a cloud task cannot checkpoint", async () => {
    const { calls, context } = manus({ reads: [OLD.slice(0, 1), [status(12, "stopped"), said(11, "ok", { delivery_kind: "result" }), user(9)]], detail: [{ id: TASK, status: "stopped" }] });
    const prompt = "[SharedNet] You were addressed.\n#7 ann: hi\n\nDo what is asked.\n\nExecution budget: 40 minutes; sharednet wake checkpoint \"x\" --as i_Seat.\n\nMore after.";
    await manusPlugin.deliver(wake, { ...input, prompt }, context());
    expect(calls.find((call) => call.path === "/v2/task.sendMessage")!.body!.message.content).toBe("[SharedNet] You were addressed.\n#7 ann: hi\n\nDo what is asked.\n\nMore after.");
    expect(withoutBudget("no budget here")).toBe("no budget here");
  });

  it("leaves the line for later when the task is mid-run, and sends nothing", async () => {
    const { calls, context } = manus({ detail: [{ id: TASK, status: "running" }] });
    expect(await manusPlugin.deliver(wake, input, context())).toMatchObject({ kind: "busy", retryMs: 30_000 });
    expect(calls.map((call) => call.path)).toEqual(["/v2/task.detail"]);
  });
});

describe("the manus plugin: starting a task", () => {
  it("creates a task per wake when the seat has none, without asking questions back", async () => {
    const { calls, context } = manus({
      reads: [[status(12, "stopped"), said(11, "On it: green.", { delivery_kind: "result" }), status(10, "running"), user(9)]],
      detail: [{ id: TASK, status: "stopped" }],
    });
    const delivery = await manusPlugin.deliver({ driver: "manus", cwd: "/work", command: MANUS_API, api_key_env: "TEAM_MANUS_KEY" }, input, context({ TEAM_MANUS_KEY: KEY }));
    expect(delivery).toEqual({ kind: "replied", reply: "On it: green." });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/task.create", body: { message: { content: "TURN PROMPT" }, interactive_mode: false } });
    expect(String(calls[0]!.body!.title)).toContain("manus-helper");
    expect(calls[1]!.query).toMatchObject({ task_id: TASK });
  });
});

describe("the manus plugin: when it cannot be delivered", () => {
  it("fails without a request when the key variable is not set, naming the variable and never a value", async () => {
    const { calls, context } = manus({});
    const delivery = await manusPlugin.deliver({ ...wake, api_key_env: "TEAM_MANUS_KEY" }, input, context({ MANUS_API_KEY: KEY }));
    expect(delivery).toMatchObject({ kind: "failed", why: "TEAM_MANUS_KEY is not set in the environment of sharednet serve" });
    expect(calls).toHaveLength(0);
  });

  it("refuses to send the key to an address that is not https", async () => {
    const { calls, context } = manus({});
    expect(await manusPlugin.deliver({ ...wake, command: "http://manus.example" }, input, context())).toMatchObject({ kind: "failed", why: expect.stringContaining("https") });
    expect(calls).toHaveLength(0);
  });

  it("puts a rate-limited send off, and reports a rejected key without echoing it", async () => {
    const limited = manus({ reads: [OLD.slice(0, 1)], send: { status: 429, body: { ok: false, error: { code: "rate_limited", message: "Rate limit exceeded" } } } });
    expect(await manusPlugin.deliver(wake, input, limited.context())).toMatchObject({ kind: "busy", retryMs: 60_000 });
    const rejected = manus({ reads: [OLD.slice(0, 1)], send: { status: 401, body: { ok: false, error: { code: "unauthenticated", message: `invalid key ${KEY}` } } } });
    const delivery = await manusPlugin.deliver(wake, input, rejected.context());
    expect(delivery).toMatchObject({ kind: "failed", why: "Manus rejected the API key in MANUS_API_KEY" });
    expect(JSON.stringify(delivery)).not.toContain(KEY);
  });

  it("does not send again when a write may have gone through, but retries a read", async () => {
    const write = manus({ reads: [OLD.slice(0, 1)], throwOn: ["POST /v2/task.sendMessage"] });
    expect(await manusPlugin.deliver(wake, input, write.context())).toMatchObject({ kind: "failed", why: expect.stringContaining("not sent again") });
    expect(write.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const read = manus({ throwOn: ["GET /v2/task.detail"] });
    expect(await manusPlugin.deliver(wake, input, read.context())).toMatchObject({ kind: "busy", retryMs: 30_000 });
    expect(read.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const missing = manus({ detail: [] });
    const gone = await manusPlugin.deliver(wake, input, { ...missing.context(), api: { ...missing.api, fetch: async () => new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "task not found" } }), { status: 404 }) } });
    expect(gone).toMatchObject({ kind: "failed", why: "Manus task lookup: task not found" });
  });

  it("gives up reading after repeated failures, pointing at the task that may still answer", async () => {
    const { context } = manus({ reads: [OLD.slice(0, 1)], throwOn: [] });
    const base = context();
    let reads = 0;
    const flaky: DeliveryContext = {
      ...base,
      api: {
        ...base.api,
        fetch: async (target, init) => {
          const url = new URL(String(target));
          if (url.pathname === "/v2/task.listMessages" && url.searchParams.get("limit") !== "1" && ++reads > 0) throw new TypeError("fetch failed");
          return base.api!.fetch!(target, init);
        },
      },
    };
    expect(await manusPlugin.deliver(wake, input, flaky)).toMatchObject({ kind: "failed", why: expect.stringContaining(`may still answer at https://manus.im/app/${TASK}`) });
    expect(reads).toBe(5);
  });
});

describe("the manus plugin: the prompt and the probe", () => {
  it("cuts a long prompt in the middle, keeping where it was addressed and what is asked", () => {
    expect(fitPrompt("short")).toBe("short");
    const long = `HEAD-${"x".repeat(40_000)}-TAIL`;
    const fitted = fitPrompt(long);
    expect(fitted.length).toBeLessThan(12_300);
    expect(fitted.startsWith("HEAD-")).toBe(true);
    expect(fitted.endsWith("-TAIL")).toBe(true);
    expect(fitted).toContain("cut to fit one Manus message");
  });

  it("checks the address and key, then the key with a read-only call, then the task, and makes no Manus turn", async () => {
    const run = async () => {
      throw new Error("no program");
    };
    const good = manus({ detail: [{ id: TASK, status: "stopped" }] });
    const ok = await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: true, api: good.api });
    expect(ok.ok).toBe(true);
    expect(ok.steps?.map((step) => `${step.step}:${step.status}`)).toEqual(["program:ok", "signed_in:ok", "session:ok", "call:skipped"]);
    expect(good.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v2/user.me", "GET /v2/task.detail"]);
    // A seat without a task has nothing to look up.
    const fresh = manus({});
    const none = await manusPlugin.check({ ...wake, session: undefined }, { MANUS_API_KEY: KEY }, run, { call: false, api: fresh.api });
    expect(none.steps?.map((step) => `${step.step}:${step.status}`)).toEqual(["program:ok", "signed_in:ok", "session:ok"]);
    expect(fresh.calls.map((call) => call.path)).toEqual(["/v2/user.me"]);
  });

  it("says what is wrong: no key, a rejected key, a task this key does not have, a doubt about Manus itself", async () => {
    const run = async () => {
      throw new Error("no program");
    };
    const offline = manus({});
    const unset = await manusPlugin.check(wake, {}, run, { call: false, api: offline.api });
    expect(unset).toMatchObject({ ok: false });
    expect(unset.steps![0]).toMatchObject({ step: "program", status: "failed", message: "MANUS_API_KEY is not set in this environment" });
    expect(unset.steps!.slice(1).every((step) => step.status === "skipped")).toBe(true);
    expect(offline.calls).toHaveLength(0);
    const bad = manus({ me: { status: 401, body: { ok: false, error: { code: "unauthenticated", message: "no" } } } });
    expect(await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: false, api: bad.api })).toMatchObject({ ok: false, message: expect.stringContaining("Manus rejected the API key in MANUS_API_KEY") });
    const gone = manus({});
    const missing = await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: false, api: { ...gone.api, fetch: async (target, init) => (String(target).includes("task.detail") ? new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "no" } }), { status: 404 }) : gone.api.fetch!(target, init)) } });
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining(`Manus has no task ${TASK}`) });
    const insecure = await manusPlugin.check({ ...wake, command: "http://api.manus.ai" }, { MANUS_API_KEY: KEY }, run, { call: false, api: offline.api });
    expect(insecure.steps![0]).toMatchObject({ status: "failed", message: expect.stringContaining("https") });
    // Manus being down is a doubt (a warning), not a verdict: a seat is still driven.
    const down = manus({ me: { status: 503, body: { ok: false, error: { code: "internal", message: "unavailable" } } } });
    const warned = await manusPlugin.check({ ...wake, session: undefined }, { MANUS_API_KEY: KEY }, run, { call: false, api: down.api });
    expect(warned.ok).toBe(true);
    expect(warned.steps![1]).toMatchObject({ step: "signed_in", status: "warning" });
  });
});
