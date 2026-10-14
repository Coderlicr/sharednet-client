// @vitest-environment node

import { describe, expect, it } from "vitest";

import { claudePlugin } from "./wake-claude.ts";
import { commandPlugin } from "./wake-command.ts";
import { harnessFreeEnv, livePrompt, withoutSecrets, type DeliveryContext, type PluginNet, type SeatWake, type TurnSpec, type WakeInput } from "./wake-driver.ts";
import { ALLOW_LOOPBACK_ENV, apiBase, classifyWaiting, cleanLinks, estimateTokens, fitPrompt, manusPlugin, MANUS_API, withoutBudget } from "./wake-manus.ts";
import { describeWake, parseSeatWake, pluginFor, seatWakeFrom, wakePlugins } from "./wake-plugins.ts";

// Everything here is synthetic: a stand-in for api.manus.ai that behaves like the documented API (events in
// time order, newest first with cursors, a task status, background jobs), and a key that is not a key.
// Nothing touches the network, a credential file or a real Manus account.
const KEY = "synthetic-key-not-a-secret";
const TASK = "taskSyntheticId000000a";
const LINK = `https://manus.im/app/${TASK}`;

const about = { roomId: "rom_AbCdEfGhIj", seat: "manus-helper", memberId: "i_SeatSeatSe", messages: [{ sequence: 7, content: "@manus-helper summarise the build", sender: { name: "ann" } }], from: 6, through: 7 };
const input: WakeInput = { ...about, prompt: "TURN PROMPT", livePrompt: livePrompt(about) };
const wake: SeatWake = { driver: "manus", session: TASK, cwd: "/work", command: MANUS_API };

type Event = Record<string, unknown>;
// "__SENT__" stands for the text the plugin really sent, which the stand-in fills in (it carries a per-wake nonce).
const user = (timestamp: number, content = "__SENT__"): Event => ({ id: `u${timestamp}`, type: "user_message", timestamp, user_message: { content } });
const said = (timestamp: number, content: string, extra: Record<string, unknown> = {}): Event => ({ id: `a${timestamp}`, type: "assistant_message", timestamp, assistant_message: { content, ...extra } });
const status = (timestamp: number, agent_status: string, status_detail?: Record<string, unknown>): Event => ({ id: `s${timestamp}`, type: "status_update", timestamp, status_update: { agent_status, ...(status_detail ? { status_detail } : {}) } });

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, any> | null;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

/**
 * A Manus that behaves as documented. `events` are kept oldest first and served newest first, 100 at most
 * a page, with an opaque cursor. Time passes only when the plugin sleeps: each sleep runs the next step of
 * `evolve`, which changes the task the way Manus would between two polls.
 */
class FakeManus {
  events: Event[] = [];
  task: Record<string, unknown> = { id: TASK, status: "stopped", task_url: LINK, has_running_background_jobs: false };
  calls: Call[] = [];
  sleeps: number[] = [];
  clock = 1_000_000;
  evolve: Array<(fake: FakeManus) => void> = [];
  onSend: (fake: FakeManus, body: Record<string, any>) => void = () => undefined;
  replies: Record<string, { status: number; body: Record<string, unknown>; headers?: Record<string, string> }> = {};
  /** Answers served once each, in order, before the usual ones (a service that fails a few times, then recovers). */
  queue: Record<string, Array<{ status: number; body: Record<string, unknown>; headers?: Record<string, string> }>> = {};

  constructor(history: Event[] = []) {
    this.events = [...history];
  }

  private respond(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private delivered(body: Record<string, any>) {
    const before = this.events.length;
    this.onSend(this, body);
    for (const event of this.events.slice(before)) {
      const sent = event.user_message as { content?: string } | undefined;
      if (event.type === "user_message" && sent?.content === "__SENT__") sent.content = body.message.content;
    }
  }

  api: PluginNet = {
    now: () => this.clock,
    sleep: async (ms) => {
      this.sleeps.push(ms);
      this.clock += ms;
      this.evolve.shift()?.(this);
    },
    fetch: async (target, init) => {
      const url = new URL(String(target));
      const call: Call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        redirect: init?.redirect,
      };
      this.calls.push(call);
      const queued = this.queue[`${call.method} ${call.path}`]?.shift();
      if (queued) return this.respond(queued.status, queued.body, queued.headers);
      const scripted = this.replies[`${call.method} ${call.path}`];
      if (scripted) return this.respond(scripted.status, scripted.body, scripted.headers);
      if (call.path === "/v2/task.detail") return this.respond(200, { ok: true, task: this.task });
      if (call.path === "/v2/user.me") return this.respond(200, { ok: true, user_id: "u_1" });
      if (call.path === "/v2/task.listMessages") {
        const newest = [...this.events].sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
        const limit = Number(call.query.limit ?? 50);
        const start = call.query.cursor ? Number(call.query.cursor) : 0;
        const page = newest.slice(start, start + limit);
        const more = start + limit < newest.length;
        return this.respond(200, { ok: true, task_id: TASK, messages: page, has_more: more, ...(more ? { next_cursor: String(start + limit) } : {}) });
      }
      if (call.path === "/v2/task.sendMessage") {
        this.delivered(call.body!);
        return this.respond(200, { ok: true, task_id: TASK });
      }
      if (call.path === "/v2/task.create") {
        this.delivered(call.body!);
        return this.respond(200, { ok: true, task_id: TASK, task_url: LINK });
      }
      throw new Error(`unscripted ${call.method} ${call.path}`);
    },
  };

  context(env: Record<string, string | undefined> = { MANUS_API_KEY: KEY }, timeoutMs = 20 * 60_000, extra: Partial<DeliveryContext> = {}): DeliveryContext {
    return {
      env,
      timeoutMs,
      chatOpen: () => false,
      run: async () => {
        throw new Error("a Manus wake runs no program");
      },
      api: this.api,
      ...extra,
    };
  }

