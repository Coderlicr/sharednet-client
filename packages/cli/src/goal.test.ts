// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApiClient } from "./api-client.ts";
import { CliError } from "./errors.ts";
import { goalExport, goalWatch, parseUntil, parseUntilList, withRequestLimit, workspaceSnapshots } from "./goal.ts";

const ROOM = "rom_AbCdEfGhIj";
const HUMAN = "i_HumanSeat01";
const RUNNER = "i_RunnerSeat1";
const AGENT = "i_AgentSeat01";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "sharednet-goal-"));
  cleanup.push(dir);
  return dir;
}

/** A local wall-clock time, so the cases hold in any time zone the suite runs in. */
const local = (hour: number, minute = 0) => new Date(2026, 9, 5, hour, minute, 0).getTime();

describe("--until", () => {
  it("speaks the language of wait --on, plus budget, and sends at with this machine's offset", () => {
    const now = local(12, 3);
    expect(parseUntil("check: pytest -q", now).wire).toBe("check pytest -q");
    expect(parseUntil("count 200", now).wire).toBe("count 200");
    expect(parseUntil("said: DONE", now).wire).toBe("said DONE");
    expect(parseUntil("budget: 5M tokens", now)).toMatchObject({ wire: "budget 5M tokens", trigger: { kind: "budget", tokens: 5_000_000 } });
    expect(parseUntil("budget 500k", now)).toMatchObject({ wire: "budget 500k tokens", trigger: { kind: "budget", tokens: 500_000 } });
    const at = parseUntil("at 17:30", now).wire;
    expect(at).toMatch(/^at 2026-10-05T17:30:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(at.slice(3))).toBe(local(17, 30));
    for (const raw of ["every 10m", "cron 0 9 * * *", "closed", "budget twenty", "budget $20", "sometimes"]) {
      expect(() => parseUntil(raw, now), raw).toThrow();
    }
  });

  it("refuses a goal with no bound before anything is sent, and keeps one copy of each trigger", () => {
    expect(() => parseUntilList([], 0)).toThrow();
    expect(() => parseUntilList(["check make test", "idle 10m"], 0)).toThrow(expect.objectContaining({ code: "goal_unbounded" }));
    expect(parseUntilList(["check make test", "after 2h", "after: 2h"], 0).wire).toEqual(["check make test", "after 2h"]);
  });

  it("offers a budget only where it is measured: goal run reads the Agents' usage, a Room alone cannot", () => {
    expect(() => parseUntilList(["budget 2M tokens", "after 2h"], 0)).toThrow(expect.objectContaining({ code: "budget_needs_goal_run" }));
    expect(parseUntilList(["check make test", "budget 2M tokens"], 0, { budget: true }).wire).toEqual(["check make test", "budget 2M tokens"]);
  });
});

type Call = { method: string; path: string; token: string; body: unknown };

/**
 * A goal Room as the API answers it: the Room with its goal, waits that hand
 * out the scripted pages in turn, and the runner's own writes recorded.
 */