  paths() {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  posts() {
    return this.calls.filter((call) => call.method === "POST");
  }
}

/** A prior run that ended: the user's earlier question, its answer, and the stop at 100. */
const PRIOR: Event[] = [user(90, "earlier question"), said(99, "earlier answer", { delivery_kind: "result" }), status(100, "stopped")];

/** The turn a send starts: the user's message at 200, running at 201. */
function started(fake: FakeManus) {
  fake.events.push(user(200), status(201, "running"));
}

describe("the manus plugin in the registry", () => {
  it("is known by its driver, never recognised from an environment, and a seat needs no task id", () => {
    expect(wakePlugins.map((plugin) => plugin.driver)).toEqual(["codex", "claude-code", "codebuddy", "manus", "command"]);
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

  it("sends the key only to the Manus API origin; a loopback stand-in must be asked for", () => {
    expect(apiBase(wake)).toEqual({ base: "https://api.manus.ai" });
    expect(apiBase({ ...wake, command: "https://api.manus.ai/v2" })).toEqual({ base: "https://api.manus.ai" });
    // Any other https origin would be sent the key; so would a look-alike or an address with credentials in it.
    for (const command of ["https://attacker.example", "https://api.manus.ai.attacker.example", "https://manus.ai", "https://u:p@api.manus.ai", "http://api.manus.ai", "https://api.manus.ai:8443"]) {
      expect(apiBase({ ...wake, command })).toMatchObject({ error: expect.stringContaining("only sent to https://api.manus.ai") });
    }
    expect(apiBase({ ...wake, command: "manus" })).toMatchObject({ error: expect.stringContaining("not an address") });
    // The loopback test path is explicit and loopback only.
    expect(apiBase({ ...wake, command: "http://127.0.0.1:8080" })).toMatchObject({ error: expect.any(String) });
    expect(apiBase({ ...wake, command: "http://127.0.0.1:8080" }, { [ALLOW_LOOPBACK_ENV]: "1" })).toEqual({ base: "http://127.0.0.1:8080" });
    expect(apiBase({ ...wake, command: "https://attacker.example" }, { [ALLOW_LOOPBACK_ENV]: "1" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("the manus plugin: continuing a task", () => {
  it("sends the lines to the task and replies with its result once the run has stopped and nothing runs in the background", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    fake.evolve = [(f) => f.events.push(said(202, "Running the tests...", { delivery_kind: "progress" })), (f) => f.events.push(said(203, "The build is green: 412 tests.", { delivery_kind: "result" }), status(204, "stopped"))];
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    expect(delivery).toEqual({ kind: "replied", reply: "The build is green: 412 tests." });
    expect(fake.paths()).toEqual([
      "GET /v2/task.detail",
      "GET /v2/task.listMessages",
      "POST /v2/task.sendMessage",
      "GET /v2/task.listMessages",
      "GET /v2/task.listMessages",
      "GET /v2/task.detail",
    ]);
    const send = fake.posts()[0]!;
    expect(send.body).toEqual({ task_id: TASK, message: { content: expect.stringMatching(/^TURN PROMPT\n\n\[sharednet-wake [0-9a-f]{16}\]$/) } });
    expect(send.headers["x-manus-api-key"]).toBe(KEY);
    // The key travels in a header, never in a URL, and a redirect is an error rather than followed.
    expect(fake.calls.map((call) => call.path + JSON.stringify(call.query)).join(" ")).not.toContain(KEY);
    expect(fake.calls.every((call) => call.redirect === "error")).toBe(true);
  });

  it("does not take the run's previous ending for this wake's", async () => {
    // Right after the send the task still reads `stopped` from before; only events past the baseline count.
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(240));
    fake.evolve = [() => undefined, (f) => f.events.push(said(249, "done", { delivery_kind: "result" }), status(250, "stopped"))];
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "done" });
    // the baseline read and two polls: the stop at 100 is older than the baseline and is never seen as this wake's
    expect(fake.calls.filter((call) => call.path === "/v2/task.listMessages")).toHaveLength(3);
  });

  it("on every stop reads task.detail, and consumes the result only when background jobs are done", async () => {
    // The first stop has a message, but the task still has background work: that message is not taken.
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    fake.evolve = [
      (f) => {
        f.events.push(said(300, "first look", { delivery_kind: "result" }), status(301, "stopped"));
        f.task.has_running_background_jobs = true;
      },
      (f) => {
        f.events.push(said(400, "final numbers", { delivery_kind: "result" }), status(401, "stopped"));
        f.task.has_running_background_jobs = false;
      },
    ];
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "final numbers" });
    expect(fake.calls.filter((call) => call.path === "/v2/task.detail")).toHaveLength(3);
  });

  it("treats an omitted has_running_background_jobs as unknown: it keeps polling, and gives up with the reason when it never comes", async () => {
    const omitted = new FakeManus(PRIOR);
    omitted.onSend = (f) => {
      started(f);
      f.events.push(said(300, "an answer", { delivery_kind: "result" }), status(301, "stopped"));
      delete f.task.has_running_background_jobs;
    };
    // Reported only at the fourth read after the send (the three before it, at the start, saw it omitted too).
    omitted.task = { id: TASK, status: "stopped", task_url: LINK, has_running_background_jobs: false };
    const never = await manusPlugin.deliver(wake, input, omitted.context(undefined, 3 * 60_000));
    expect(never).toMatchObject({ kind: "failed", timedOut: false });
    expect(never.kind === "failed" && never.why).toContain("whether background work is running was not reported");
    expect(never.kind === "failed" && never.why).toContain(LINK);

    const later = new FakeManus(PRIOR);
    later.onSend = (f) => {
      started(f);
      f.events.push(said(300, "an answer", { delivery_kind: "result" }), status(301, "stopped"));
      delete f.task.has_running_background_jobs;
    };
    later.evolve = [() => undefined, (f) => void (f.task.has_running_background_jobs = false)];
    expect(await manusPlugin.deliver(wake, input, later.context())).toEqual({ kind: "replied", reply: "an answer" });
  });

  it("does not send into a stopped task whose background work is still running; an omitted field is unknown, so it waits and never sends until it is reported false", async () => {
    const busy = new FakeManus(PRIOR);
    busy.task.has_running_background_jobs = true;
    expect(await manusPlugin.deliver(wake, input, busy.context())).toMatchObject({ kind: "busy", retryMs: 30_000 });
    expect(busy.paths()).toEqual(["GET /v2/task.detail"]);

    // Omitted at first, then reported true: busy, nothing sent.
    const later = new FakeManus(PRIOR);
    delete later.task.has_running_background_jobs;
    later.evolve = [(f) => void (f.task.has_running_background_jobs = true)];
    expect(await manusPlugin.deliver(wake, input, later.context())).toMatchObject({ kind: "busy", why: expect.stringContaining("background work") });
    expect(later.posts()).toHaveLength(0);

    // Omitted at first, then reported false: now it is sent.
    const reported = new FakeManus(PRIOR);
    delete reported.task.has_running_background_jobs;
    reported.onSend = (f) => {
      started(f);
      f.events.push(said(300, "ok", { delivery_kind: "result" }), status(301, "stopped"));
    };
    reported.evolve = [() => undefined, (f) => void (f.task.has_running_background_jobs = false)];
    expect(await manusPlugin.deliver(wake, input, reported.context())).toEqual({ kind: "replied", reply: "ok" });

    // Never reported (an old task): unknown is not false. Nothing is sent, through the whole delivery time.
    const never = new FakeManus(PRIOR);
    delete never.task.has_running_background_jobs;
    const delivery = await manusPlugin.deliver(wake, input, never.context(undefined, 2 * 60_000));
    expect(delivery).toMatchObject({ kind: "failed", why: expect.stringContaining("has_running_background_jobs is not reported") });
    expect(delivery.kind === "failed" && delivery.why).toContain("nothing was sent");
    expect(never.posts()).toHaveLength(0);
    expect(never.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(2 * 60_000);
  });

  it("falls back to the last message when none is marked a result, and names attached files without linking them", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(500), said(503, "Report attached.", { attachments: [{ filename: "report.pdf", url: "https://files.example/secret-link" }] }), status(504, "stopped"));
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    expect(delivery).toEqual({ kind: "replied", reply: `Report attached.\n\n(Manus attached report.pdf; they are in the task: ${LINK})` });
    expect(delivery.kind === "replied" && delivery.reply).not.toContain("secret-link");
  });

  it("fails with the agent's own words when the task errors", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(700), { id: "e1", type: "error_message", timestamp: 701, error_message: { content: "sandbox crashed" } }, status(702, "error"));
    expect(await manusPlugin.deliver(wake, input, fake.context())).toMatchObject({ kind: "failed", why: expect.stringContaining("sandbox crashed"), timedOut: false });
  });
});

describe("the manus plugin: waiting", () => {
  const ask = (type: string, extra: Record<string, unknown> = {}) => (f: FakeManus) =>
    f.events.push(user(600), said(601, "Which branch should I build?"), status(602, "waiting", { waiting_for_event_type: type, waiting_for_event_id: "evt_1", ...extra }));

  it("says a question is answered with an ordinary message (task.sendMessage), and that the next @ does that", async () => {
    for (const type of ["messageAskUser", "cascadeAskUser"]) {
      const fake = new FakeManus(PRIOR);
      fake.onSend = ask(type);
      const delivery = await manusPlugin.deliver(wake, input, fake.context());
      expect(delivery.kind === "replied" && delivery.reply).toContain("Which branch should I build?");
      expect(delivery.kind === "replied" && delivery.reply).toContain("@-mention this seat with your answer");
      expect(delivery.kind === "replied" && delivery.reply).toContain("task.sendMessage");
      expect(fake.paths().some((path) => path.includes("confirmAction"))).toBe(false);
    }
    // ... and it does: the task is waiting on a question, so the next wake's message is sent into it.
    const pending = new FakeManus([...PRIOR, user(600), said(601, "Which branch?"), status(602, "waiting", { waiting_for_event_type: "messageAskUser" })]);
    pending.task.status = "waiting";
    pending.onSend = (f) => {
      f.task.status = "stopped";
      f.events.push(user(700), said(703, "building main", { delivery_kind: "result" }), status(704, "stopped"));
    };
    expect(await manusPlugin.deliver(wake, input, pending.context())).toEqual({ kind: "replied", reply: "building main" });
    expect(pending.posts().map((call) => call.path)).toEqual(["/v2/task.sendMessage"]);
  });

  it("says an action confirmation is a task.confirmAction decision made in Manus, never from the Room", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = ask("terminalExecute", { waiting_description: "Run rm -rf build/" });
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    const text = delivery.kind === "replied" ? delivery.reply! : "";
    expect(text).toContain("confirmation of an action (terminalExecute: Run rm -rf build/)");
    expect(text).toContain("task.confirmAction decision");
    expect(text).toContain(`decide in Manus at ${LINK}`);
    expect(text).toContain("sends nothing while it is pending");
    // Not dispatched, whatever the pending action is.
    expect(fake.posts().map((call) => call.path)).toEqual(["/v2/task.sendMessage"]);
  });

  it("does not dispatch a waiting type it does not recognise, and says so", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = ask("somethingNew");
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    expect(delivery.kind === "replied" && delivery.reply).toContain("does not recognise (somethingNew)");
    expect(classifyWaiting(undefined)).toEqual({ kind: "unknown", type: "no type given" });
    // A listed confirmation without its target event is also not dispatched.
    expect(classifyWaiting({ waiting_for_event_type: "gmailSendAction" })).toEqual({ kind: "unknown", type: "gmailSendAction" });
    expect(classifyWaiting({ waiting_for_event_type: "gmailSendAction", waiting_for_event_id: "e", waiting_description: "Send mail" })).toEqual({ kind: "confirmation", type: "gmailSendAction", description: "Send mail" });
  });

  it("sends nothing into a task that is waiting on a confirmation or on something unknown: a message would skip the action", async () => {
    for (const [type, text] of [["gmailSendAction", "task.confirmAction decision"], ["somethingNew", "does not recognise"], [undefined, "does not recognise"]] as const) {
      const fake = new FakeManus([...PRIOR, user(600), status(602, "waiting", { ...(type ? { waiting_for_event_type: type, waiting_for_event_id: "evt_1" } : {}) })]);
      fake.task.status = "waiting";
      const delivery = await manusPlugin.deliver(wake, input, fake.context());
      expect(delivery).toMatchObject({ kind: "failed", why: expect.stringContaining(text) });
      expect(delivery.kind === "failed" && delivery.why).toContain("Nothing was sent.");
      expect(fake.posts()).toHaveLength(0);
    }
  });
});

describe("the manus plugin: starting a task", () => {
  it("creates a task per wake when the seat has none, without asking questions back", async () => {
    const fake = new FakeManus();
    fake.onSend = (f) => f.events.push(user(9), status(10, "running"), said(11, "On it: green.", { delivery_kind: "result" }), status(12, "stopped"));
    const delivery = await manusPlugin.deliver({ driver: "manus", cwd: "/work", command: MANUS_API, api_key_env: "TEAM_MANUS_KEY" }, input, fake.context({ TEAM_MANUS_KEY: KEY }));
    expect(delivery).toEqual({ kind: "replied", reply: "On it: green." });
    expect(fake.calls[0]).toMatchObject({ method: "POST", path: "/v2/task.create", body: { message: { content: expect.stringContaining("TURN PROMPT") }, interactive_mode: false } });
    expect(String(fake.calls[0]!.body!.title)).toContain("manus-helper");
    expect(fake.calls[1]!.query).toMatchObject({ task_id: TASK });
  });
});