function fakeRoom(options: {
  until: string[];
  /** What each wait answers, in turn; an error is thrown instead. */
  pages: Array<Array<{ sequence: number; content: string; sender: string }> | CliError>;
  states?: Array<{ state: "open" | "closed"; ended_by?: { trigger: string; at: string; detail: string | null } | null } | CliError>;
  /** Errors the close answers with, in turn, before it succeeds. */
  closes?: CliError[];
}) {
  const calls: Call[] = [];
  const pages = [...options.pages];
  const states = [...(options.states ?? [])];
  const closes = [...(options.closes ?? [])];
  const goal = { message_id: "msg_goal000001", sequence: 1, until: options.until, started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
  const client = {
    async request(method: string, path: string, token: string, body?: unknown) {
      calls.push({ method, path, token, body });
      if (method === "GET" && path === `/rooms/${ROOM}`) {
        const state = states.shift() ?? { state: "open" as const, ended_by: null };
        if (state instanceof CliError) throw state;
        return {
          room: { id: ROOM, state: state.state, goal: { ...goal, ended_by: state.ended_by ?? null } },
          memberships: [
            { member_id: HUMAN, name: "Ada Lovelace", runtime_kind: "human" },
            { member_id: AGENT, name: "codex", runtime_kind: "codex" },
          ],
        };
      }
      if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
        const page = pages.shift() ?? [];
        if (page instanceof CliError) throw page;
        return {
          items: page.map((item) => ({ ...item, sender_instance_id: item.sender, sender: { member_id: item.sender, name: null } })),
        };
      }
      if (method === "POST" && path === `/rooms/${ROOM}/owner-messages`) {
        return { message: { sequence: 99, sender_instance_id: RUNNER } };
      }
      if (method === "POST" && path === `/rooms/${ROOM}/close`) {
        const failure = closes.shift();
        if (failure) throw failure;
        const end = body as { trigger: string; detail: string | null };
        return { room: { state: "closed", goal: { ...goal, ended_by: { ...end, at: "2026-10-05T12:30:00.000Z" } } } };
      }
      throw new CliError("route_not_found", `unexpected ${method} ${path}`, 2);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

function clock(start = Date.parse("2026-10-05T12:00:00.000Z"), step = 5_000) {
  let now = start;
  return () => new Date((now += step));
}

describe("goal watch", () => {
  it("ends the Room with the check that starts to pass, and writes the record", async () => {
    const out = await temporary();
    const { client, calls } = fakeRoom({
      until: ["check make test", "after 2h"],
      pages: [[{ sequence: 1, content: "Make it pass.", sender: HUMAN }, { sequence: 2, content: "On it.", sender: AGENT }], []],
    });
    const outcomes = [{ exitCode: 1, output: "1 failed" }, { exitCode: 0, output: "27 passed" }];
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 10_000, quietChecks: false }, {
      now: clock(),
      sleep: async () => undefined,
      check: async () => outcomes.shift() ?? { exitCode: 0, output: "" },
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "check make test", detail: "27 passed" });
    const close = calls.find((call) => call.path.endsWith("/close"))!;
    expect(close).toMatchObject({ method: "POST", token: "snk_owner", body: { trigger: "check make test", detail: "27 passed" } });
    // The Room is read with the member's token; only the runner's own writes use the account key.
    expect(calls.filter((call) => call.method === "GET").every((call) => call.token === "sni_member")).toBe(true);
    const checks = (await readFile(join(out, "checks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(checks.map((check) => [check.exit_code, check.passed, check.cause])).toEqual([[1, false, "schedule"], [0, true, "schedule"]]);
    const log = (await readFile(join(out, "room.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).sequence);
    expect(log).toEqual([1, 2]);
    const episode = JSON.parse(await readFile(join(out, "episode.json"), "utf8"));
    expect(episode).toMatchObject({ room_id: ROOM, goal: { sequence: 1, until: ["check make test", "after 2h"] }, ended_by: { trigger: "check make test" }, totals: { checks: 2 } });
  });

  it("takes a claim of being done to the check, and says a failing check back into the Room as the runner", async () => {
    const out = await temporary();
    const { client, calls } = fakeRoom({
      until: ["said DONE", "check make test", "count 50"],
      pages: [
        [{ sequence: 2, content: "DONE, all units in.", sender: AGENT }],
        [{ sequence: 3, content: "check failed …", sender: RUNNER }],
        [{ sequence: 4, content: "Fixed W3. DONE.", sender: AGENT }],
      ],
    });
    // The scheduled check fails; the first claim's check fails; the second claim's passes.
    const outcomes = [{ exitCode: 1, output: "W3 fails" }, { exitCode: 1, output: "W3 fails" }, { exitCode: 0, output: "all pass" }];
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 3_600_000, quietChecks: false }, {
      now: clock(),
      sleep: async () => undefined,
      check: async () => outcomes.shift() ?? { exitCode: 1, output: "" },
      snapshot: null,
    });
    const said = calls.filter((call) => call.path.endsWith("/owner-messages"));
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toMatchObject({ as: "runner" });
    expect((said[0]!.body as { content: string }).content).toContain("#2 says done");
    expect((said[0]!.body as { content: string }).content).toContain("W3 fails");
    // The runner's own line did not count as a claim; the second claim ended it, through the check.
    expect(result.ended_by).toMatchObject({ trigger: "check make test", detail: "all pass" });
  });

  it("stays quiet when told to, and ends on what was said when no check stands behind it", async () => {
    const out = await temporary();
    const quiet = fakeRoom({ until: ["said DONE", "after 1h"], pages: [[{ sequence: 2, content: "DONE", sender: AGENT }]] });
    const result = await goalWatch(quiet.client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: true }, {
      now: clock(),
      sleep: async () => undefined,
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "said DONE" });
    expect(quiet.calls.some((call) => call.path.endsWith("/owner-messages"))).toBe(false);
  });

  it("notices an end the service made by itself, and does not close it again", async () => {
    const out = await temporary();
    const { client, calls } = fakeRoom({
      until: ["count 2", "check make test"],
      pages: [[], []],
      states: [{ state: "open" }, { state: "closed", ended_by: { trigger: "count 2", at: "2026-10-05T12:10:00.000Z", detail: null } }],
    });
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 3_600_000, quietChecks: false, roomCheckMs: 1 }, {
      now: clock(),
      sleep: async () => undefined,
      check: async () => ({ exitCode: 1, output: "" }),
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "count 2" });
    expect(calls.some((call) => call.path.endsWith("/close"))).toBe(false);
  });

  it("ends on idle once the Agents have gone quiet for long enough", async () => {
    const out = await temporary();
    const { client } = fakeRoom({ until: ["idle 1m", "after 2h"], pages: [[{ sequence: 2, content: "working", sender: AGENT }], [], [], []] });
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: false }, {
      now: clock(Date.parse("2026-10-05T12:00:00.000Z"), 30_000),
      sleep: async () => undefined,
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "idle 1m" });
  });

  it("rides out an outage: the poll is tried again with a growing pause, and the close too", async () => {
    const out = await temporary();
    const down = () => new CliError("service_unavailable", "The SharedNet service could not be reached.", 5);
    const { client, calls } = fakeRoom({
      until: ["said DONE", "after 2h"],
      pages: [down(), down(), [{ sequence: 2, content: "DONE", sender: AGENT }]],
      closes: [down()],
    });
    const pauses: number[] = [];
    const lines: string[] = [];
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: true }, {
      now: clock(),
      sleep: async (ms) => {
        pauses.push(ms);
      },
      stderr: (line) => lines.push(line),
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "said DONE", at: "2026-10-05T12:30:00.000Z" });
    expect(pauses.filter((ms) => ms > 0)).toEqual([1_000, 2_000, 1_000]);
    expect(calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(2);
    expect(lines.join("")).toContain("trying again in 1s, attempt 1");
    expect(lines.join("")).toContain("answers again, after 2 failed attempts");
  });

  it("does not wait out a refusal: a seat the service turned away ends the runner at once", async () => {
    const out = await temporary();
    const { client } = fakeRoom({ until: ["after 2h"], pages: [new CliError("forbidden", "SharedNet rejected the request.", 4)] });
    await expect(
      goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: false }, {
        now: clock(),
        sleep: async () => undefined,
        snapshot: null,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reads the end of a Room the service closed at once, instead of asking the wait again and again", async () => {
    const out = await temporary();
    const { client, calls } = fakeRoom({
      until: ["count 2", "after 2h"],
      pages: [new CliError("room_closed", "SharedNet rejected the request.", 4)],
      states: [{ state: "open" }, { state: "closed", ended_by: { trigger: "count 2", at: "2026-10-05T12:10:00.000Z", detail: null } }],
    });
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 3_600_000, quietChecks: false }, {
      now: clock(),
      sleep: async () => undefined,
      snapshot: null,
    });
    expect(result.ended_by).toMatchObject({ trigger: "count 2" });
    expect(calls.filter((call) => call.path.includes("/wait?"))).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith("/close"))).toBe(false);
  });

  it("keeps the checks a stopped runner already ran, and counts them", async () => {
    const out = await temporary();
    await writeFile(join(out, "checks.ndjson"), '{"trigger":"check make test","passed":false}\n{"trigger":"check make test","passed":false}\n');
    const { client } = fakeRoom({ until: ["check make test", "after 2h"], pages: [[]] });
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 10_000, quietChecks: false }, {
      now: clock(),
      sleep: async () => undefined,
      check: async () => ({ exitCode: 0, output: "ok" }),
      snapshot: null,
    });
    expect(result).toMatchObject({ ended_by: { trigger: "check make test" }, checks: 3 });
    expect((await readFile(join(out, "checks.ndjson"), "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("ends on a token budget when the runner can count the Agents' spend", async () => {
    const out = await temporary();
    const { client, calls } = fakeRoom({ until: ["budget 1k tokens", "after 2h"], pages: [[], [], []] });
    let used = 400;
    const result = await goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: false }, {
      now: clock(),
      sleep: async () => undefined,
      snapshot: null,
      spend: () => (used += 400),
    });
    expect(result.ended_by).toMatchObject({ trigger: "budget 1k tokens", detail: "1200 tokens" });
    expect(calls.find((call) => call.path.endsWith("/close"))?.body).toMatchObject({ trigger: "budget 1k tokens" });
    // Spend is looked at every few seconds, not once per long-poll.
    expect(calls.filter((call) => call.path.includes("/wait?")).every((call) => /timeout=5$/.test(call.path))).toBe(true);
  });

  it("refuses a Room with no goal", async () => {
    const client = { request: async () => ({ room: { id: ROOM, state: "open", goal: null }, memberships: [] }) } as unknown as ApiClient;
    const out = await temporary();
    await expect(
      goalWatch(client, "sni_member", "snk_owner", { roomId: ROOM, workspace: out, out, checkEveryMs: 60_000, quietChecks: false }, { now: clock(), snapshot: null }),
    ).rejects.toMatchObject({ code: "not_a_goal_room" });
  });
});