describe("the manus plugin: the delivery's time", () => {
  it("polls with a growing delay up to a cap, and gives up with a link when the seat's wake limit is spent", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    const delivery = await manusPlugin.deliver(wake, input, fake.context({ MANUS_API_KEY: KEY }, 5 * 60_000));
    expect(delivery).toMatchObject({ kind: "failed", timedOut: false });
    expect(delivery.kind === "failed" && delivery.why).toContain(`still working after 5 minutes (this seat's wake limit); the task keeps running at ${LINK}`);
    expect(fake.sleeps.slice(0, 7)).toEqual([3000, 4500, 6750, 10125, 15188, 22782, 30000]);
    expect(Math.max(...fake.sleeps)).toBe(30_000);
    // the last sleep is cut to what is left, and the total never passes the limit
    expect(fake.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5 * 60_000);
  });

  it("never waits past two hours however long the wake limit is", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    const delivery = await manusPlugin.deliver(wake, input, fake.context({ MANUS_API_KEY: KEY }, 24 * 60 * 60_000));
    expect(delivery.kind === "failed" && delivery.why).toContain("after 120 minutes");
    expect(fake.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120 * 60_000);
  });

  it("bounds each request by what is left of the delivery, not by a fresh 30 seconds", async () => {
    // A Manus that never answers a poll. With a 400 ms wake limit the whole delivery ends in about that time.
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    const hang = (target: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const begun = Date.now();
    const delivery = await manusPlugin.deliver(wake, input, fake.context(undefined, 400, { api: { fetch: (target, init) => (String(target).includes("listMessages") && fake.posts().length > 0 ? hang(target, init) : fake.api.fetch!(target, init)) } }));
    expect(Date.now() - begun).toBeLessThan(2_500);
    expect(delivery).toMatchObject({ kind: "failed" });
    expect(delivery.kind === "failed" && delivery.why).toContain("keeps running");
    // And before the send: a lookup that hangs is a line left for later, within the same time.
    const lookup = Date.now();
    const early = await manusPlugin.deliver(wake, input, fake.context(undefined, 400, { api: { fetch: hang as typeof fetch } }));
    expect(Date.now() - lookup).toBeLessThan(2_500);
    expect(early).toMatchObject({ kind: "busy" });
  });

  it("ends its waiting and its requests when serve is stopping", async () => {
    // A poll is in flight (the stand-in's sleep returns at once) when serve stops: the request is cut, not waited out.
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    const stop = new AbortController();
    const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    setTimeout(() => stop.abort(), 100);
    const begun = Date.now();
    const delivery = await manusPlugin.deliver(wake, input, fake.context(undefined, 20 * 60_000, { signal: stop.signal, api: { ...fake.api, fetch: (target, init) => (String(target).includes("listMessages") && fake.posts().length > 0 ? hang(init) : fake.api.fetch!(target, init)) } }));
    expect(Date.now() - begun).toBeLessThan(2_000);
    expect(delivery).toMatchObject({ kind: "failed", why: expect.stringContaining("serve was stopping") });
    // While it sleeps between polls (the real sleep), a stop ends the sleep at once.
    const asleep = new FakeManus(PRIOR);
    asleep.onSend = started;
    const stopSleep = new AbortController();
    setTimeout(() => stopSleep.abort(), 100);
    const slept = Date.now();
    const woken = await manusPlugin.deliver(wake, input, asleep.context(undefined, 20 * 60_000, { signal: stopSleep.signal, api: { fetch: asleep.api.fetch } }));
    expect(Date.now() - slept).toBeLessThan(2_000);
    expect(woken).toMatchObject({ kind: "failed", why: expect.stringContaining("serve was stopping") });
    // Already stopping before anything is sent: nothing is lost, nothing is sent.
    const before = new FakeManus(PRIOR);
    const stopped = new AbortController();
    stopped.abort();
    expect(await manusPlugin.deliver(wake, input, before.context(undefined, 60_000, { signal: stopped.signal }))).toMatchObject({ kind: "busy" });
    expect(before.posts()).toHaveLength(0);
  });
});