describe("workspace snapshots", () => {
  it("commits a tick only when the files changed, tagged with the sequence, and never records the record, the seat state or an .env file", async () => {
    const workspace = await temporary();
    const out = join(workspace, "runs", ROOM);
    await writeFile(join(workspace, "a.txt"), "a\n");
    // The CLI's seat bookkeeping for an Agent that joined from the workspace: not the work.
    await mkdir(join(workspace, "agent", ".sharednet"), { recursive: true });
    await writeFile(join(workspace, "agent", ".sharednet", "seat.json"), '{"token":"sni_secret"}\n');
    await writeFile(join(workspace, ".env.local"), "KEY=secret\n");
    await writeFile(join(workspace, ".env.example"), "KEY=\n");
    const snapshot = workspaceSnapshots(workspace, out);
    expect(await snapshot("start")).toMatch(/^[0-9a-f]{40}$/);
    expect(await snapshot("seq 3")).toBeNull();
    await writeFile(join(workspace, "b.txt"), "b\n");
    const changed = await snapshot("seq 4");
    expect(changed).toMatch(/^[0-9a-f]{40}$/);
    const { execFileSync } = await import("node:child_process");
    const files = execFileSync("git", [`--git-dir=${join(out, "workspace.git")}`, "ls-tree", "-r", "--name-only", "seq-4"], { encoding: "utf8" });
    expect(files.trim().split("\n")).toEqual([".env.example", "a.txt", "b.txt"]);
  });

  // Root reads every file, so the case needs a user the permission applies to.
  it.skipIf(process.getuid?.() === 0)("leaves out a file the runner may not read, a benchmark's execute-only reference binary, and snapshots the rest", async () => {
    const workspace = await temporary();
    const out = join(workspace, "runs", ROOM);
    await writeFile(join(workspace, "a.txt"), "a\n");
    await writeFile(join(workspace, "executable"), "the reference\n");
    await chmod(join(workspace, "executable"), 0o111);
    const snapshot = workspaceSnapshots(workspace, out);
    expect(await snapshot("start")).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(workspace, "b.txt"), "b\n");
    expect(await snapshot("seq 2")).toMatch(/^[0-9a-f]{40}$/);
    const { execFileSync } = await import("node:child_process");
    const files = execFileSync("git", [`--git-dir=${join(out, "workspace.git")}`, "ls-tree", "-r", "--name-only", "seq-2"], { encoding: "utf8" });
    expect(files.trim().split("\n")).toEqual(["a.txt", "b.txt"]);
  });
});

describe("requests", () => {
  it("gives up on any one request after the limit, so a dead connection cannot hold the runner", async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const client = new ApiClient("http://127.0.0.1:3001", withRequestLimit(hanging, 20));
    await expect(client.request("GET", `/rooms/${ROOM}/wait?after=0&timeout=25`, "sni_member")).rejects.toMatchObject({ code: "service_unavailable" });
  });
});


describe("compiled exports", () => {
  it("keeps the canonical log and final projection beside the conversation", async () => {
    const out = await temporary();
    const state = { protocol_version: "rac/1", sequence: 1, digest: "abc", projection: { work: {} }, obligations: "none", events: [{ seq: 1, hash: "abc", type: "work.request" }] };
    const client = new ApiClient("http://127.0.0.1:3001", async (url) => {
      const path = new URL(String(url)).pathname;
      return Response.json(path.endsWith("/state") ? state : path.endsWith("/messages") ? { items: [] } : { room: { type: "compiled", state: "closed" } });
    });
    await goalExport(client, "sni_test", ROOM, out);
    expect(JSON.parse(await readFile(join(out, "state.json"), "utf8"))).toEqual(state);
    expect(JSON.parse((await readFile(join(out, "acts.ndjson"), "utf8")).trim())).toEqual(state.events[0]);
  });
});