describe("the manus plugin: reading a long run", () => {
  it("pages back through the events to this wake's marker when more than a page is new", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => {
      started(f);
      for (let n = 0; n < 230; n += 1) f.events.push(said(1_000 + n, `progress ${n}`, { delivery_kind: "progress" }));
      f.events.push(said(2_000, "all done", { delivery_kind: "result" }), status(2_001, "stopped"));
    };
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "all done" });
    expect(fake.calls.some((call) => call.query.cursor === "100")).toBe(true);
    expect(fake.calls.some((call) => call.query.cursor === "200")).toBe(true);
  });

  it("keeps the marker once seen, so later events cannot push it out of view even past the pages that are read", async () => {
    // 2,100 events arrive after the marker was seen: more than the pages read in one poll (20 x 100). Without the
    // remembered marker the wake would never be recognised again and would run out its time.
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    fake.evolve = [
      () => undefined,
      (f) => {
        for (let n = 0; n < 2_100; n += 1) f.events.push(said(1_000 + n, `progress ${n}`, { delivery_kind: "progress" }));
        f.events.push(said(5_000, "the end", { delivery_kind: "result" }), status(5_001, "stopped"));
      },
    ];
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "the end" });
  });
});

describe("the manus plugin: the message and the reply", () => {
  it("leaves serve's execution-budget paragraph out of what Manus is sent, since a cloud task cannot checkpoint", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(9_000), said(9_001, "ok", { delivery_kind: "result" }), status(9_002, "stopped"));
    const prompt = "[SharedNet] You were addressed.\n#7 ann: hi\n\nDo what is asked.\n\nExecution budget: 40 minutes; sharednet wake checkpoint \"x\" --as i_Seat.\n\nMore after.";
    await manusPlugin.deliver(wake, { ...input, prompt }, fake.context());
    expect(String(fake.posts()[0]!.body!.message.content).replace(/\n\n\[sharednet-wake [0-9a-f]{16}\]$/, "")).toBe("[SharedNet] You were addressed.\n#7 ann: hi\n\nDo what is asked.\n\nMore after.");
    expect(withoutBudget("no budget here")).toBe("no budget here");
  });

  it("cuts a long prompt by estimated tokens, not characters: Chinese and dense code get far fewer characters", () => {
    expect(fitPrompt("short")).toBe("short");
    const ascii = `HEAD-${"x".repeat(40_000)}-TAIL`;
    const fitted = fitPrompt(ascii);
    expect(estimateTokens(fitted)).toBeLessThan(3_700);
    expect(fitted.startsWith("HEAD-")).toBe(true);
    expect(fitted.endsWith("-TAIL")).toBe(true);
    expect(fitted).toContain("cut to fit one Manus message");
    // 6,000 Chinese characters are 9,000 estimated tokens: far over a limit that characters alone (12,000) would have let through.
    const chinese = `开头${"房间里的话".repeat(1_200)}结尾`;
    expect(estimateTokens(chinese)).toBeGreaterThan(5_000);
    const cut = fitPrompt(chinese);
    expect(estimateTokens(cut)).toBeLessThan(3_700);
    expect(cut.startsWith("开头")).toBe(true);
    expect(cut.endsWith("结尾")).toBe(true);
    expect([...cut].length).toBeLessThan(3_000);
  });

  it("renders a reply's links as the attachments guide says: http kept, a matching path named, the rest removed", () => {
    const attachments = [{ filename: "report.pdf", path: "/home/ubuntu/report.pdf" }];
    expect(cleanLinks("See [the docs](https://example.com/docs) and ![chart](https://example.com/c.png).", attachments)).toBe("See [the docs](https://example.com/docs) and ![chart](https://example.com/c.png).");
    expect(cleanLinks("Here is [the report](/home/ubuntu/report.pdf) done.", attachments)).toBe("Here is the report (attachment report.pdf, in the Manus task) done.");
    expect(cleanLinks("Open [the site](manus-webdev://abc123) now, or [other](/home/ubuntu/missing.txt) or ![x](ftp://host/x).", attachments)).toBe("Open  now, or  or .");
    expect(cleanLinks("encoded [r](/home/ubuntu/rep%6Frt.pdf)", [{ filename: "report.pdf", path: "/home/ubuntu/report.pdf" }])).toBe("encoded r (attachment report.pdf, in the Manus task)");
    expect(cleanLinks("no links here", attachments)).toBe("no links here");
  });

  it("applies that to the reply it posts, with no signed URL in it", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(9_000), said(9_001, "Done: [report](/home/ubuntu/report.pdf) and [site](manus-webdev://v1).", { delivery_kind: "result", attachments: [{ filename: "report.pdf", path: "/home/ubuntu/report.pdf", url: "https://private.example/signed?token=abc" }] }), status(9_002, "stopped"));
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    const text = delivery.kind === "replied" ? delivery.reply! : "";
    expect(text).toContain("Done: report (attachment report.pdf, in the Manus task) and .");
    expect(text).not.toContain("signed");
    expect(text).not.toContain("manus-webdev");
  });
});

describe("the manus plugin: the key stays out of every program serve starts", () => {
  const secrets = { MANUS_API_KEY: KEY, TEAM_MANUS_KEY: `${KEY}-team`, SAFE: "kept" };

  it("withholds the default name always, and a custom name as soon as a seat file that names it is read", () => {
    const env = { MANUS_API_KEY: KEY, FRESH_SEAT_KEY: `${KEY}-fresh`, SAFE: "kept" };
    expect(harnessFreeEnv(env)).toMatchObject({ FRESH_SEAT_KEY: `${KEY}-fresh`, SAFE: "kept" });
    expect(harnessFreeEnv(env)).not.toHaveProperty("MANUS_API_KEY");
    // Reading the seat that names FRESH_SEAT_KEY is when this process learns it (serve reads every seat before any delivery).
    parseSeatWake({ driver: "manus", cwd: "/w", command: MANUS_API, api_key_env: "FRESH_SEAT_KEY" });
    expect(harnessFreeEnv(env)).toEqual({ SAFE: "kept" });
    expect(withoutSecrets({ ...env, UNSET: undefined })).toEqual({ SAFE: "kept" });
    // The one process that owns the key (the serve a join starts) keeps it.
    expect(harnessFreeEnv(env, true)).toMatchObject(env);
  });

  it("gives neither a resumed Claude turn nor a command adapter any of them", async () => {
    parseSeatWake({ driver: "manus", cwd: "/w", command: MANUS_API, api_key_env: "TEAM_MANUS_KEY" });
    const ran: TurnSpec[] = [];
    const context: DeliveryContext = { env: { ...secrets, PATH: "" }, timeoutMs: 60_000, chatOpen: () => false, run: async (spec) => (ran.push(spec), { exitCode: 0, stdout: '{"type":"result","is_error":false,"result":"ok"}', stderr: "", timedOut: false }) };
    await claudePlugin.deliver({ driver: "claude-code", session: "6613", cwd: "/w", command: "claude" }, input, context);
    await commandPlugin.deliver({ driver: "command", cwd: "/w", command: "/bin/bot" }, input, context);
    expect(ran).toHaveLength(2);
    for (const spec of ran) {
      expect(spec.env).toMatchObject({ SAFE: "kept" });
      expect(spec.env).not.toHaveProperty("MANUS_API_KEY");
      expect(spec.env).not.toHaveProperty("TEAM_MANUS_KEY");
    }
  });
});

describe("the manus plugin: check", () => {
  const run = async () => {
    throw new Error("no program");
  };

  it("checks the address and key, then the key with a read-only call, then the task, and makes no Manus turn", async () => {
    const good = new FakeManus();
    const ok = await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: true, api: good.api });
    expect(ok.ok).toBe(true);
    expect(ok.steps?.map((step) => `${step.step}:${step.status}`)).toEqual(["program:ok", "signed_in:ok", "session:ok", "call:skipped"]);
    expect(good.paths()).toEqual(["GET /v2/user.me", "GET /v2/task.detail"]);
    // A seat without a task has nothing to look up.
    const fresh = new FakeManus();
    const none = await manusPlugin.check({ ...wake, session: undefined }, { MANUS_API_KEY: KEY }, run, { call: false, api: fresh.api });
    expect(none.steps?.map((step) => `${step.step}:${step.status}`)).toEqual(["program:ok", "signed_in:ok", "session:ok"]);
    expect(fresh.paths()).toEqual(["GET /v2/user.me"]);
  });

  it("says what is wrong: no key, a foreign address, a rejected key, a task this key does not have, a doubt about Manus itself", async () => {
    const offline = new FakeManus();
    const unset = await manusPlugin.check(wake, {}, run, { call: false, api: offline.api });
    expect(unset).toMatchObject({ ok: false });
    expect(unset.steps![0]).toMatchObject({ step: "program", status: "failed", message: "MANUS_API_KEY is not set in this environment" });
    expect(unset.steps!.slice(1).every((step) => step.status === "skipped")).toBe(true);
    const foreign = await manusPlugin.check({ ...wake, command: "https://attacker.example" }, { MANUS_API_KEY: KEY }, run, { call: false, api: offline.api });
    expect(foreign.steps![0]).toMatchObject({ status: "failed", message: expect.stringContaining("only sent to https://api.manus.ai") });
    expect(offline.calls).toHaveLength(0);
    const bad = new FakeManus();
    bad.replies["GET /v2/user.me"] = { status: 401, body: { ok: false, error: { code: "unauthenticated", message: "no" } } };
    expect(await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: false, api: bad.api })).toMatchObject({ ok: false, message: expect.stringContaining("Manus rejected the API key in MANUS_API_KEY") });
    const gone = new FakeManus();
    gone.replies["GET /v2/task.detail"] = { status: 404, body: { ok: false, error: { code: "not_found", message: "no" } } };
    expect(await manusPlugin.check(wake, { MANUS_API_KEY: KEY }, run, { call: false, api: gone.api })).toMatchObject({ ok: false, message: expect.stringContaining(`Manus has no task ${TASK}`) });
    // Manus being down is a doubt (a warning), not a verdict: a seat is still driven.
    const down = new FakeManus();
    down.replies["GET /v2/user.me"] = { status: 503, body: { ok: false, error: { code: "internal", message: "unavailable" } } };
    const warned = await manusPlugin.check({ ...wake, session: undefined }, { MANUS_API_KEY: KEY }, run, { call: false, api: down.api });
    expect(warned.ok).toBe(true);
    expect(warned.steps![1]).toMatchObject({ step: "signed_in", status: "warning" });
  });
});

describe("the manus plugin: when it cannot be delivered", () => {
  it("fails without a request when the key variable is not set, naming the variable and never a value", async () => {
    const fake = new FakeManus();
    const delivery = await manusPlugin.deliver({ ...wake, api_key_env: "OTHER_MANUS_KEY" }, input, fake.context({ MANUS_API_KEY: KEY }));
    expect(delivery).toMatchObject({ kind: "failed", why: "OTHER_MANUS_KEY is not set in the environment of sharednet serve" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to send the key to any other origin, and treats a redirect as an error", async () => {
    const fake = new FakeManus();
    expect(await manusPlugin.deliver({ ...wake, command: "https://attacker.example" }, input, fake.context())).toMatchObject({ kind: "failed", why: expect.stringContaining("only sent to https://api.manus.ai") });
    expect(fake.calls).toHaveLength(0);
    const redirecting = await manusPlugin.deliver(wake, input, fake.context(undefined, 60_000, { api: { fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }) } }));
    expect(redirecting).toMatchObject({ kind: "failed", why: expect.stringContaining("redirect, which is not followed") });
    expect(JSON.stringify(redirecting)).not.toContain(KEY);
  });

  it("puts a rate-limited send off, and reports a rejected key without echoing it", async () => {
    const limited = new FakeManus(PRIOR);
    limited.replies["POST /v2/task.sendMessage"] = { status: 429, body: { ok: false, error: { code: "rate_limited", message: "Rate limit exceeded" } } };
    expect(await manusPlugin.deliver(wake, input, limited.context())).toMatchObject({ kind: "busy", retryMs: 60_000 });
    const rejected = new FakeManus(PRIOR);
    rejected.replies["POST /v2/task.sendMessage"] = { status: 401, body: { ok: false, error: { code: "unauthenticated", message: `invalid key ${KEY}` } } };
    const delivery = await manusPlugin.deliver(wake, input, rejected.context());
    expect(delivery).toMatchObject({ kind: "failed", why: "Manus rejected the API key in MANUS_API_KEY" });
    expect(JSON.stringify(delivery)).not.toContain(KEY);
  });

  it("does not send again when a write may have gone through, but retries a read", async () => {
    const write = new FakeManus(PRIOR);
    const real = write.api.fetch!;
    let attempts = 0;
    write.api.fetch = async (target, init) => {
      if (String(target).includes("sendMessage")) {
        attempts += 1;
        throw new TypeError("fetch failed");
      }
      return real(target, init);
    };
    expect(await manusPlugin.deliver(wake, input, write.context())).toMatchObject({ kind: "failed", why: expect.stringContaining("not sent again") });
    expect(attempts).toBe(1);
    const read = new FakeManus(PRIOR);
    const readReal = read.api.fetch!;
    read.api.fetch = async (target, init) => {
      if (String(target).includes("task.detail")) throw new TypeError("fetch failed");
      return readReal(target, init);
    };
    expect(await manusPlugin.deliver(wake, input, read.context())).toMatchObject({ kind: "busy", retryMs: 30_000 });
    expect(read.posts()).toHaveLength(0);
    const gone = new FakeManus(PRIOR);
    gone.replies["GET /v2/task.detail"] = { status: 404, body: { ok: false, error: { code: "not_found", message: "task not found" } } };
    expect(await manusPlugin.deliver(wake, input, gone.context())).toMatchObject({ kind: "failed", why: "Manus task lookup: task not found" });
  });

  it("gives up reading after repeated failures, pointing at the task that may still answer", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    const real = fake.api.fetch!;
    let polls = 0;
    fake.api.fetch = async (target, init) => {
      if (String(target).includes("listMessages") && fake.posts().length > 0 && ++polls > 0) throw new TypeError("fetch failed");
      return real(target, init);
    };
    expect(await manusPlugin.deliver(wake, input, fake.context())).toMatchObject({ kind: "failed", why: expect.stringContaining(`may still answer at ${LINK}`) });
    expect(polls).toBe(5);
  });
});

describe("the manus plugin: second review of #31 (each case is a probe that failed on c81069f)", () => {
  it("re-judges the task on every refresh before sending: stopped, then running, is not sent into", async () => {
    const fake = new FakeManus(PRIOR);
    delete fake.task.has_running_background_jobs;
    fake.evolve = [(f) => void (f.task.status = "running")];
    expect(await manusPlugin.deliver(wake, input, fake.context())).toMatchObject({ kind: "busy", why: "its Manus task is still running" });
    expect(fake.posts()).toHaveLength(0);
  });

  it("does not consume a stale result when a fresh read says the task is running again, though jobs read false", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(200), said(203, "stale answer", { delivery_kind: "result" }), status(204, "stopped"));
    // The first read after the stop already shows a run again; only the later one is the settled end.
    fake.task.status = "running";
    fake.evolve = [
      () => undefined,
      (f) => {
        f.task.status = "stopped";
        f.events.push(said(300, "the real answer", { delivery_kind: "result" }), status(301, "stopped"));
      },
    ];
    // task.detail first says stopped (before the send); the run is running by the time the stop is read.
    fake.task.status = "stopped";
    let reads = 0;
    const real = fake.api.fetch!;
    fake.api.fetch = async (target, init) => {
      if (String(target).includes("task.detail") && fake.posts().length > 0 && ++reads === 1) fake.task.status = "running";
      return real(target, init);
    };
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "the real answer" });
  });

  it("does not take another run's answer for this wake's: only the user event carrying this wake's own nonce is the start", async () => {
    // Another message from the UI (or a trigger) starts a run before this wake's event appears.
    const fake = new FakeManus(PRIOR);
    fake.onSend = () => undefined;
    fake.evolve = [
      (f) => f.events.push(user(150, "a message typed in the Manus app"), status(151, "running"), said(152, "the other run's answer", { delivery_kind: "result" }), status(153, "stopped")),
      (f) => f.events.push(user(200), status(201, "running"), said(202, "this wake's answer", { delivery_kind: "result" }), status(203, "stopped")),
    ];
    // (the user(200) above has no content yet: give it the nonce the plugin sent)
    const real = fake.api.fetch!;
    let sent = "";
    fake.api.fetch = async (target, init) => {
      if (String(target).includes("sendMessage")) sent = JSON.parse(String(init!.body)).message.content;
      for (const event of fake.events) if (event.type === "user_message" && (event.user_message as { content: string }).content === "__SENT__") (event.user_message as { content: string }).content = sent;
      return real(target, init);
    };
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "this wake's answer" });
  });

  it("counts failures of task.detail on their own, so a succeeding listMessages does not hide them", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) => f.events.push(user(200), said(203, "done", { delivery_kind: "result" }), status(204, "stopped"));
    const real = fake.api.fetch!;
    let detailFailures = 0;
    fake.api.fetch = async (target, init) => {
      if (String(target).includes("task.detail") && fake.posts().length > 0 && ++detailFailures > 0) throw new TypeError("fetch failed");
      return real(target, init);
    };
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    expect(delivery).toMatchObject({ kind: "failed", why: expect.stringContaining("could not be read after the message was sent") });
    expect(detailFailures).toBe(5);
  });

  it("answers a 429 while polling with the service's own delay, and does not give up after five", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    fake.queue["GET /v2/task.listMessages"] = [
      { status: 200, body: { ok: true, messages: [], has_more: false } }, // the baseline read at the start
      ...Array.from({ length: 8 }, () => ({ status: 429, body: { ok: false, error: { code: "rate_limited", message: "slow down" } }, headers: { "retry-after": "20" } })),
    ];
    fake.evolve = Array.from({ length: 8 }, () => () => undefined);
    fake.evolve.push((f) => f.events.push(said(300, "done", { delivery_kind: "result" }), status(301, "stopped")));
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "done" });
    // Each wait after a 429 is at least what the service said (20 s), not the poll's own short interval.
    const waits = fake.sleeps.slice(1, 9);
    expect(waits.every((ms) => ms >= 20_000)).toBe(true);
  });

  it("without a Retry-After, a 429 doubles the next wait, up to a minute", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = started;
    fake.queue["GET /v2/task.listMessages"] = [{ status: 200, body: { ok: true, messages: [], has_more: false } }, ...Array.from({ length: 4 }, () => ({ status: 429, body: { ok: false, error: { code: "rate_limited", message: "slow down" } } }))];
    fake.evolve = [() => undefined, () => undefined, () => undefined, () => undefined, (f) => f.events.push(said(300, "ok", { delivery_kind: "result" }), status(301, "stopped"))];
    expect(await manusPlugin.deliver(wake, input, fake.context())).toEqual({ kind: "replied", reply: "ok" });
    // the next planned wait, doubled each time, up to a minute
    expect(fake.sleeps.slice(1, 5)).toEqual([9000, 27000, 60000, 60000]);
  });

  it("removes a whole unresolved link node, however its destination is written", () => {
    // balanced parentheses in the destination, an angle-bracket destination with spaces, a title, a nested label
    expect(cleanLinks("See [r](/home/ubuntu/report_(1).pdf) here.")).toBe("See  here.");
    expect(cleanLinks("See [r](</home/ubuntu/my report.pdf>) here.")).toBe("See  here.");
    expect(cleanLinks('See [r](/home/ubuntu/a.pdf "the title") here.')).toBe("See  here.");
    expect(cleanLinks("See ![chart [1]](/home/ubuntu/c(2).png) here.")).toBe("See  here.");
    expect(cleanLinks("a [not a link] and (parens) stay; so does [x] (y)")).toBe("a [not a link] and (parens) stay; so does [x] (y)");
    // ... and resolves a matching one written either way
    const attachments = [{ filename: "my report.pdf", path: "/home/ubuntu/my report.pdf" }, { filename: "r (1).pdf", path: "/home/ubuntu/r_(1).pdf" }];
    expect(cleanLinks("[a](</home/ubuntu/my report.pdf>) and [b](/home/ubuntu/r_(1).pdf).", attachments)).toBe("a (attachment my report.pdf, in the Manus task) and b (attachment r (1).pdf, in the Manus task).");
    expect(cleanLinks("[a](https://example.com/x_(1))", attachments)).toBe("[a](https://example.com/x_(1))");
  });

  it("shows the Room a question's choices, which Manus supplies as options and a selection mode", async () => {
    const fake = new FakeManus(PRIOR);
    fake.onSend = (f) =>
      f.events.push(
        user(600),
        said(601, "Which formats should I export?", { question_expectation: { options: ["PDF", "DOCX"], selection_mode: "multiple", response_method: "send_message" } }),
        status(602, "waiting", { waiting_for_event_type: "messageAskUser", waiting_for_event_id: "evt_1" }),
      );
    const delivery = await manusPlugin.deliver(wake, input, fake.context());
    const text = delivery.kind === "replied" ? delivery.reply! : "";
    expect(text).toContain("Which formats should I export?");
    expect(text).toContain("Choices: 1) PDF 2) DOCX (you may pick several, or answer in your own words).");
    const single = new FakeManus(PRIOR);
    single.onSend = (f) => f.events.push(user(600), said(601, "Which branch?", { question_expectation: { options: ["main", "dev"], selection_mode: "single" } }), status(602, "waiting", { waiting_for_event_type: "cascadeAskUser", waiting_for_event_id: "evt_1" }));
    const one = await manusPlugin.deliver(wake, input, single.context());
    expect(one.kind === "replied" && one.reply).toContain("Choices: 1) main 2) dev (pick one, or answer in your own words).");
  });
});
