// @vitest-environment node

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.ts";
import type { CommandRunner } from "./guest.ts";
import type { TurnRunner, TurnSpec } from "./wake-driver.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

const INVITE_TOKEN = `rit_${"I".repeat(43)}`;
const MEMBER_TOKEN = `sni_${"M".repeat(43)}`;
const ROOM_ID = "rom_AbCdEfGhIj";
const MEMBER_ID = "i_KlMnOpQrSt";

const CLAIM = `clp_${"c".repeat(43)}`;

const PASTED_INVITE = [
  `Join SharedNet Room ${ROOM_ID} ("Launch review") as a guest.`,
  `ROOM=${ROOM_ID}`,
  `TOKEN=${INVITE_TOKEN}`,
  "BASE=https://www.sharednet.ai",
  "",
  '1. Join, and read what was said so far. Keep member_token from the response and note the highest sequence in history.items:',
  `   curl -s -X POST "$BASE/api/v1/rooms/$ROOM/join" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"<your name, e.g. claude-code>"}'`,
].join("\n");

function message(sequence: number, content: string, name: string | null = "host") {
  return {
    id: `msg_${String(sequence).padStart(10, "0")}`,
    room_id: ROOM_ID,
    sequence,
    type: "message",
    content,
    sender: { member_id: "i_HostHostHo", kind: "instance", name },
    created_at: "2026-09-05T10:00:00.000Z",
  };
}

function joined(items: ReturnType<typeof message>[] = []) {
  return {
    status: 200,
    body: {
      room: { id: ROOM_ID, name: "Launch review", state: "open" },
      membership: { member_id: MEMBER_ID, kind: "guest", name: "claude-code", state: "active" },
      member_token: MEMBER_TOKEN,
      history: { items, next_cursor: items.length ? String(items.at(-1)!.sequence) : null, has_more: false },
    },
  };
}

/** The cursor of one seat in a directory's Room file, which holds one cursor per seat now. */
async function cursorOf(space: { project: string }, memberId?: string): Promise<number | undefined> {
  const room = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
  const seats: Record<string, { last_sequence: number }> = room.seats ?? {};
  const id = memberId ?? (seats[MEMBER_ID] ? MEMBER_ID : Object.keys(seats)[0]!);
  return seats[id]?.last_sequence;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-guest-"));
  cleanup.push(root);
  return {
    root,
    project: join(root, "project"),
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      CLAUDE_SESSION_ID: "claude-session-stays-local",
    } as Record<string, string>,
  };
}

async function run(
  argv: string[],
  space: Awaited<ReturnType<typeof workspace>>,
  responses: Array<{ status?: number; body?: unknown; error?: Error; raw?: Response; hang?: true; entered?: () => void; wait?: Promise<void> }>,
  environment: Record<string, string> = {},
  overrides: {
    exec?: CommandRunner;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    service?: { delivered_through: number; acked_through: number };
    runTurn?: TurnRunner;
    startWakeService?: (input: { env: Record<string, string | undefined>; logFile: string }) => number | null;
  } = {},
) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(space.project, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  // The seat's place is the service's (wait PR 5). A stand-in keeps it here, so the scripted
  // answers stay what each test is about; `acks` is what the CLI told it, in order. Pass the same
  // `service` to two runs and it carries over, as the real one does.
  const { service: kept, ...dependencyOverrides } = overrides;
  const service = kept ?? { delivered_through: 0, acked_through: 0 };
  const acks: number[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const place = /\/api\/v1\/rooms\/(rom_[A-Za-z0-9]+)\/(subscription|ack)$/.exec(new URL(String(input)).pathname);
    if (place) {
      if (place[2] === "ack") {
        const through = (JSON.parse(String(init.body)) as { through: number }).through;
        acks.push(through);
        service.acked_through = Math.max(service.acked_through, through);
        service.delivered_through = Math.max(service.delivered_through, service.acked_through);
      }
      return new Response(JSON.stringify({ subscription: { room_id: place[1], ...service } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    requests.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch");
    next.entered?.();
    await next.wait;
    if (next.error) throw next.error;
    // A server that takes the request and never answers: only the caller's own signal ends it.
    if (next.hang) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    // A byte route answers with its own Response, headers and all.
    if (next.raw) return next.raw;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.body === undefined ? undefined : { "content-type": "application/json" },
    });
  });
  const exitCode = await runCli(argv, {
    env: { ...space.env, ...environment },
    fetch,
    cwd: space.project,
    sleep: async () => undefined,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    ...dependencyOverrides,
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), requests, acks, service };
}

function own(sequence: number, content: string) {
  return { ...message(sequence, content, "claude-code"), sender: { member_id: MEMBER_ID, kind: "guest", name: "claude-code" } };
}

/** A refusal, which is how a connector loop is meant to end: the service said no, not "later". */
function revoked() {
  return { status: 401, body: { error: { code: "invalid_credentials", message: "Credentials are invalid." } } };
}

function page(items: ReturnType<typeof message>[]) {
  return { status: 200, body: { items, next_cursor: null, has_more: false } };
}

/** The Room as a member reads it: its state, and the seats in it with their names. */
function roomState(state: "open" | "closed") {
  return {
    status: 200,
    body: {
      room: { id: ROOM_ID, name: "Launch review", state },
      memberships: [{ member_id: MEMBER_ID, kind: "guest", name: "claude-code", state: "active" }],
    },
  };
}

/** A command runner that records what it was given and answers with a fixed result. */
function recorder(result: { exitCode: number; stdout: string; stderr?: string }) {
  const calls: Array<{ command: string; input: unknown; env: Record<string, string> }> = [];
  const exec: CommandRunner = async (command, input, env) => {
    calls.push({ command, input: JSON.parse(input), env });
    return { stderr: "", ...result };
  };
  return { calls, exec };
}

function header(request: { init: RequestInit }, name: string): string | undefined {
  return (request.init.headers as Record<string, string>)[name];
}

describe("sharednet join", () => {
  it("names a seat taken from Muse's runtime cell for Muse, as detected", async () => {
    const space = await workspace();
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      {
        ...space,
        env: {
          HOME: space.env.HOME!,
          XDG_CONFIG_HOME: space.env.XDG_CONFIG_HOME!,
          XDG_STATE_HOME: space.env.XDG_STATE_HOME!,
          JARVIS_HOME: "/home/hatch",
          JARVIS_BIN_DIR: "/opt/hatch/bin",
        },
      },
      [joined()],
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({
      name: "muse",
      runtime: { kind: "muse", version: null, entrypoint: null, source: "detected" },
    });
  });

  it("names a seat for the harness that sets SHAREDNET_RUNTIME, as declared, and takes --runtime with a version", async () => {
    // A coding driver runs underneath; here the workspace's Claude session plays it.
    const space = await workspace();
    const declared = await run(["join", PASTED_INVITE, "--json"], space, [joined()], { SHAREDNET_RUNTIME: "dot" });
    expect(declared.exitCode).toBe(0);
    expect(JSON.parse(String(declared.requests[0]!.init.body))).toEqual({
      name: "dot",
      runtime: { kind: "dot", version: null, entrypoint: null, source: "declared" },
    });

    const other = await workspace();
    const flagged = await run(["join", PASTED_INVITE, "--runtime", "dot@2.1", "--name", "Yu's Dot", "--json"], other, [joined()]);
    expect(flagged.exitCode).toBe(0);
    expect(JSON.parse(String(flagged.requests[0]!.init.body))).toEqual({
      name: "Yu's Dot",
      runtime: { kind: "dot", version: "2.1", entrypoint: null, source: "declared" },
    });
  });

  it("refuses a malformed declaration before anything leaves the machine, so a claim is never spent on it", async () => {
    const space = await workspace();
    // --name, so nothing else on the way to the claim needs the runtime.
    const result = await run(["join", PASTED_INVITE, "--claim", CLAIM, "--name", "Dot", "--json"], space, [], {
      SHAREDNET_RUNTIME: "Dot Agent",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid_runtime");
    expect(result.requests).toEqual([]);
  });

  it("registers an account's seat under the declared runtime, from the environment or --runtime, keeping the detected driver as evidence", async () => {
    const accountJoin = () => [
      {
        status: 201,
        body: {
          instance: {
            id: "i_DotSeat0001", principal_id: "p_AcCoUnT0001", agent_id: null, runtime_kind: "dot", cli_version: "0.1.9",
            runtime_metadata: {}, reach: "public", status: "online", display_name: null,
            started_at: "2026-10-03T00:00:00.000Z", last_seen_at: "2026-10-03T00:00:00.000Z",
            lease_expires_at: "2099-10-03T00:01:30.000Z", token_expires_at: "2099-10-04T00:00:00.000Z", ended_at: null, revoked_at: null,
          },
          token: `sni_${"D".repeat(43)}`,
          heartbeat_after_seconds: 30,
        },
      },
      {
        status: 200,
        body: {
          room: { id: ROOM_ID, name: "Launch review", state: "open" },
          membership: { member_id: "i_DotSeat0001", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" },
        },
      },
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    ];
    const key = { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` };

    const fromEnvironment = await run(["join", PASTED_INVITE, "--json"], await workspace(), accountJoin(), { ...key, SHAREDNET_RUNTIME: "dot" });
    expect(fromEnvironment.exitCode).toBe(0);
    const registration = JSON.parse(String(fromEnvironment.requests[0]!.init.body));
    expect(registration.runtime_kind).toBe("dot");
    expect(registration.runtime_metadata).toMatchObject({ runtime_source: "declared", detected_driver: "claude-code" });
    expect(String(fromEnvironment.requests[0]!.init.body)).not.toContain("claude-session-stays-local");
    expect(JSON.parse(String(fromEnvironment.requests[1]!.init.body))).toEqual({ invite: INVITE_TOKEN });

    const fromFlag = await run(["join", PASTED_INVITE, "--runtime", "dot@2.1", "--json"], await workspace(), accountJoin(), key);
    expect(fromFlag.exitCode).toBe(0);
    expect(JSON.parse(String(fromFlag.requests[0]!.init.body))).toMatchObject({
      runtime_kind: "dot",
      runtime_metadata: { runtime_source: "declared", driver_version: "2.1", detected_driver: "claude-code" },
    });
  });

  it("joins from the pasted Web invite, keeps the tokens out of the project and out of stdout", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE], space, [
      joined([message(1, "Welcome"), message(2, "Agenda is in the doc")]),
    ]);
    // The seat is anonymous; the join says so once, and how to make it yours.
    expect(result.stderr).toContain("sharednet login");
    expect(result.stderr).not.toContain("sni_");

    expect(result.stderr).not.toMatch(/sni_|rit_|snk_/);
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    const [request] = result.requests;
    // The invite's BASE says where the Room lives; the invite token is the credential.
    expect(request!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/join`);
    expect(request!.init.method).toBe("POST");
    expect(header(request!, "authorization")).toBe(`Bearer ${INVITE_TOKEN}`);
    // The driver that is running names the seat and is reported as detected; its session id stays local.
    expect(JSON.parse(String(request!.init.body))).toEqual({
      name: "claude-code",
      runtime: { kind: "claude-code", version: null, entrypoint: null, source: "detected" },
    });
    expect(String(request!.init.body)).not.toContain("claude-session-stays-local");

    const output = JSON.parse(result.stdout);
    expect(output).toEqual({
      room: { id: ROOM_ID, name: "Launch review", state: "open" },
      member_id: MEMBER_ID,
      principal_id: null,
      as: "anonymous",
      name: "claude-code",
      last_sequence: 2,
      history: expect.objectContaining({ items: expect.any(Array) }),
      // The session that took the seat is what being addressed resumes; nothing runs to do it here.
      wake: { driver: "claude-code", session: "claude-session-stays-local", address: "@claude-code", service: "not_started" },
    });
    expect(result.stdout).not.toContain("sni_");
    expect(result.stdout).not.toContain("rit_");

    // The member token lives owner-only under the config directory…
    const credentialFile = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.json`);
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialFile, "utf8"))).toMatchObject({
      room_id: ROOM_ID,
      member_id: MEMBER_ID,
      member_token: MEMBER_TOKEN,
    });
    // …and the project holds only the cursor, in a directory that ignores itself.
    const state = await readFile(join(space.project, ".sharednet", "room.json"), "utf8");
    expect(JSON.parse(state)).toEqual({
      schema_version: 2,
      base_url: "https://www.sharednet.ai",
      room_id: ROOM_ID,
      // The seat is tied to this session by a key derived from its id, never the id itself.
      seats: { [MEMBER_ID]: { last_sequence: 2, anchor_key: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/), joined_at: expect.any(String) } },
    });
    expect(state).not.toContain("sni_");
    expect(state).not.toContain("claude-session-stays-local");
    expect(await readFile(join(space.project, ".sharednet", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("joins a bare Room id with the token from the environment, and takes --name", async () => {
    const space = await workspace();
    const result = await run(
      ["join", ROOM_ID, "--name", "reviewer", "--json"],
      space,
      [joined()],
      { SHAREDNET_INVITE_TOKEN: INVITE_TOKEN, SHAREDNET_BASE_URL: "http://127.0.0.1:3001" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.requests[0]!.url).toBe(`http://127.0.0.1:3001/api/v1/rooms/${ROOM_ID}/join`);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({
      name: "reviewer",
      runtime: { kind: "claude-code", version: null, entrypoint: null, source: "detected" },
    });
    expect(JSON.parse(result.stdout).last_sequence).toBe(0);
  });

  it("reports no driver when none is recognised, and names the seat 'agent'", async () => {
    const space = await workspace();
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      { ...space, env: { HOME: space.env.HOME!, XDG_CONFIG_HOME: space.env.XDG_CONFIG_HOME!, XDG_STATE_HOME: space.env.XDG_STATE_HOME! } },
      [joined()],
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(String(result.requests[0]!.init.body));
    expect(body).toEqual({ name: "agent" });
  });

  it("redeems a claim from the join page first, then joins as that account, with the key kept on disk", async () => {
    const space = await workspace();
    const CLAIM = `clp_${"c".repeat(43)}`;
    const KEY = `snk_${"Q".repeat(43)}`;
    const instance = {
      id: "i_ClaimedSeat",
      principal_id: "p_ClAiMeD001",
      agent_id: null,
      runtime_kind: "codex",
      cli_version: "0.1.3",
      status: "online",
      display_name: null,
      started_at: "2026-09-07T00:00:00.000Z",
      last_seen_at: "2026-09-07T00:00:00.000Z",
      lease_expires_at: "2099-09-07T00:01:30.000Z",
      token_expires_at: null,
      ended_at: null,
      revoked_at: null,
    };
    const result = await run(["join", PASTED_INVITE, "--claim", CLAIM, "--json"], space, [
      {
        status: 200,
        body: { state: "approved", login: { id: "cli_AbCdEfGhIj", bind_instance_ids: [] }, api_key: KEY, api_key_id: "key_AbCdEfGhIj", principal: { id: "p_ClAiMeD001", display_name: "Xisen" } },
      },
      { status: 201, body: { instance, token: `sni_${"C".repeat(43)}`, heartbeat_after_seconds: 30 } },
      {
        status: 200,
        body: {
          room: { id: ROOM_ID, name: "Launch review", state: "open" },
          membership: { member_id: "i_ClaimedSeat", principal_id: "p_ClAiMeD001", kind: "instance", admitted_by: "invite", name: null, state: "active" },
        },
      },
      { status: 200, body: { items: [message(1, "Welcome")], next_cursor: "1", has_more: false } },
    ]);
    expect(result.exitCode).toBe(0);
    // The claim goes first, as the bearer, and nothing else; then the account door as usual.
    expect(result.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/cli/claims/redeem");
    expect(header(result.requests[0]!, "authorization")).toBe(`Bearer ${CLAIM}`);
    expect(result.requests[1]!.url).toBe("https://www.sharednet.ai/api/v1/instances");
    expect(header(result.requests[1]!, "authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(result.stdout)).toMatchObject({ as: "account", principal_id: "p_ClAiMeD001", member_id: "i_ClaimedSeat" });
    expect(result.stderr).toContain("Claimed");
    expect(result.stdout + result.stderr).not.toContain(KEY);
    const credentialsFile = join(space.env.XDG_CONFIG_HOME!, "sharednet", "credentials.json");
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsFile, "utf8"))).toMatchObject({ api_key: KEY, principal_id: "p_ClAiMeD001" });

    const malformed = await run(["join", PASTED_INVITE, "--claim", "nope", "--json"], space, []);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.requests).toHaveLength(0);
  });

  it("joins as the account when a credential is present: registers an Instance, joins with the invite, reads history", async () => {
    const space = await workspace();
    const instance = {
      id: "i_AccountSeat1",
      principal_id: "p_AcCoUnT0001",
      agent_id: null,
      runtime_kind: "claude-code",
      cli_version: "0.1.3",
      status: "online",
      display_name: null,
      started_at: "2026-09-06T00:00:00.000Z",
      last_seen_at: "2026-09-06T00:00:00.000Z",
      lease_expires_at: "2099-09-06T00:01:30.000Z",
      token_expires_at: "2099-09-07T00:00:00.000Z",
      ended_at: null,
      revoked_at: null,
    };
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      space,
      [
        { status: 201, body: { instance, token: `sni_${"A".repeat(43)}`, heartbeat_after_seconds: 30 } },
        {
          status: 200,
          body: {
            room: { id: ROOM_ID, name: "Launch review", state: "open" },
            membership: { member_id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" },
          },
        },
        { status: 200, body: { items: [message(1, "Welcome")], next_cursor: "1", has_more: false } },
      ],
      { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` },
    );

    // The only thing on stderr is the seat this session got, never a token.
    expect(result.stderr).toContain("Seat i_AccountSeat1 in rom_AbCdEfGhIj");
    expect(result.stderr).not.toMatch(/sni_|rit_|snk_|clp_/);
    expect(result.exitCode).toBe(0);
    expect(result.requests.map((request) => `${request.init.method ?? "GET"} ${request.url}`)).toEqual([
      "POST https://www.sharednet.ai/api/v1/instances",
      `POST https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/join`,
      `GET https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages?after=0&limit=100`,
    ]);
    expect(header(result.requests[0]!, "authorization")).toBe(`Bearer snk_${"K".repeat(43)}`);
    expect(header(result.requests[1]!, "authorization")).toBe(`Bearer sni_${"A".repeat(43)}`);
    // The invite admits the Instance; the runtime went with the registration, not the join.
    expect(JSON.parse(String(result.requests[1]!.init.body))).toEqual({ invite: INVITE_TOKEN });
    expect(JSON.parse(String(result.requests[0]!.init.body)).runtime_kind).toBe("claude-code");
    expect(header(result.requests[1]!, "idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ as: "account", member_id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", last_sequence: 1 });
    expect(result.stdout).not.toContain("sni_");
    expect(result.stdout).not.toContain("snk_");
    const state = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(state).toMatchObject({ room_id: ROOM_ID, seats: { i_AccountSeat1: { last_sequence: 1 } } });
    // Both the seat file and the session file exist; say/wait use the session's token.
    await stat(join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, "i_AccountSeat1.json"));
    await stat(join(space.env.XDG_STATE_HOME!, "sharednet", "sessions", "i_AccountSeat1.json"));

    const said = await run(["say", "as the account", "--json"], space, [
      { status: 201, body: { message: message(2, "as the account", null) } },
    ], { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` });
    expect(said.exitCode).toBe(0);
    expect(header(said.requests[0]!, "authorization")).toBe(`Bearer sni_${"A".repeat(43)}`);
  });

  it("refuses to join without an invite token, before any request is sent", async () => {
    const space = await workspace();
    const result = await run(["join", ROOM_ID, "--json"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("invite_token_required");
  });

  it("keeps two seats in one Room apart when two Agents share one machine", async () => {
    // Found by the two-Agent demo: Codex and Claude Code on one machine joined
    // the same Room, and the second join used to overwrite the first's file.
    const space = await workspace();
    const first = await run(["join", PASTED_INVITE, "--name", "claude-code"], space, [joined()]);
    expect(first.exitCode).toBe(0);
    const secondProject = join(space.root, "second-project");
    const secondSeat = { ...joined(), body: { ...joined().body, membership: { ...joined().body.membership, member_id: "i_SecondSeat1", name: "codex" }, member_token: `sni_${"S".repeat(43)}` } };
    const second = await run(["join", PASTED_INVITE, "--name", "codex"], { ...space, project: secondProject }, [secondSeat]);
    expect(second.exitCode).toBe(0);

    // Each project still speaks with its own token.
    const firstSay = await run(["say", "from the first seat", "--json"], space, [
      { status: 201, body: { message: message(2, "from the first seat", "claude-code") } },
    ]);
    expect(firstSay.exitCode).toBe(0);
    expect(header(firstSay.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    const secondSay = await run(["say", "from the second seat", "--json"], { ...space, project: secondProject }, [
      { status: 201, body: { message: message(3, "from the second seat", "codex") } },
    ]);
    expect(secondSay.exitCode).toBe(0);
    expect(header(secondSay.requests[0]!, "authorization")).toBe(`Bearer sni_${"S".repeat(43)}`);
  });

  it("does not treat a stored API key or --session as a way in", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE, "--session", "i_HostHostHo"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(result.stderr).toContain("invalid_option");
  });
});

describe("sharednet say and wait", () => {
  async function joinedSpace() {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])]);
    expect(result.exitCode).toBe(0);
    return space;
  }

  /** The connector's own cursor for one seat, as a previous run would have left it. */
  async function seatCursor(space: Awaited<ReturnType<typeof workspace>>, roomId: string, memberId: string, cursor: number) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", roomId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${memberId}.serve-cursor`), `${cursor}\n`, { mode: 0o600 });
  }

  /** A second seat on disk, as a join into another Room would have left it. */
  async function seatIn(space: Awaited<ReturnType<typeof workspace>>, roomId: string, memberId: string) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", roomId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, `${memberId}.json`),
      JSON.stringify({
        schema_version: 1,
        base_url: "https://www.sharednet.ai",
        room_id: roomId,
        member_id: memberId,
        name: "claude-code",
        member_token: MEMBER_TOKEN,
        joined_at: "2026-09-06T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
  }

  it("says with the stored member token and never moves the cursor", async () => {
    const space = await joinedSpace();
    const result = await run(["say", "Build is green.", "--json"], space, [
      { status: 201, body: { message: { ...message(2, "Build is green.", "claude-code"), sender: { member_id: MEMBER_ID, kind: "guest", name: "claude-code" } } } },
    ]);

    expect(result.stderr).not.toMatch(/sni_|rit_|snk_/);
    expect(result.exitCode).toBe(0);
    const [request] = result.requests;
    expect(request!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
    expect(header(request!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(String(request!.init.body))).toEqual({ content: "Build is green." });
    expect(JSON.parse(result.stdout).message.sequence).toBe(2);
    // A message of one's own is not "seen": anything said before it still arrives.
    expect(await cursorOf(space)).toBe(1);
  });

  it("returns unseen mentions instead of posting, then permits an explicit retry without moving the wait cursor", async () => {
    const space = await joinedSpace();
    const addressed = { ...message(4, "@claude-code Please use the new interface."), mentions: [MEMBER_ID] };
    const refused = await run(["say", "old plan", "--json"], space, [
      { body: { items: [addressed], has_more: false, next_cursor: null } },
    ], { SHAREDNET_MENTION_GATE: "1", SHAREDNET_TURN_THROUGH: "1" });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("unread_mentions");
    expect(refused.stderr).toContain("Please use the new interface");
    expect(refused.requests.every(r => r.init.method === "GET")).toBe(true);
    const retried = await run(["say", "revised plan", "--json"], space, [
      { body: { items: [], has_more: false, next_cursor: null } },
      { status: 201, body: { message: message(5, "revised plan") } },
    ], { SHAREDNET_MENTION_GATE: "1", SHAREDNET_TURN_THROUGH: "1" });
    expect(retried.exitCode).toBe(0);
    expect(retried.requests[0]!.url).toContain("after=4");
    expect(await cursorOf(space)).toBe(1);
  });

  it("accounts for an explicit read and the runner watermark before checking say", async () => {
    const space = await joinedSpace();
    const env = { SHAREDNET_MENTION_GATE: "1", SHAREDNET_TURN_THROUGH: "9" };
    expect((await run(["read", "--last", "2", "--json"], space, [
      { body: { items: [message(5, "@claude-code earlier")], has_more: false, next_cursor: null } },
    ], env)).exitCode).toBe(0);
    const result = await run(["say", "answer", "--json"], space, [
      { body: { items: [], has_more: false, next_cursor: null } },
      { status: 201, body: { message: message(10, "answer") } },
    ], env);
    expect(result.exitCode).toBe(0);
    expect(result.requests[0]!.url).toContain("after=9");
    expect(await cursorOf(space)).toBe(1);
  });

  it("does not consume a mention when its audit cannot be written", async () => {
    const space = await joinedSpace();
    const { controlPaths, readThrough } = await import("./board-controls.ts");
    const { mkdir, rm } = await import("node:fs/promises");
    const paths = controlPaths(space.env, { base_url: "https://www.sharednet.ai", room_id: ROOM_ID, member_id: MEMBER_ID });
    await mkdir(paths.events, { recursive: true });
    const addressed = message(2, "@claude-code changed interface");
    const env = { SHAREDNET_MENTION_GATE: "1" };
    const failed = await run(["say", "old interface", "--json"], space, [page([addressed])], env);
    expect(failed.exitCode).not.toBe(0);
    expect(await readThrough(paths)).toBe(0);
    expect(failed.requests.every(r => r.init.method === "GET")).toBe(true);
    await rm(paths.events, { recursive: true });
    const retried = await run(["say", "old interface", "--json"], space, [page([addressed])], env);
    expect(retried.stderr).toContain("changed interface");
    expect(retried.stderr).toContain("unread_mentions");
    expect(retried.requests.every(r => r.init.method === "GET")).toBe(true);
  });

  it("serializes task snapshots so a delayed list cannot restore a completed task", async () => {
    const space = await joinedSpace();
    const { controlPaths, taskMessage } = await import("./board-controls.ts");
    const paths = controlPaths(space.env, { base_url: "https://www.sharednet.ai", room_id: ROOM_ID, member_id: MEMBER_ID });
    const claim = own(2, taskMessage("claim", "Build")), done = own(3, taskMessage("done", "Build"));
    await run(["task", "list", "--json"], space, [page([claim])]);
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const old = run(["task", "list", "--json"], space, [{ ...page([claim]), wait, entered }]);
    await started;
    let completionRequested = false;
    const finishing = run(["task", "done", "Build", "--json"], space, [
      { ...page([claim]), entered: () => { completionRequested = true; } },
      { body: { message: done } }, page([claim, done]),
    ]);
    // A task operation must acquire the local lock before taking its snapshot.
    await new Promise(resolve => setTimeout(resolve, 40));
    const overlapped = completionRequested;
    release();
    const results = await Promise.all([old, finishing]);
    expect(results.map(r => r.exitCode)).toEqual([0, 0]);
    expect(overlapped).toBe(false);
    expect(await readFile(paths.tasks, "utf8")).toBe("");
  });

  it("revokes a finishing task even when the committed completion cannot be replayed", async () => {
    const space = await joinedSpace();
    const { controlPaths, taskMessage } = await import("./board-controls.ts");
    const paths = controlPaths(space.env, { base_url: "https://www.sharednet.ai", room_id: ROOM_ID, member_id: MEMBER_ID });
    const claim = own(2, taskMessage("claim", "Build")), done = own(3, taskMessage("done", "Build"));
    await run(["task", "list", "--json"], space, [page([claim])]);
    const result = await run(["task", "done", "Build", "--json"], space, [
      page([claim]), { body: { message: done } }, { error: Error("replay unavailable") },
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(paths.tasks, "utf8")).toBe("");
  });

  it("shows teammates' unseen tasks instead of claiming, then claims on the repeated command", async () => {
    const space = await joinedSpace();
    const { taskMessage } = await import("./board-controls.ts");
    const theirs = { ...message(2, taskMessage("claim", "CLI behavior survey")), sender: { member_id: "i_Other00001", kind: "guest", name: "codex-3" } };
    const reviewed = await run(["task", "claim", "CLI reconnaissance", "--json"], space, [page([theirs])]);
    expect(reviewed.exitCode).toBe(2);
    expect(reviewed.stderr).toContain("review_tasks");
    expect(reviewed.stderr).toContain("CLI behavior survey");
    expect(reviewed.requests.every(r => r.init.method === "GET")).toBe(true);
    const mine = own(3, taskMessage("claim", "Parser"));
    const claimed = await run(["task", "claim", "Parser", "--json"], space, [page([theirs]), page([theirs]), { body: { message: mine } }, page([theirs, mine])]);
    expect(claimed.exitCode).toBe(0);
    expect(JSON.parse(claimed.stdout).task).toMatchObject({ title: "Parser", owner: MEMBER_ID });
  });

  it("claims at once when nothing new exists, and reports a claim that crossed it", async () => {
    const space = await joinedSpace();
    const { taskMessage } = await import("./board-controls.ts");
    const theirs = { ...message(2, taskMessage("claim", "CLI behavior survey")), sender: { member_id: "i_Other00001", kind: "guest", name: "codex-3" } };
    const mine = own(3, taskMessage("claim", "CLI reconnaissance"));
    const result = await run(["task", "claim", "CLI reconnaissance", "--json"], space, [page([]), page([]), { body: { message: mine } }, page([theirs, mine])]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).crossed).toEqual([{ title: "CLI behavior survey", owner: "codex-3", status: "claimed" }]);
    // Having claimed, it has seen that board; the next claim asks for no new review.
    const next = own(4, taskMessage("claim", "Renderer"));
    const again = await run(["task", "claim", "Renderer", "--json"], space, [page([theirs, mine]), page([theirs, mine]), { body: { message: next } }, page([theirs, mine, next])]);
    expect(again.exitCode).toBe(0);
  });

  it("blocks task claim on an unread mention before publishing its marker", async () => {
    const space = await joinedSpace();
    const result = await run(["task", "claim", "parser", "--json"], space, [
      { body: { items: [message(3, "@claude-code Stop using old parser")], has_more: false, next_cursor: null } },
    ], { SHAREDNET_MENTION_GATE: "1" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unread_mentions");
    expect(result.requests.every(r => r.init.method === "GET")).toBe(true);
  });

  it("replays task history across pages and allows only the owner to finish", async () => {
    const space = await joinedSpace();
    const claim = { ...message(2, '[sharednet-task:v1] {"op":"claim","title":"Parser"}'), sender: { member_id: MEMBER_ID, kind: "guest", name: "claude-code" } };
    const listed = await run(["task", "list", "--json"], space, [
      { body: { items: [message(1, "goal")], has_more: true, next_cursor: "1" } },
      { body: { items: [claim], has_more: false, next_cursor: null } },
    ]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).tasks[0]).toMatchObject({ title: "Parser", owner: MEMBER_ID, status: "claimed" });
    expect(listed.requests[1]!.url).toContain("after=1");
    const denied = await run(["task", "done", "other", "--json"], space, [
      { body: { items: [message(2, '[sharednet-task:v1] {"op":"claim","title":"other"}')], has_more: false, next_cursor: null } },
    ]);
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain("task_not_owned");
    expect(denied.requests.every(r => r.init.method === "GET")).toBe(true);
  });

  it("refuses malformed task history instead of granting ownership", async () => {
    for (const body of [
      { items: [own(2, '[sharednet-task:v1] {"op":"claim","title":"Build"}')] },
      { items: [message(2, "later"), message(1, "earlier")], has_more: false },
      { items: [], has_more: true },
    ]) {
      const space = await joinedSpace();
      const result = await run(["task", "list", "--json"], space, [{ body }]);
      expect(result.stderr).toContain("task_state_incomplete");
    }
  });

  it("threads a reply with --reply-to and refuses anything that is not a message id", async () => {
    const space = await joinedSpace();
    const result = await run(["say", "Yes, on it.", "--reply-to", "msg_AbCdEfGhIj", "--json"], space, [
      { status: 201, body: { message: { ...message(2, "Yes, on it.", "claude-code"), reply_to_message_id: "msg_AbCdEfGhIj" } } },
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({
      content: "Yes, on it.",
      reply_to_message_id: "msg_AbCdEfGhIj",
    });

    const refused = await run(["say", "Yes, on it.", "--reply-to", "2", "--json"], space, []);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.requests).toHaveLength(0);
    expect(refused.stderr).toContain("--reply-to must be a message id");
  });

  it("joins as a private seat when asked, so strangers with the id must ask first", async () => {
    const space = await workspace();
    const result = await run(["join", PASTED_INVITE, "--private", "--json"], space, [joined([message(1, "Welcome")])]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toMatchObject({ reach: "private" });
  });

  it("seats more Instances by id from the current seat, and lists the Rooms it sits in", async () => {
    const space = await joinedSpace();
    const added = await run(["add", "i_AbCdEfGhIj", "i_KlMnOpQrSt", "--json"], space, [
      { status: 200, body: { admissions: [{ instance_id: "i_AbCdEfGhIj", status: "member", decision_id: null }, { instance_id: "i_KlMnOpQrSt", status: "pending", decision_id: "dec_AbCdEfGhIj" }] } },
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/members`);
    expect(header(added.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(String(added.requests[0]!.init.body))).toEqual({ with: ["i_AbCdEfGhIj", "i_KlMnOpQrSt"] });
    expect(JSON.parse(added.stdout).admissions[1].status).toBe("pending");

    const malformed = await run(["add", "not-an-id", "--json"], space, []);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.requests).toHaveLength(0);

    const listed = await run(["rooms", "--json"], space, [{ status: 200, body: { items: [{ id: ROOM_ID }] } }]);
    expect(listed.exitCode).toBe(0);
    expect(listed.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/rooms");
    expect(listed.requests[0]!.init.method ?? "GET").toBe("GET");
  });

  it("shows the requests waiting on the seat and answers one for itself", async () => {
    const space = await joinedSpace();
    const pending = await run(["requests", "--json"], space, [
      { status: 200, body: { decisions: [{ id: "dec_AbCdEfGhIj", status: "pending", room_id: "rom_KlMnOpQrSt" }] } },
    ]);
    expect(pending.exitCode).toBe(0);
    expect(pending.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/decisions?status=pending");

    const accepted = await run(["accept", "dec_AbCdEfGhIj", "--json"], space, [
      { status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "approved" }, membership: { room_id: "rom_KlMnOpQrSt", admitted_by: "accepted" } } },
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(accepted.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/decisions/dec_AbCdEfGhIj/resolve");
    expect(JSON.parse(String(accepted.requests[0]!.init.body))).toEqual({ resolution: "approved" });

    const denied = await run(["deny", "dec_AbCdEfGhIj", "--json"], space, [
      { status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "denied" }, membership: null } },
    ]);
    expect(JSON.parse(String(denied.requests[0]!.init.body))).toEqual({ resolution: "denied" });

    const refused = await run(["accept", "2", "--json"], space, []);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.requests).toHaveLength(0);
  });

  it("enters another Room by id as the seat this machine holds, and needs --as when it holds several", async () => {
    const space = await joinedSpace();
    const OTHER_ROOM = "rom_OtHeRrOoM1";
    const elsewhere = { ...space, project: join(space.root, "elsewhere") };
    const entered = await run(["join", OTHER_ROOM, "--json"], elsewhere, [
      { status: 200, body: { room: { id: OTHER_ROOM, name: "Reach test", state: "open" }, membership: { member_id: MEMBER_ID, admitted_by: "added", state: "active" } } },
      page([{ ...message(1, "welcome to the other room"), room_id: OTHER_ROOM }, { ...message(2, "second"), room_id: OTHER_ROOM }]),
    ]);
    // The one thing said: how this seat is woken, now that it is in the other Room too.
    expect(entered.stderr).toMatch(/^Wake: when someone writes @i_KlMnOpQrSt in this Room, this Claude Code session is resumed[^\n]*\n$/);
    expect(entered.exitCode).toBe(0);
    // No invite: the seat's own token joins by Room id, idempotently.
    expect(entered.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${OTHER_ROOM}/join`);
    expect(header(entered.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(header(entered.requests[0]!, "idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(entered.requests[1]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${OTHER_ROOM}/messages?after=0&limit=100`);
    const output = JSON.parse(entered.stdout);
    expect(output).toMatchObject({ member_id: MEMBER_ID, as: "seat", admitted_by: "added", last_sequence: 2 });
    const state = JSON.parse(await readFile(join(elsewhere.project, ".sharednet", "room.json"), "utf8"));
    expect(state).toMatchObject({ room_id: OTHER_ROOM, seats: { [MEMBER_ID]: { last_sequence: 2 } } });
    // The seat now has a credential for the new Room too, and say works from there.
    const said = await run(["say", "hello from the other room", "--json"], elsewhere, [
      { status: 201, body: { message: message(3, "hello from the other room") } },
    ]);
    expect(said.exitCode).toBe(0);
    expect(said.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${OTHER_ROOM}/messages`);

    // A second seat on the machine makes the choice explicit.
    const secondProject = join(space.root, "second");
    await run(["join", `ROOM=rom_SeCoNdRoOm TOKEN=${INVITE_TOKEN}`, "--name", "other-seat", "--json"], { ...space, project: secondProject }, [
      { status: 200, body: { room: { id: "rom_SeCoNdRoOm", name: "Second" }, membership: { member_id: "i_SeCoNdSeAt", kind: "guest", name: "other-seat" }, member_token: `sni_${"z".repeat(43)}`, history: { items: [], next_cursor: null, has_more: false } } },
    ]);
    const ambiguous = await run(["join", OTHER_ROOM, "--json"], { ...space, project: join(space.root, "third") }, []);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(ambiguous.requests).toHaveLength(0);
    expect(ambiguous.stderr).toContain("--as");
    const unknown = await run(["join", OTHER_ROOM, "--as", "i_NoSuchSeat", "--json"], { ...space, project: join(space.root, "third") }, []);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.requests).toHaveLength(0);
  });

  it("flips the seat's reach after joining", async () => {
    const space = await joinedSpace();
    const flipped = await run(["reach", "private", "--json"], space, [
      { status: 200, body: { instance: { id: MEMBER_ID, reach: "private" } } },
    ]);
    expect(flipped.exitCode).toBe(0);
    expect(flipped.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/instances/current");
    expect(flipped.requests[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(flipped.requests[0]!.init.body))).toEqual({ reach: "private" });
    const bad = await run(["reach", "secret", "--json"], space, []);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.requests).toHaveLength(0);
  });

  it("waits for at least --min messages across pages before returning", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--min", "2", "--json"], space, [
      page([message(2, "one")]),
      page([]),
      page([message(3, "two")]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.map((item: any) => item.sequence)).toEqual([2, 3]);
    expect(result.requests.map((request) => new URL(request.url).searchParams.get("after"))).toEqual(["1", "2", "2"]);
    expect(await cursorOf(space)).toBe(3);
  });

  describe("sharednet watch", () => {
    it("wakes the command on a message, hands it the batch, says the answer back, and never wakes on its own words", async () => {
      const space = await joinedSpace();
      const { calls, exec } = recorder({ exitCode: 0, stdout: "On it.\n" });
      const result = await run(
        ["watch", "--on", "message", "--run", "agent-turn", "--reply", "--max-runs", "1", "--json"],
        space,
        [
          page([own(2, "what I said earlier")]),
          page([]),
          page([message(3, "please review the PR"), own(4, "typing…")]),
          { status: 201, body: { message: { ...own(5, "On it."), id: "msg_reply00001" } } },
        ],
        {},
        { exec },
      );
      expect(result.stderr).not.toContain("snk_");
      expect(result.exitCode).toBe(0);
      // The seat's own message at #2 did not wake it; #3 from the host did, with #4 (own) filtered out.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe("agent-turn");
      expect(calls[0]!.input).toMatchObject({ room_id: ROOM_ID, member_id: MEMBER_ID, trigger: "message" });
      expect((calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([3]);
      expect(calls[0]!.env).toMatchObject({ SHAREDNET_ROOM_ID: ROOM_ID, SHAREDNET_MEMBER_ID: MEMBER_ID, SHAREDNET_MESSAGE_COUNT: "1", SHAREDNET_LAST_SEQUENCE: "4" });
      const reply = result.requests.at(-1)!;
      expect(reply.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
      expect(JSON.parse(String(reply.init.body))).toEqual({ content: "On it." });
      const summary = JSON.parse(result.stdout);
      expect(summary.runs).toEqual([
        {
          run: 1,
          trigger: "message",
          fired: ["message"],
          wake_id: expect.stringMatching(/^wk_[A-Za-z0-9_-]{16}$/),
          messages: 1,
          status: "ok",
          exit_code: 0,
          reply_message_id: "msg_reply00001",
          last_sequence: 4,
        },
      ]);
      expect(await cursorOf(space)).toBe(4);
    });

    it("waits for --on count N before waking; a failed command consumes nothing, and the watch says so when it stops", async () => {
      const space = await joinedSpace();
      const { calls, exec } = recorder({ exitCode: 3, stdout: "half an answer", stderr: "boom" });
      const result = await run(
        ["watch", "--on", "count", "2", "--run", "agent-turn", "--reply", "--max-runs", "1", "--json"],
        space,
        [
          page([message(2, "first")]),
          page([message(3, "second")]),
        ],
        {},
        { exec },
      );
      expect(calls).toHaveLength(1);
      expect((calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      // Two polls, and no reply posted; a seat that carries its Instance id asks nobody who it is.
      expect(result.requests).toHaveLength(2);
      expect(result.requests.some((request) => request.init.method === "POST")).toBe(false);
      expect(result.stderr).toContain("boom");
      // The batch was not handled: the cursor stays before it, and the exit says so.
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stderr.split("\n").filter((line) => line.startsWith("{")).at(-1)!).error).toMatchObject({ code: "watch_failed" });
      expect(await cursorOf(space)).toBe(1);
    });

    it("offers a failed batch again on the next wake, together with what arrived since, and moves the cursor only once it is handled", async () => {
      const space = await joinedSpace();
      let attempt = 0;
      const calls: unknown[] = [];
      const exec = async (_command: string, input: string) => {
        calls.push(JSON.parse(input));
        attempt += 1;
        return attempt === 1 ? { exitCode: 7, stdout: "", stderr: "crashed" } : { exitCode: 0, stdout: "Handled both.\n", stderr: "" };
      };
      const result = await run(
        ["watch", "--on", "message", "--run", "agent-turn", "--reply", "--max-runs", "2", "--json"],
        space,
        [
          page([message(2, "first")]),
          page([message(3, "second")]),
          { status: 201, body: { message: { ...own(4, "Handled both."), id: "msg_reply00002" } } },
        ],
        {},
        { exec },
      );
      expect(result.exitCode).toBe(0);
      expect((calls[0] as any).messages.map((item: any) => item.sequence)).toEqual([2]);
      // The second wake carries the unhandled message and the new one.
      expect((calls[1] as any).messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      const runs = JSON.parse(result.stdout).runs;
      expect(runs.map((r: any) => [r.status, r.messages, r.last_sequence])).toEqual([["failed", 1, 1], ["ok", 2, 3]]);
      expect(await cursorOf(space)).toBe(3);
    });

    it("keeps a reply the Room did not take and posts it again with the same idempotency key, without rerunning the command", async () => {
      const space = await joinedSpace();
      const { calls, exec } = recorder({ exitCode: 0, stdout: "Got it.\n" });
      const result = await run(
        ["watch", "--on", "message", "--run", "agent-turn", "--reply", "--max-runs", "2", "--json"],
        space,
        [
          page([message(2, "first")]),
          { status: 503, body: { error: { code: "service_unavailable", message: "x" } } },
          page([]),
          { status: 201, body: { message: { ...own(3, "Got it."), id: "msg_reply00003" } } },
        ],
        {},
        { exec },
      );
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      const posts = result.requests.filter((request) => request.init.method === "POST");
      expect(posts).toHaveLength(2);
      expect(header(posts[0]!, "idempotency-key")).toBe(header(posts[1]!, "idempotency-key"));
      const runs = JSON.parse(result.stdout).runs;
      expect(runs.map((r: any) => [r.status, r.reply_message_id, r.last_sequence])).toEqual([["reply_failed", null, 1], ["ok", "msg_reply00003", 2]]);
      expect(await cursorOf(space)).toBe(2);
    });

    it("wakes every interval even when the Room is quiet, and after idle once it has gone quiet", async () => {
      const space = await joinedSpace();
      let clock = Date.parse("2026-09-06T12:00:00Z");
      const now = () => new Date(clock);
      const ticking = recorder({ exitCode: 0, stdout: "" });
      const every = await run(
        ["watch", "--on", "every 10m", "--run", "tick", "--max-runs", "1", "--json"],
        space,
        [
          { status: 200, body: { items: [], next_cursor: null, has_more: false } },
          { status: 200, body: { items: [], next_cursor: null, has_more: false } },
        ],
        {},
        { exec: async (...call) => { clock += 5 * 60_000; return ticking.exec(...call); }, now: () => { clock += 5 * 60_000; return new Date(clock); } },
      );
      expect(every.exitCode).toBe(0);
      expect(ticking.calls).toHaveLength(1);
      expect((ticking.calls[0]!.input as any).messages).toEqual([]);

      clock = Date.parse("2026-09-06T13:00:00Z");
      const idle = recorder({ exitCode: 0, stdout: "" });
      let polls = 0;
      const quiet = await run(
        ["watch", "--on", "idle 30s", "--run", "digest", "--max-runs", "1", "--json"],
        space,
        [
          page([message(2, "a")]),
          page([message(3, "b")]),
          page([]),
        ],
        {},
        {
          exec: idle.exec,
          now: () => {
            // Time passes only once the Room has gone quiet: the third poll comes back empty after 30 s.
            polls += 1;
            if (polls > 6) clock += 31_000;
            return new Date(clock);
          },
        },
      );
      expect(quiet.exitCode).toBe(0);
      expect(idle.calls).toHaveLength(1);
      expect((idle.calls[0]!.input as any).messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      expect(JSON.parse(quiet.stdout).runs[0]).toMatchObject({ trigger: "idle 30s", messages: 2 });
      void now;
    });

    it("refuses a trigger it does not know, before touching the network", async () => {
      const space = await joinedSpace();
      const result = await run(["watch", "--on", "sometimes", "--run", "x", "--json"], space, []);
      expect(result.exitCode).not.toBe(0);
      expect(result.requests).toHaveLength(0);
      const noCommand = await run(["watch", "--on", "message", "--json"], space, []);
      expect(noCommand.exitCode).not.toBe(0);
    });
  });

  describe("sharednet wait --on", () => {
    it("wakes on any of several triggers, hands over everything since the last wake, and says which fired", async () => {
      const space = await joinedSpace();
      const result = await run(
        ["wait", "--on", "mention", "--on", "said: deploy", "--json"],
        space,
        [roomState("open"), page([message(2, "just a status line")]), page([message(3, "@claude-code can you take W3?")])],
      );
      expect(result.exitCode).toBe(0);
      // The seat's own name came from the Room, once, before the first poll.
      expect(result.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}`);
      const wake = JSON.parse(result.stdout);
      expect(wake).toMatchObject({ room_id: ROOM_ID, member_id: MEMBER_ID, trigger: "mention", fired: ["mention"], from: 1, through: 3 });
      expect(wake.wake_id).toMatch(/^wk_[A-Za-z0-9_-]{16}$/);
      // #2 woke nothing on its own, and is handed over with #3 all the same.
      expect(wake.messages.map((item: any) => item.sequence)).toEqual([2, 3]);
      expect(wake.events.map((event: any) => event.kind)).toEqual(["message", "message"]);
      expect(await cursorOf(space)).toBe(3);
    });

    it("with --ack manual, hands back the same wake until it is acknowledged, then moves on", async () => {
      const space = await joinedSpace();
      const first = await run(["wait", "--on", "message", "--ack", "manual", "--json"], space, [page([message(2, "review W3")])]);
      expect(first.exitCode).toBe(0);
      const wake = JSON.parse(first.stdout);
      expect(await cursorOf(space)).toBe(1);
      // The caller died before saying it was done: the next wait is handed the same wake.
      const again = await run(["wait", "--on", "message", "--ack", "manual", "--json"], space, [page([message(2, "review W3")])]);
      expect(again.requests[0]!.url).toContain("after=1");
      expect(JSON.parse(again.stdout).wake_id).toBe(wake.wake_id);

      const acked = await run(["ack", wake.wake_id, "--json"], space, []);
      expect(acked.exitCode).toBe(0);
      expect(JSON.parse(acked.stdout)).toMatchObject({ wake_id: wake.wake_id, member_id: MEMBER_ID, last_sequence: 2 });
      expect(await cursorOf(space)).toBe(2);
      // Handled is handled: acknowledging it again moves nothing and says why.
      const twice = await run(["ack", wake.wake_id, "--json"], space, []);
      expect(twice.exitCode).not.toBe(0);
      expect(twice.stderr).toContain("unknown_wake");
      expect(await cursorOf(space)).toBe(2);
    });

    it("wakes on the clock without a message, and on a check the run it starts to pass", async () => {
      const space = await joinedSpace();
      // A one-off already due: nothing need be said, and the poll does not sit.
      const due = await run(["wait", "--on", "at 2020-01-01T00:00:00Z", "--json"], space, [page([])]);
      expect(due.exitCode).toBe(0);
      expect(due.requests[0]!.url).toContain("timeout=0");
      const timer = JSON.parse(due.stdout);
      expect(timer.fired).toEqual(["at 2020-01-01T00:00:00Z"]);
      expect(timer.events).toEqual([expect.objectContaining({ kind: "timer", trigger: "at 2020-01-01T00:00:00Z" })]);
      expect(await cursorOf(space)).toBe(1);

      // A check runs at once and then every --check-every; it fires on the run where it starts to pass.
      let clock = Date.parse("2026-10-05T12:00:00Z");
      const outcomes = [1, 0];
      const commands: string[] = [];
      const checked = await run(
        ["wait", "--on", "check: test -f done.txt", "--check-every", "1m", "--json"],
        space,
        [page([]), page([])],
        {},
        {
          now: () => new Date((clock += 20_000)),
          exec: async (command) => {
            commands.push(command);
            return { exitCode: outcomes.shift() ?? 0, stdout: "3 passed", stderr: "" };
          },
        },
      );
      expect(checked.exitCode).toBe(0);
      expect(commands).toEqual(["test -f done.txt", "test -f done.txt"]);
      const wake = JSON.parse(checked.stdout);
      expect(wake.fired).toEqual(["check test -f done.txt"]);
      expect(wake.events).toEqual([expect.objectContaining({ kind: "check", command: "test -f done.txt", exit_code: 0, output: "3 passed" })]);
    });

    it("fires a check when it starts to pass, not on every minute it keeps passing", async () => {
      const space = await joinedSpace();
      let clock = Date.parse("2026-10-05T12:00:00Z");
      // pass (fires), pass (quiet), fail, pass (fires again)
      const outcomes = [0, 0, 1, 0];
      const handled: string[] = [];
      const result = await run(
        ["wait", "--on", "check: ./verify", "--check-every", "1m", "--run", "agent-turn", "--max-runs", "2", "--json"],
        space,
        [page([]), page([]), page([]), page([])],
        {},
        {
          now: () => new Date((clock += 20_000)),
          exec: async (command, input) => {
            if (command === "./verify") return { exitCode: outcomes.shift() ?? 1, stdout: "", stderr: "" };
            handled.push(JSON.parse(input).fired.join(","));
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(outcomes).toEqual([]);
      expect(handled).toEqual(["check ./verify", "check ./verify"]);
    });

    it("wakes once the Room is closed, and a resident wait ends with it", async () => {
      const space = await joinedSpace();
      let clock = Date.parse("2026-10-05T12:00:00Z");
      const result = await run(
        ["wait", "--on", "message", "--on", "closed", "--run", "wrap-up", "--json"],
        space,
        [roomState("open"), page([]), roomState("closed"), page([])],
        {},
        { now: () => new Date((clock += 20_000)), exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      );
      expect(result.exitCode).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary.closed).toBe(true);
      expect(summary.runs).toEqual([expect.objectContaining({ fired: ["closed"], status: "ok" })]);

      // A seat whose token stops working when the Room closes hears it from the poll itself.
      const refused = await run(
        ["wait", "--on", "closed", "--json"],
        space,
        [roomState("open"), { status: 409, body: { error: { code: "room_closed", message: "Room is closed." } } }],
      );
      expect(refused.exitCode).toBe(0);
      expect(JSON.parse(refused.stdout).fired).toEqual(["closed"]);
    });

    it("offers an unhandled wake again after a restart with the same reply key, so the Room takes one reply", async () => {
      const space = await joinedSpace();
      const exec: CommandRunner = async () => ({ exitCode: 0, stdout: "On it.", stderr: "" });
      const failed = await run(
        ["wait", "--on", "message", "--run", "agent-turn", "--reply", "--max-failures", "1", "--json"],
        space,
        [page([message(2, "take W3")]), { status: 409, body: { error: { code: "conflict", message: "Try again." } } }],
        {},
        { exec },
      );
      expect(failed.exitCode).not.toBe(0);
      expect(await cursorOf(space)).toBe(1);
      const retried = await run(
        ["wait", "--on", "message", "--run", "agent-turn", "--reply", "--max-runs", "1", "--json"],
        space,
        [page([message(2, "take W3")]), { status: 201, body: { message: { ...own(3, "On it."), id: "msg_reply00002" } } }],
        {},
        { exec },
      );
      expect(retried.exitCode).toBe(0);
      const keyOf = (result: typeof failed) => header(result.requests.find((request) => request.init.method === "POST")!, "idempotency-key");
      expect(keyOf(failed)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(keyOf(retried)).toBe(keyOf(failed));
      expect(await cursorOf(space)).toBe(2);
    });

    it("writes one line per wake to --log, for whoever keeps the record of a run", async () => {
      const space = await joinedSpace();
      const logFile = join(space.root, "wakes.ndjson");
      const result = await run(
        ["watch", "--on", "message", "--on", "every 10m", "--run", "agent-turn", "--max-runs", "1", "--log", logFile, "--json"],
        space,
        [page([message(2, "hi")])],
        {},
        { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      );
      expect(result.exitCode).toBe(0);
      const lines = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([
        expect.objectContaining({ verb: "watch", room_id: ROOM_ID, fired: ["message"], sequences: [2], from: 1, through: 2, status: "ok", exit_code: 0 }),
      ]);
    });

    it("refuses what cannot mean anything, before touching the network", async () => {
      const space = await joinedSpace();
      for (const argv of [
        ["wait", "--on", "message", "--hook"],
        ["wait", "--on", "message", "--min", "2"],
        ["wait", "--on", "message", "--reply"],
        ["wait", "--on", "message", "--run", "x", "--ack", "manual"],
        ["wait", "--on", "message", "--ack", "sometimes"],
        ["wait", "--on", "cron 0 0 31 2 *"],
        ["ack", "not-a-wake"],
      ]) {
        const result = await run([...argv, "--json"], space, []);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
        expect(result.requests, argv.join(" ")).toHaveLength(0);
      }
    });
  });

  it("waits from the last sequence seen, loops past an empty page, and advances the cursor", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--json"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
      {
        status: 200,
        body: {
          items: [message(2, "Any objections?"), message(3, "None here", "codex")],
          next_cursor: "3",
          has_more: false,
        },
      },
    ]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.requests.map((request) => request.url)).toEqual([
      `https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/wait?after=1&timeout=25`,
      `https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/wait?after=1&timeout=25`,
    ]);
    expect(header(result.requests[1]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
    expect(await cursorOf(space)).toBe(3);
  });

  it("sits in every Room this machine holds a seat in, from one process", async () => {
    // The point of the connector: multi-Room costs nothing, because the seats are already on disk.
    // Two loops, so two refusals end them; neither is asserted on order, only that both were seen.
    const space = await joinedSpace();
    await seatIn(space, "rom_SecondRoom", "i_AbCdEfGhIj");
    const { exec } = recorder({ exitCode: 0, stdout: "" });
    const result = await run(["serve", "--run", "handle", "--json"], space, [revoked(), revoked(), revoked(), revoked()], {}, { exec });

    expect(result.stderr).toContain("sitting in 2 Room(s)");
    expect(result.stderr).toContain(ROOM_ID);
    expect(result.stderr).toContain("rom_SecondRoom");
    expect(result.exitCode).toBe(0);
  });

  it("hands each wake to the command with the Room it came from", async () => {
    const space = await joinedSpace();
    await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
    const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
    await run(["serve", "--rooms", ROOM_ID, "--run", "handle", "--json"], space, [
      page([message(2, "wake up")]),
      revoked(),
    ], {}, { exec });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ room_id: ROOM_ID, trigger: "message" });
    expect(calls[0]!.env.SHAREDNET_ROOM_ID).toBe(ROOM_ID);
    expect((calls[0]!.input as { messages: { sequence: number }[] }).messages.map((m) => m.sequence)).toEqual([2]);
  });

  it("remembers where it had read, so a restart catches what arrived while it was gone", async () => {
    // A connector that forgets its cursor either replays everything or loses the wake it exists
    // for. It keeps its own, because the project cursor belongs to a checkout and it is not in one.
    const space = await joinedSpace();
    await seatCursor(space, ROOM_ID, MEMBER_ID, 6);
    const { exec } = recorder({ exitCode: 0, stdout: "" });
    const first = await run(["serve", "--rooms", ROOM_ID, "--run", "handle", "--json"], space, [
      page([message(7, "seen before the restart")]),
      revoked(),
    ], {}, { exec });
    expect(new URL(first.requests[0]!.url).searchParams.get("after")).toBe("6");

    const second = await run(["serve", "--rooms", ROOM_ID, "--run", "handle", "--json"], space, [revoked()], {}, { exec });
    // The restart asks from 7 — what it had read — not from 0 and not from the Room's end.
    expect(new URL(second.requests[0]!.url).searchParams.get("after")).toBe("7");
  });

  it.each([500, 502, 503])("keeps serving after HTTP %s with a structured internal_error", async (status) => {
    const space = await joinedSpace();
    await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
    const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
    const result = await run(["serve", "--run", "handle", "--json"], space, [
      { status, body: { error: { code: "internal_error" } } },
      page([message(2, "after the outage")]),
      { status, body: { error: { code: "internal_error" } } },
      page([message(3, "after another outage")]),
      revoked(),
    ], {}, { exec, service: { delivered_through: 1, acked_through: 1 } });
    expect(calls.map((call) => (call.input as { messages: unknown[] }).messages)).toEqual([[message(2, "after the outage")], [message(3, "after another outage")]]);
    expect(result.acks).toEqual([2, 3]);
    expect(new URL(result.requests[3]!.url).searchParams.get("after")).toBe("2");
    expect(new URL(result.requests[1]!.url).searchParams.get("after")).toBe("1");
  });

  it("retries a failed startup without abandoning the seat", async () => {
    const space = await joinedSpace();
    const { writeFile } = await import("node:fs/promises");
    const file = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.json`);
    const credential = JSON.parse(await readFile(file, "utf8"));
    delete credential.room_type;
    await writeFile(file, JSON.stringify(credential));
    await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
    const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
    const result = await run(["serve", "--run", "handle", "--json"], space, [
      { status: 500, body: { error: { code: "internal_error" } } },
      roomState("open"), page([message(2, "after startup recovered")]), revoked(),
    ], {}, { exec, service: { delivered_through: 1, acked_through: 1 } });
    expect(calls).toHaveLength(1);
    expect(result.acks).toEqual([2]);
  });

  it("reports a stopped seat while another seat is still listening", async () => {
    const space = await joinedSpace();
    await seatIn(space, "rom_SecondRoom", "i_AbCdEfGhIj");
    const { writeFile } = await import("node:fs/promises");
    const file = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", "rom_SecondRoom", "i_AbCdEfGhIj.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), room_type: "board" }));
    await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
    await seatCursor(space, "rom_SecondRoom", "i_AbCdEfGhIj", 1);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const serving = run(["serve", "--run", "handle", "--json"], space, [revoked(), { ...revoked(), wait }]);
    try {
      await vi.waitFor(async () => {
        const status = JSON.parse((await run(["serve", "--status", "--json"], space, [])).stdout);
        expect(status.running).toBe(true);
        expect(status.seats).toEqual(expect.arrayContaining([
          expect.objectContaining({ state: "stopped", last_error: "invalid_credentials" }),
          expect.objectContaining({ state: "listening" }),
        ]));
      });
    } finally { release(); await serving; }
  });

  it("keeps serving and releases ownership when status persistence fails", async () => {
    const space = await joinedSpace();
    await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
    const fs = await import("node:fs/promises");
    // A directory at the atomic temp-file path models a local status-write failure.
    await fs.mkdir(join(space.env.XDG_CONFIG_HOME!, "sharednet", `serve.json.${process.pid}.tmp`));
    const { exec, calls } = recorder({ exitCode: 0, stdout: "" });
    const result = await run(["serve", "--run", "handle", "--json"], space, [page([message(2, "still work")]), revoked()], {}, { exec });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(result.stderr).toContain("could not update seat status");
    expect(JSON.parse((await run(["serve", "--status", "--json"], space, [])).stdout).running).toBe(false);
  });

  it("reports whether a connector is actually running, not merely that one once was", async () => {
    const space = await joinedSpace();
    const cold = await run(["serve", "--status", "--json"], space, []);
    expect(JSON.parse(cold.stdout)).toMatchObject({ running: false });
    const stop = await run(["serve", "--stop", "--json"], space, []);
    expect(JSON.parse(stop.stdout)).toMatchObject({ stopped: false });
  });

  it("refuses --rooms that does not name Rooms, and --reply with nothing to say", async () => {
    const space = await joinedSpace();
    const bad = await run(["serve", "--rooms", "not-a-room", "--json"], space, []);
    expect(bad.exitCode).not.toBe(0);
    const noCommand = await run(["serve", "--reply", "--json"], space, []);
    expect(noCommand.exitCode).not.toBe(0);
    expect(noCommand.stderr).toContain("--reply needs --run");
  });

  it("carries the read filters into the wait, so a sit can be as narrow as a read", async () => {
    const space = await joinedSpace();
    const result = await run(
      ["wait", "--from-instance", "i_AbCdEfGhIj", "--grep", "deploy", "--json"],
      space,
      [page([message(2, "ready to deploy")]), page([message(2, "ready to deploy")])],
    );

    expect(result.exitCode).toBe(0);
    const url = new URL(result.requests[0]!.url);
    expect(url.searchParams.get("sender_instance_id")).toBe("i_AbCdEfGhIj");
    expect(url.searchParams.get("q")).toBe("deploy");
    // The cursor and the timeout still ride alongside them.
    expect(url.searchParams.get("after")).toBe("1");
    expect(url.searchParams.get("timeout")).toBe("25");
  });

  describe("a filter decides when a seat wakes, never what it is handed", () => {
    // Before this, the cursor jumped to the matching message and everything said before it was gone:
    // not shown then, and not shown to any later wait either.
    const aside = (sequence: number, content: string) => ({
      ...message(sequence, content, "codex"),
      sender: { member_id: "i_OtherOther", kind: "instance", name: "codex" },
    });
    const serveCursorOf = async (space: Awaited<ReturnType<typeof workspace>>) =>
      Number(
        (await readFile(join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.serve-cursor`), "utf8")).trim(),
      );

    it("hands a plain wait everything said since its cursor, not only the match", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--from-instance", "i_HostHostHo", "--json"], space, [
        page([message(3, "the answer")]),
        page([aside(2, "the context"), message(3, "the answer")]),
      ]);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      // It waits with the filter, then reads the span it is about to cross once more without it.
      expect(new URL(result.requests[0]!.url).searchParams.get("sender_instance_id")).toBe("i_HostHostHo");
      expect(result.requests[1]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages?after=1&limit=100`);
      expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
      expect(await cursorOf(space)).toBe(3);
    });

    it("hands a wait --on the same span, from the last handled wake through the match", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--on", "message", "--from-instance", "i_HostHostHo", "--json"], space, [
        page([message(3, "the answer")]),
        page([aside(2, "the context"), message(3, "the answer")]),
      ]);

      expect(result.exitCode).toBe(0);
      const wake = JSON.parse(result.stdout);
      expect(wake).toMatchObject({ fired: ["message"], from: 1, through: 3 });
      expect(wake.messages.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
      expect(wake.events.map((event: { sequence: number }) => event.sequence)).toEqual([2, 3]);
      expect(await cursorOf(space)).toBe(3);
    });

    it("reads a long span page by page, and only up to the match", async () => {
      const space = await joinedSpace();
      const first = Array.from({ length: 100 }, (_, index) => aside(index + 2, `note ${index + 2}`));
      const rest = [...Array.from({ length: 49 }, (_, index) => aside(index + 102, `note ${index + 102}`)), message(151, "the answer")];
      const result = await run(["wait", "--from-instance", "i_HostHostHo", "--json"], space, [
        page([message(151, "the answer")]),
        { status: 200, body: { items: first, next_cursor: "101", has_more: true } },
        // Said after the match: the next wake's, not this one's.
        page([...rest, aside(152, "too late for this wake")]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.requests.slice(1).map((request) => new URL(request.url).searchParams.get("after"))).toEqual(["1", "101"]);
      const sequences = JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence);
      expect(sequences).toHaveLength(150);
      expect([sequences[0], sequences.at(-1)]).toEqual([2, 151]);
      expect(await cursorOf(space)).toBe(151);
    });

    it("loses nothing to the seat's own matching words: serve hands them over with the next match", async () => {
      // The seat's own "deploy" matches --grep deploy and moves the poll on, but wakes nobody. What
      // codex said before it is not the seat's to drop; it rides along with the next real match.
      const space = await joinedSpace();
      await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
      const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
      const result = await run(["serve", "--rooms", ROOM_ID, "--grep", "deploy", "--run", "handle", "--json"], space, [
        page([own(3, "deploy it")]),
        page([message(4, "deploy done")]),
        page([aside(2, "the tests are slow today"), own(3, "deploy it"), message(4, "deploy done")]),
        revoked(),
      ], {}, { exec });

      expect(result.exitCode).toBe(0);
      expect(new URL(result.requests[1]!.url).searchParams.get("after")).toBe("3");
      expect(result.requests[2]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages?after=1&limit=100`);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.input as { messages: { sequence: number }[] }).messages.map((m) => m.sequence)).toEqual([2, 4]);
      expect(calls[0]!.env.SHAREDNET_MESSAGE_COUNT).toBe("2");
      expect(await serveCursorOf(space)).toBe(4);
    });

    it("keeps serve's cursor where it was when the span cannot be read, so the wake comes round again", async () => {
      const space = await joinedSpace();
      await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
      const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
      const result = await run(["serve", "--rooms", ROOM_ID, "--from-instance", "i_HostHostHo", "--run", "handle", "--json"], space, [
        page([message(3, "the answer")]),
        { status: 503, body: { error: { code: "service_unavailable", message: "Try again." } } },
        page([message(3, "the answer")]),
        page([aside(2, "the context"), message(3, "the answer")]),
        revoked(),
      ], {}, { exec });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("retrying in 10s: service_unavailable");
      expect(new URL(result.requests[2]!.url).searchParams.get("after")).toBe("1");
      expect(calls).toHaveLength(1);
      expect((calls[0]!.input as { messages: { sequence: number }[] }).messages.map((m) => m.sequence)).toEqual([2, 3]);
      expect(await serveCursorOf(space)).toBe(3);
    });
  });

  it.each([
    ["--from-instance", "not-an-instance"],
    ["--from-agent", "not-an-agent"],
    ["--grep", ""],
  ])("refuses a malformed %s before it asks the server", async (flag, value) => {
    const space = await joinedSpace();
    const result = await run(["wait", flag, value, "--json"], space, []);
    expect(result.exitCode).not.toBe(0);
    expect(result.requests).toHaveLength(0);
  });

  describe("the service keeps the seat's place (wait PR 5)", () => {
    // One mark per seat per Room, on the service: every door moves the same one. The seat file and
    // the connector's file only mirror it, and whichever is further along wins.
    it("starts where the seat stopped, even when this directory is behind", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--json"], space, [page([message(6, "new")])], {}, { service: { delivered_through: 5, acked_through: 5 } });

      expect(result.exitCode).toBe(0);
      expect(new URL(result.requests[0]!.url).searchParams.get("after")).toBe("5");
      expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([6]);
      expect(result.acks).toEqual([6]);
      expect(await cursorOf(space)).toBe(6);
    });

    it("carries this directory's progress to the service once, instead of handing it over again", async () => {
      const space = await joinedSpace();
      await run(["wait", "--json"], space, [page([message(2, "a"), message(3, "b")])]);
      const service = { delivered_through: 0, acked_through: 0 };
      // An older CLI kept the place only here: the service is told, and the wait starts after it.
      const result = await run(["wait", "--json"], space, [page([message(4, "c")])], {}, { service });

      expect(result.acks).toEqual([3, 4]);
      expect(new URL(result.requests[0]!.url).searchParams.get("after")).toBe("3");
      expect(service.acked_through).toBe(4);
    });

    it("tells the service nothing when nothing was handed over", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--timeout", "0", "--json"], space, [page([])], {}, { service: { delivered_through: 1, acked_through: 1 } });

      expect(result.exitCode).toBe(0);
      expect(result.acks).toEqual([]);
    });

    it("with --ack manual, moves the service's mark only on `sharednet ack`", async () => {
      const space = await joinedSpace();
      const service = { delivered_through: 1, acked_through: 1 };
      const held = await run(["wait", "--on", "message", "--ack", "manual", "--json"], space, [page([message(2, "review this")])], {}, { service });
      const wake = JSON.parse(held.stdout);
      expect(held.acks).toEqual([]);
      expect(service.acked_through).toBe(1);

      const acked = await run(["ack", wake.wake_id, "--json"], space, [], {}, { service });
      expect(acked.exitCode).toBe(0);
      expect(acked.acks).toEqual([2]);
      expect(service.acked_through).toBe(2);
    });

    it("has watch acknowledge only once the command succeeded and its reply is in", async () => {
      const space = await joinedSpace();
      const service = { delivered_through: 1, acked_through: 1 };
      const failing = await run(["watch", "--on", "message", "--run", "agent-turn", "--max-runs", "1", "--max-failures", "1", "--json"], space, [page([message(2, "hi")])], {}, {
        service,
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      });
      expect(failing.exitCode).not.toBe(0);
      expect(failing.acks).toEqual([]);

      const working = await run(["watch", "--on", "message", "--run", "agent-turn", "--max-runs", "1", "--json"], space, [page([message(2, "hi")])], {}, {
        service,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(working.exitCode).toBe(0);
      expect(working.acks).toEqual([2]);
    });

    it("has serve resume from the service's place, whatever its own file says", async () => {
      const space = await joinedSpace();
      await seatCursor(space, ROOM_ID, MEMBER_ID, 1);
      const service = { delivered_through: 7, acked_through: 7 };
      const { exec } = recorder({ exitCode: 0, stdout: "" });
      const result = await run(["serve", "--rooms", ROOM_ID, "--run", "handle", "--json"], space, [page([message(8, "next")]), revoked()], {}, { service, exec });

      expect(new URL(result.requests[0]!.url).searchParams.get("after")).toBe("7");
      expect(result.acks).toEqual([8]);
    });

    it("counts a joined Room's history as handled, as the MCP join does", async () => {
      const space = await workspace();
      const result = await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome"), message(2, "Agenda")])]);

      expect(result.exitCode).toBe(0);
      expect(result.acks).toEqual([2]);
    });
  });

  describe("a wait for a mention asks the service for those lines alone (wait PR 8)", () => {
    it("narrows the long-poll to lines that address this seat, and still hands over the whole span", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--on", "mention", "--json"], space, [
        roomState("open"),
        page([{ ...message(3, "@claude-code your turn"), mentions: [MEMBER_ID] } as ReturnType<typeof message>]),
        page([message(2, "an aside"), message(3, "@claude-code your turn")]),
      ]);

      expect(result.exitCode).toBe(0);
      const poll = new URL(result.requests[1]!.url);
      expect(poll.searchParams.get("mentions")).toBe(MEMBER_ID);
      expect(JSON.parse(result.stdout)).toMatchObject({ fired: ["mention"] });
      expect(JSON.parse(result.stdout).messages.map((item: { sequence: number }) => item.sequence)).toEqual([2, 3]);
    });

    it("takes the service's word for who a line addresses, so an account seat named by its tag wakes too", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--on", "mention", "--on", "said", "nothing-matches-this", "--json"], space, [
        roomState("open"),
        page([{ ...message(2, "@reviewer the build is red"), mentions: [MEMBER_ID] } as ReturnType<typeof message>]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ fired: ["mention"] });
    });

    it("does not narrow when anything said may wake it", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--on", "mention", "--on", "message", "--json"], space, [roomState("open"), page([message(2, "hello")])]);

      expect(result.exitCode).toBe(0);
      expect(new URL(result.requests[1]!.url).searchParams.has("mentions")).toBe(false);
    });
  });

  describe("the session that took a seat is resumed when the seat is addressed (the drivers)", () => {
    // A Codex session, as Codex's own commands see it: the thread id is CODEX_SESSION_ID.
    const CODEX = { CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "019a-codex-thread", CODEX_HOME: "/codex-home", PATH: "" };
    const credentialOf = async (space: Awaited<ReturnType<typeof workspace>>) =>
      JSON.parse(await readFile(join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.json`), "utf8"));
    const serveCursorOf = async (space: Awaited<ReturnType<typeof workspace>>) =>
      Number((await readFile(join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.serve-cursor`), "utf8")).trim());
    const addressed = (sequence: number, content: string) => ({ ...message(sequence, content), mentions: [MEMBER_ID] }) as ReturnType<typeof message>;
    /** A turn runner that records each turn and answers as Codex's --json stream would. */
    function turnsOf(answer: { exitCode?: number; stdout?: string } = {}) {
      const turns: TurnSpec[] = [];
      const runTurn: TurnRunner = async (spec) => {
        turns.push(spec);
        return {
          exitCode: answer.exitCode ?? 0,
          stdout:
            answer.stdout ??
            [
              JSON.stringify({ type: "thread.started", thread_id: "019a-codex-thread" }),
              JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "@host 2+2 is 4." } }),
              JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
            ].join("\n"),
          stderr: "",
          timedOut: false,
        };
      };
      return { turns, runTurn };
    }

    it("remembers the session at join, and leaves it out with --no-wake or SHAREDNET_WAKE=off", async () => {
      const space = await workspace();
      const result = await run(["join", PASTED_INVITE, "--json"], space, [joined([message(1, "Welcome")])], CODEX);

      expect(result.exitCode).toBe(0);
      expect((await credentialOf(space)).wake).toEqual({ driver: "codex", session: "019a-codex-thread", cwd: space.project, command: "codex", codex_home: "/codex-home" });
      expect(JSON.parse(result.stdout).wake).toEqual({ driver: "codex", session: "019a-codex-thread", address: "@codex", service: "not_started" });
      expect(result.stderr).toContain("Wake: when someone writes @codex in this Room, this Codex session is resumed with what was said");
      // The session id is this machine's business: the server never hears it.
      expect(String(result.requests[0]!.init.body)).not.toContain("019a-codex-thread");

      for (const [flags, environment] of [[["--no-wake"], CODEX], [[], { ...CODEX, SHAREDNET_WAKE: "off" }]] as const) {
        const other = await workspace();
        const quiet = await run(["join", PASTED_INVITE, ...flags, "--json"], other, [joined([message(1, "Welcome")])], environment);
        expect(quiet.exitCode).toBe(0);
        expect((await credentialOf(other)).wake).toBeUndefined();
        expect(JSON.parse(quiet.stdout).wake).toBeUndefined();
        expect(quiet.stderr).not.toContain("Wake:");
      }
    });

    it("starts the wake service after a join, but not from inside a sandbox, and not a second one", async () => {
      const started: Array<{ logFile: string; env: Record<string, string | undefined> }> = [];
      const startWakeService = (input: { env: Record<string, string | undefined>; logFile: string }) => (started.push(input), 4242);

      const space = await workspace();
      const first = await run(["join", PASTED_INVITE, "--json"], space, [joined([message(1, "Welcome")])], CODEX, { startWakeService });
      expect(JSON.parse(first.stdout).wake).toMatchObject({ service: "started", pid: 4242 });
      expect(started).toHaveLength(1);
      expect(started[0]!.logFile).toBe(join(space.env.XDG_STATE_HOME!, "sharednet", "serve.log"));
      expect(first.stderr).toContain("pid 4242");

      const boxed = await workspace();
      const sandboxed = await run(["join", PASTED_INVITE, "--json"], boxed, [joined([message(1, "Welcome")])], { ...CODEX, CODEX_SANDBOX: "seatbelt" }, { startWakeService });
      expect(JSON.parse(sandboxed.stdout).wake.service).toBe("not_started");
      expect(sandboxed.stderr).toContain("sandbox");
      expect(started).toHaveLength(1);

      // A connector that drives is already running (this process stands in for it): it takes the seat.
      const { mkdir, writeFile } = await import("node:fs/promises");
      const busy = await workspace();
      await mkdir(join(busy.env.XDG_CONFIG_HOME!, "sharednet"), { recursive: true, mode: 0o700 });
      const status = join(busy.env.XDG_CONFIG_HOME!, "sharednet", "serve.json");
      await writeFile(status, JSON.stringify({ pid: process.pid, started_at: "2026-10-05T00:00:00.000Z", rooms: [], drives: true }));
      const running = await run(["join", PASTED_INVITE, "--json"], busy, [joined([message(1, "Welcome")])], CODEX, { startWakeService });
      expect(JSON.parse(running.stdout).wake.service).toBe("running");
      expect(started).toHaveLength(1);

      // One from before the drivers resumes nobody, and the join says to restart it.
      await writeFile(status, JSON.stringify({ pid: process.pid, started_at: "2026-10-05T00:00:00.000Z", rooms: [] }));
      const outdated = await run(["join", PASTED_INVITE, "--json"], await workspace().then(async (fresh) => {
        await mkdir(join(fresh.env.XDG_CONFIG_HOME!, "sharednet"), { recursive: true, mode: 0o700 });
        await writeFile(join(fresh.env.XDG_CONFIG_HOME!, "sharednet", "serve.json"), JSON.stringify({ pid: process.pid, started_at: "2026-10-05T00:00:00.000Z", rooms: [] }));
        return fresh;
      }), [joined([message(1, "Welcome")])], CODEX, { startWakeService });
      expect(JSON.parse(outdated.stdout).wake.service).toBe("outdated");
      expect(outdated.stderr).toContain("sharednet serve --stop");
      expect(started).toHaveLength(1);
    });

    it("resumes the seat's own Codex session with everything said since, posts its answer, and counts it handled only after", async () => {
      const space = await workspace();
      expect((await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])], CODEX)).exitCode).toBe(0);
      const { turns, runTurn } = turnsOf();
      let cursorDuringTurn: number | null = null;
      const watched: TurnRunner = async (spec) => {
        cursorDuringTurn = await serveCursorOf(space);
        return runTurn(spec);
      };
      const service = { delivered_through: 1, acked_through: 1 };
      const result = await run(["serve", "--json"], space, [
        page([addressed(3, "@codex what is 2+2?")]),
        page([message(2, "the build is green"), addressed(3, "@codex what is 2+2?")]),
        { status: 201, body: { message: own(4, "@host 2+2 is 4.") } },
        revoked(),
      ], CODEX, { service, runTurn: watched });

      expect(result.exitCode).toBe(0);
      // The long-poll asks for lines that address this seat; the wake still carries the whole span.
      expect(new URL(result.requests[0]!.url).searchParams.get("mentions")).toBe(MEMBER_ID);
      expect(result.requests[1]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages?after=1&limit=100`);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      // No sandbox chosen in /codex-home: the turn gets the one an interactive session works in.
      expect([turn.command, ...turn.args]).toEqual([
        "codex", "exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "019a-codex-thread", "-",
      ]);
      expect(turn.cwd).toBe(space.project);
      expect(turn.env).toMatchObject({ SHAREDNET_SEAT: MEMBER_ID, CODEX_HOME: "/codex-home" });
      // The session being resumed is not the one serve runs in: its markers stay behind.
      expect(turn.env.CODEX_SESSION_ID).toBeUndefined();
      expect(turn.input).toContain(`You were addressed in Room ${ROOM_ID}`);
      expect(turn.input).toContain("#2 host: the build is green");
      expect(turn.input).toContain("#3 host: @codex what is 2+2?");
      // The turn's last message is the seat's reply, posted for it.
      const reply = result.requests[2]!;
      expect(reply.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
      expect(header(reply, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
      expect(JSON.parse(String(reply.init.body))).toEqual({ content: "@host 2+2 is 4." });
      // Handled after the turn, not when it was handed over: a crash mid-turn hands it over again.
      expect(cursorDuringTurn).toBe(1);
      expect(result.acks).toEqual([3]);
      expect(await serveCursorOf(space)).toBe(3);
      expect(result.stderr).toContain("finished its turn: @host 2+2 is 4.");
    });

    it("posts nothing for a turn that ends with nothing to say", async () => {
      const space = await workspace();
      expect((await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])], CODEX)).exitCode).toBe(0);
      const { turns, runTurn } = turnsOf({
        stdout: ['{"type":"item.completed","item":{"type":"agent_message","text":"(no reply)"}}', '{"type":"turn.completed","usage":{}}'].join("\n"),
      });
      const service = { delivered_through: 1, acked_through: 1 };
      const result = await run(["serve", "--json"], space, [page([addressed(2, "@codex fyi, deploy done")]), page([addressed(2, "@codex fyi, deploy done")]), revoked()], CODEX, { service, runTurn });

      expect(result.exitCode).toBe(0);
      expect(turns).toHaveLength(1);
      expect(result.requests.filter((request) => request.init.method === "POST")).toHaveLength(0);
      expect(result.acks).toEqual([2]);
      expect(result.stderr).toContain("finished its turn with nothing to say");
    });

    it("tells the Room when the session could not be resumed, and does not wake for it again", async () => {
      // The workspace's own Claude Code session took this seat.
      const space = await joinedSpace();
      const { turns, runTurn } = turnsOf({
        exitCode: 1,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
      });
      const service = { delivered_through: 1, acked_through: 1 };
      const result = await run(["serve", "--json"], space, [
        page([addressed(2, "@claude-code review this")]),
        page([addressed(2, "@claude-code review this")]),
        { status: 201, body: { message: own(3, "(claude-code was addressed …)") } },
        revoked(),
      ], {}, { service, runTurn });

      expect(result.exitCode).toBe(0);
      expect([turns[0]!.command, ...turns[0]!.args]).toEqual(["claude", "-p", "--resume", "claude-session-stays-local", "--output-format", "json"]);
      const said = result.requests[2]!;
      expect(said.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
      expect(JSON.parse(String(said.init.body)).content).toBe(
        "(claude-code was addressed, but its Claude Code session could not be resumed: Not logged in · Please run /login)",
      );
      expect(result.acks).toEqual([2]);
    });

    it("reports a timed-out turn accurately and still handles the next mention", async () => {
      const space = await workspace();
      await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])], CODEX);
      const turns: TurnSpec[] = [];
      const runTurn: TurnRunner = async (spec) => {
        turns.push(spec);
        return turns.length === 1
          ? { exitCode: 143, stdout: "", stderr: "", timedOut: true }
          : { exitCode: 0, stdout: '{"type":"turn.completed","usage":{}}', stderr: "", timedOut: false };
      };
      const result = await run(["serve", "--json"], space, [
        page([addressed(2, "@codex long task")]), page([addressed(2, "@codex long task")]),
        { status: 201, body: { message: own(3, "timeout notice") } },
        page([addressed(4, "@codex next task")]), page([own(3, "timeout notice"), addressed(4, "@codex next task")]),
        revoked(),
      ], CODEX, { service: { delivered_through: 1, acked_through: 1 }, runTurn });
      const notice = result.requests.find((request) => request.init.method === "POST")!;
      expect(JSON.parse(String(notice.init.body)).content).toContain("turn was stopped");
      expect(JSON.parse(String(notice.init.body)).content).not.toContain("could not be resumed");
      expect(turns).toHaveLength(2);
      expect(result.acks).toEqual([2, 4]);
    });

    it("leaves alone a seat no session took, unless --run gives it a command", async () => {
      // Such a seat is someone's own `wait`'s to answer; sitting in it would count its lines as handled.
      const space = await workspace();
      expect((await run(["join", PASTED_INVITE, "--no-wake"], space, [joined([message(1, "Welcome")])])).exitCode).toBe(0);
      const result = await run(["serve", "--json"], space, []);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("no session to wake");
      expect(result.requests).toHaveLength(0);
    });

    it("starts a driven seat where its join left it, so nothing said after the join is skipped", async () => {
      const space = await workspace();
      expect((await run(["join", PASTED_INVITE], space, [joined([])], CODEX)).exitCode).toBe(0);
      const { turns, runTurn } = turnsOf({ stdout: '{"type":"turn.completed","usage":{}}' });
      const result = await run(["serve", "--json"], space, [
        page([addressed(3, "@codex and you?")]),
        page([message(1, "said after the join"), message(2, "and this"), addressed(3, "@codex and you?")]),
        revoked(),
      ], CODEX, { runTurn });

      expect(result.exitCode).toBe(0);
      // No jump to the Room's end: the long-poll starts at the join's place.
      expect(new URL(result.requests[0]!.url).searchParams.get("after")).toBe("0");
      expect(turns[0]!.input).toContain("#1 host: said after the join");
      expect(result.acks).toEqual([3]);
    });

    it("speaks with the token the seat's session holds now, not the one it joined with", async () => {
      // A session that registers again is handed a new token; only the session file has it.
      const space = await workspace();
      expect((await run(["join", PASTED_INVITE], space, [joined([message(1, "Welcome")])], CODEX)).exitCode).toBe(0);
      const { mkdir, writeFile } = await import("node:fs/promises");
      const sessions = join(space.env.XDG_STATE_HOME!, "sharednet", "sessions");
      await mkdir(sessions, { recursive: true, mode: 0o700 });
      const fresh = `sni_${"F".repeat(43)}`;
      await writeFile(
        join(sessions, `${MEMBER_ID}.json`),
        JSON.stringify({
          schema_version: 1,
          base_url: "https://www.sharednet.ai",
          principal_id: "p_AbCdEfGhIj",
          agent_id: null,
          instance_id: MEMBER_ID,
          local_instance_key: null,
          instance_token: fresh,
          created_at: "2026-10-05T00:00:00.000Z",
          lease_expires_at: "2026-10-05T00:01:30.000Z",
          expires_at: null,
        }),
        { mode: 0o600 },
      );
      const service = { delivered_through: 1, acked_through: 1 };
      const result = await run(["serve", "--json"], space, [revoked()], CODEX, { service });

      expect(result.exitCode).toBe(0);
      expect(header(result.requests[0]!, "authorization")).toBe(`Bearer ${fresh}`);
    });

    it("serves an explicit --run command instead of resuming anything", async () => {
      const space = await joinedSpace();
      const { turns, runTurn } = turnsOf();
      const { calls, exec } = recorder({ exitCode: 0, stdout: "" });
      const service = { delivered_through: 1, acked_through: 1 };
      const result = await run(["serve", "--run", "handle", "--json"], space, [page([message(2, "hello")]), revoked()], {}, { service, runTurn, exec });

      expect(result.exitCode).toBe(0);
      expect(new URL(result.requests[0]!.url).searchParams.has("mentions")).toBe(false);
      expect(calls).toHaveLength(1);
      expect(turns).toHaveLength(0);
    });

    it("is the one connector on the machine, and gives the slot back when it ends", async () => {
      const space = await joinedSpace();
      const { mkdir, writeFile } = await import("node:fs/promises");
      const status = join(space.env.XDG_CONFIG_HOME!, "sharednet", "serve.json");
      await mkdir(join(space.env.XDG_CONFIG_HOME!, "sharednet"), { recursive: true });
      // Another live process holds the slot: the test runner's parent stands in for it.
      await writeFile(status, JSON.stringify({ pid: process.ppid, started_at: "2026-10-05T00:00:00.000Z", rooms: [ROOM_ID], drives: true }));
      const second = await run(["serve", "--json"], space, []);
      expect(second.exitCode).not.toBe(0);
      expect(JSON.parse(second.stdout || second.stderr).error?.code ?? second.stderr).toContain("serve_running");
      expect(second.requests).toHaveLength(0);

      // A slot whose process is gone is taken over, and given back at the end.
      await writeFile(status, JSON.stringify({ pid: 2 ** 22 + 17, started_at: "2026-10-05T00:00:00.000Z", rooms: [ROOM_ID] }));
      const service = { delivered_through: 1, acked_through: 1 };
      const served = await run(["serve", "--json"], space, [revoked()], {}, { service });
      expect(served.exitCode).toBe(0);
      const after = await run(["serve", "--status", "--json"], space, []);
      expect(JSON.parse(after.stdout)).toMatchObject({ running: false });
    });
  });

  describe("sharednet timer: a line the Room's clock says on schedule (wait PR 6)", () => {
    const TIMER = { id: "tm_AbCdEfGhIj", room_id: ROOM_ID, when: "every 20m", say: "@claude-code stand-up", next_at: "2026-10-05T12:20:00.000Z", member_id: "i_ClockClock", created_by: MEMBER_ID, created_at: "2026-10-05T12:00:00.000Z" };

    it("sets one with the seat's token, and lists and cancels them", async () => {
      const space = await joinedSpace();
      const set = await run(["timer", "add", "every 20m", "@claude-code stand-up", "--json"], space, [{ status: 201, body: { timer: TIMER } }]);
      expect(set.exitCode).toBe(0);
      expect(set.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/timers`);
      expect(set.requests[0]!.init.method).toBe("POST");
      expect(JSON.parse(String(set.requests[0]!.init.body))).toEqual({ when: "every 20m", say: "@claude-code stand-up" });
      expect(header(set.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
      expect(JSON.parse(set.stdout).timer.id).toBe(TIMER.id);

      const listed = await run(["timer", "list", "--json"], space, [{ status: 200, body: { items: [TIMER] } }]);
      expect(listed.requests[0]!.init.method).toBe("GET");
      expect(JSON.parse(listed.stdout).items).toHaveLength(1);

      const cancelled = await run(["timer", "cancel", TIMER.id, "--json"], space, [{ status: 200, body: { timer: TIMER } }]);
      expect(cancelled.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/timers/${TIMER.id}/cancel`);
    });

    it("refuses what is not a timer command before asking the service", async () => {
      const space = await joinedSpace();
      for (const argv of [["timer"], ["timer", "add", "every 20m"], ["timer", "cancel", "not-a-timer"], ["timer", "list", "extra"], ["timer", "snooze"]]) {
        const result = await run([...argv, "--json"], space, []);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
        expect(result.requests, argv.join(" ")).toHaveLength(0);
      }
    });
  });

  describe("a wait keeps its deadline", () => {
    // From Dots's sharednet-client PR 4: --timeout N is a promise to answer within N seconds, and a
    // hook must never hang the turn it runs in.
    it("ends on time when the server takes the request and never answers", async () => {
      const space = await joinedSpace();
      const started = Date.now();
      const result = await run(["wait", "--timeout", "1", "--json"], space, [{ hang: true }]);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).items).toEqual([]);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await cursorOf(space)).toBe(1);
    });

    it("ends a wait --on on time too, as a wake that says nothing fired", async () => {
      const space = await joinedSpace();
      const started = Date.now();
      const result = await run(["wait", "--on", "message", "--timeout", "1", "--json"], space, [{ hang: true }]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ fired: [], messages: [], from: 1, through: 1 });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await cursorOf(space)).toBe(1);
    });

    it("never lets a hook hang: a check gives each request five seconds, then fails", async () => {
      const space = await joinedSpace();
      const started = Date.now();
      const result = await run(["wait", "--hook", "--json"], space, [{ hang: true }]);

      expect(result.exitCode).toBe(5);
      expect(JSON.parse(result.stderr).error.code).toBe("service_unavailable");
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(await cursorOf(space)).toBe(1);
    }, 15_000);

    it("stops retrying a service that is down when the next try would land past the deadline", async () => {
      const space = await joinedSpace();
      const down = { error: new TypeError("fetch failed") };
      const result = await run(["wait", "--timeout", "2", "--json"], space, Array.from({ length: 9 }, () => down));

      expect(result.exitCode).toBe(5);
      // One try, and one retry a second later; the next would come after the two seconds it was given.
      expect(result.requests).toHaveLength(2);
      expect(await cursorOf(space)).toBe(1);
    });

    it("never hands over what the cursor has already passed, even when the server repeats it", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--json"], space, [page([message(1, "Welcome"), message(2, "new")])]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([2]);
      expect(await cursorOf(space)).toBe(2);
    });

    it("asks for an Instance id, not the display name an Agent is likely to try", async () => {
      const space = await joinedSpace();
      const result = await run(["wait", "--from-instance", "host", "--json"], space, []);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not a display name");
      expect(result.requests).toHaveLength(0);
    });
  });

  it("outlives a blip: an unreachable service is retried, and the sit still returns what arrives", async () => {
    // A sit with no --timeout is meant to last until someone speaks. One failed poll used to end
    // it, so the wake was lost rather than delayed — this is the bug that burned 200 restarts of a
    // supervised watch overnight.
    const space = await joinedSpace();
    const result = await run(["wait", "--json"], space, [
      { error: new TypeError("fetch failed") },
      { error: new TypeError("fetch failed") },
      page([message(2, "here at last")]),
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.map((item: { sequence: number }) => item.sequence)).toEqual([2]);
    expect(result.requests).toHaveLength(3);
    expect(result.stderr).toContain("the service was unreachable");
    expect(await cursorOf(space)).toBe(2);
  });

  it("gives up rather than retrying forever, and says how many attempts it made", async () => {
    const space = await joinedSpace();
    const result = await run(
      ["wait", "--json"],
      space,
      Array.from({ length: 9 }, () => ({ error: new TypeError("fetch failed") })),
    );

    expect(result.exitCode).toBe(5);
    expect(result.requests).toHaveLength(9);
    expect(result.stderr).toContain("attempt 8 of 8");
  });

  it("raises an answer that says no at once, instead of retrying a refusal", async () => {
    // A revoked seat is the service working. Retrying it eight times would turn a clear refusal
    // into a four-minute hang.
    const space = await joinedSpace();
    const result = await run(["wait", "--json"], space, [
      { status: 401, body: { error: { code: "invalid_credentials", message: "Credentials are invalid." } } },
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.stderr).not.toContain("retrying");
  });

  it("never hands a seat its own words: a page of only them is consumed and the sit goes on", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--json"], space, [
      page([own(2, "what I just said")]),
      page([]),
      page([own(3, "and again"), message(4, "Reply from the host")]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.map((item: any) => [item.sequence, item.content])).toEqual([[4, "Reply from the host"]]);
    // The cursor moved over its own messages too, so nothing is read twice.
    expect(result.requests.map((request) => new URL(request.url).searchParams.get("after"))).toEqual(["1", "2", "2"]);
    expect(await cursorOf(space)).toBe(4);

    // With a deadline, a sit that heard only itself returns empty, cursor advanced.
    const quiet = await run(["wait", "--timeout", "0", "--json"], space, [page([own(5, "me again")])]);
    expect(JSON.parse(quiet.stdout).items).toEqual([]);
    expect(await cursorOf(space)).toBe(5);
  });

  it("treats the apex and www hosts as one SharedNet: a login under either matches an invite from the other", async () => {
    const space = await workspace();
    const { getStoragePaths, writeStoredApiCredential } = await import("./storage.ts");
    // A credential an older CLI wrote under the apex host.
    await writeStoredApiCredential(getStoragePaths(space.env), {
      schema_version: 1, base_url: "https://sharednet.ai", principal_id: "p_AcCoUnT0001", api_key_id: "key_AbCdEfGhIj",
      api_key: `snk_${"K".repeat(43)}`, installation_secret: Buffer.alloc(32, 7).toString("base64url"), created_at: "2026-09-08T00:00:00.000Z", expires_at: null,
    });
    const instance = {
      id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", agent_id: null, runtime_kind: "claude-code", cli_version: "0.1.3",
      runtime_metadata: {}, reach: "public", status: "online", display_name: null,
      started_at: "2026-09-08T00:00:00.000Z", last_seen_at: "2026-09-08T00:00:00.000Z", lease_expires_at: "2026-09-08T00:01:00.000Z",
      token_expires_at: null, ended_at: null, revoked_at: null,
    };
    // The invite names www; the machine must still join as the account, and every request must go to www directly.
    const result = await run(
      ["join", PASTED_INVITE, "--json"],
      space,
      [
        { status: 201, body: { instance, token: `sni_${"A".repeat(43)}`, heartbeat_after_seconds: 30 } },
        { status: 200, body: { room: { id: ROOM_ID, name: "Launch review", state: "open" }, membership: { member_id: "i_AccountSeat1", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" } } },
        { status: 200, body: { items: [], next_cursor: null, has_more: false } },
      ],
    );
    expect(result.stderr).toContain("Seat i_AccountSeat1 in rom_AbCdEfGhIj");
    expect(result.stderr).not.toMatch(/sni_|rit_|snk_|clp_/);
    expect(JSON.parse(result.stdout)).toMatchObject({ as: "account", principal_id: "p_AcCoUnT0001" });
    expect(result.requests.every((request) => request.url.startsWith("https://www.sharednet.ai/"))).toBe(true);

    // whoami reports the seat this directory holds, and the account, on the one origin.
    const who = await run(["whoami", "--json"], space, []);
    expect(JSON.parse(who.stdout)).toMatchObject({
      base_url: "https://www.sharednet.ai",
      account: { principal_id: "p_AcCoUnT0001" },
      seat: { room_id: ROOM_ID, member_id: "i_AccountSeat1", base_url: "https://www.sharednet.ai" },
    });
  });

  it("registers a fresh Instance on every account join, never folding two sessions with one session id into one", async () => {
    const space = await workspace();
    const registration = (id: string) => ({
      status: 201,
      body: {
        instance: {
          id, principal_id: "p_AcCoUnT0001", agent_id: null, runtime_kind: "claude-code", cli_version: "0.1.3", runtime_metadata: {}, reach: "public", status: "online",
          display_name: null, started_at: "2026-09-08T00:00:00.000Z", last_seen_at: "2026-09-08T00:00:00.000Z", lease_expires_at: "2026-09-08T00:01:00.000Z", token_expires_at: null, ended_at: null, revoked_at: null,
        },
        token: `sni_${id.slice(2).padEnd(43, "x")}`,
        heartbeat_after_seconds: 30,
      },
    });
    const joined = (id: string) => ({ status: 200, body: { room: { id: ROOM_ID, name: "Launch review", state: "open" }, membership: { member_id: id, principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" } } });
    const history = { status: 200, body: { items: [], next_cursor: null, has_more: false } };
    // Two windows that report the same driver session id (one host, one id), same machine, same credential.
    const env = { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}`, CLAUDE_CODE_SESSION_ID: "same-id-for-every-window" };
    const first = await run(["join", PASTED_INVITE, "--json"], space, [registration("i_WindowOne1"), joined("i_WindowOne1"), history], env);
    const second = await run(["join", PASTED_INVITE, "--json"], space, [registration("i_WindowTwo2"), joined("i_WindowTwo2"), history], env);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Neither registration names a local session key, so the server cannot hand the second window the first one's Instance.
    for (const result of [first, second]) {
      const body = JSON.parse(String(result.requests[0]!.init.body));
      expect(body).not.toHaveProperty("local_instance_key");
    }
    expect(JSON.parse(first.stdout).member_id).toBe("i_WindowOne1");
    expect(JSON.parse(second.stdout).member_id).toBe("i_WindowTwo2");
    // Both seats are held in this directory; a third command here must say which.
    const room = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(Object.keys(room.seats).sort()).toEqual(["i_WindowOne1", "i_WindowTwo2"]);
  });

  it("lets one invite command run in session after session: a spent claim is not an error where the machine is already the account", async () => {
    const space = await workspace();
    const { getStoragePaths, writeStoredApiCredential } = await import("./storage.ts");
    // The first session already redeemed this claim and bound the machine.
    await writeStoredApiCredential(getStoragePaths(space.env), {
      schema_version: 1, base_url: "https://www.sharednet.ai", principal_id: "p_AcCoUnT0001", api_key_id: "key_AbCdEfGhIj",
      api_key: `snk_${"K".repeat(43)}`, installation_secret: Buffer.alloc(32, 7).toString("base64url"), created_at: "2026-09-09T00:00:00.000Z", expires_at: null,
    });
    const instance = {
      id: "i_SecondSess", principal_id: "p_AcCoUnT0001", agent_id: null, runtime_kind: "claude-code", cli_version: "0.1.0",
      runtime_metadata: {}, reach: "public", status: "online", display_name: null,
      started_at: "2026-09-09T00:00:00.000Z", last_seen_at: "2026-09-09T00:00:00.000Z", lease_expires_at: "2026-09-09T00:01:00.000Z",
      token_expires_at: null, ended_at: null, revoked_at: null,
    };
    const result = await run(
      ["join", PASTED_INVITE, "--claim", CLAIM, "--json"],
      space,
      [
        { status: 410, body: { error: { code: "login_consumed", message: "CLI login was already used." } } },
        { status: 201, body: { instance, token: `sni_${"S".repeat(43)}`, heartbeat_after_seconds: 30 } },
        { status: 200, body: { room: { id: ROOM_ID, name: "Launch review", state: "open" }, membership: { member_id: "i_SecondSess", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" } } },
        { status: 200, body: { items: [], next_cursor: null, has_more: false } },
      ],
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ as: "account", member_id: "i_SecondSess", principal_id: "p_AcCoUnT0001" });
    // It says what happened, names the account, and hands this session the verbs that address its own seat.
    expect(result.stderr).toContain("already used");
    expect(result.stderr).toContain("p_AcCoUnT0001");
    expect(output.next.say).toBe('npx -y sharednet@latest say "…" --as i_SecondSess');
    expect(output.next.wait).toBe("npx -y sharednet@latest wait --as i_SecondSess");
    expect(result.stderr).not.toContain(CLAIM);
  });

  it("refuses a spent claim on a machine with no account, and says how to get a fresh one", async () => {
    const result = await run(
      ["join", PASTED_INVITE, "--claim", CLAIM, "--json"],
      await workspace(),
      [{ status: 410, body: { error: { code: "login_consumed", message: "CLI login was already used." } } }],
    );

    expect(result.exitCode).not.toBe(0);
    // One request: nothing was joined as anybody.
    expect(result.requests).toHaveLength(1);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("claim_spent");
    expect(error.message).toContain("Open the join link again");
  });

  it("groups an account's seat under a tag with --agent, and refuses the flag for a machine that acts as nobody", async () => {
    const space = await workspace();
    const instance = {
      id: "i_TaggedSeat1", principal_id: "p_AcCoUnT0001", agent_id: "a_ReViEwEr01", runtime_kind: "claude-code", cli_version: "0.1.3",
      runtime_metadata: {}, reach: "public", status: "online", display_name: null,
      started_at: "2026-09-08T00:00:00.000Z", last_seen_at: "2026-09-08T00:00:00.000Z", lease_expires_at: "2026-09-08T00:01:00.000Z",
      token_expires_at: null, ended_at: null, revoked_at: null,
    };
    const result = await run(
      ["join", PASTED_INVITE, "--agent", "Reviewer", "--json"],
      space,
      [
        { status: 201, body: { agent: { id: "a_ReViEwEr01", handle: "reviewer", principal_id: "p_AcCoUnT0001" } } },
        { status: 201, body: { instance, token: `sni_${"A".repeat(43)}`, heartbeat_after_seconds: 30 } },
        { status: 200, body: { room: { id: ROOM_ID, name: "Launch review", state: "open" }, membership: { member_id: "i_TaggedSeat1", principal_id: "p_AcCoUnT0001", kind: "instance", admitted_by: "invite", name: null, state: "active" } } },
        { status: 200, body: { items: [], next_cursor: null, has_more: false } },
      ],
      { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` },
    );
    expect(result.stderr).toContain("Seat i_TaggedSeat1 in rom_AbCdEfGhIj");
    expect(result.stderr).not.toMatch(/sni_|rit_|snk_|clp_/);
    expect(result.exitCode).toBe(0);
    // The handle is created (or found) first, then the registration names the tag.
    expect(result.requests.map((request) => `${request.init.method ?? "GET"} ${request.url}`).slice(0, 2)).toEqual([
      "POST https://www.sharednet.ai/api/v1/agents",
      "POST https://www.sharednet.ai/api/v1/instances",
    ]);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({ handle: "reviewer" });
    expect(JSON.parse(String(result.requests[1]!.init.body)).agent_id).toBe("a_ReViEwEr01");
    expect(JSON.parse(result.stdout)).toMatchObject({ as: "account", agent_id: "a_ReViEwEr01", member_id: "i_TaggedSeat1" });

    const nobody = await run(["join", PASTED_INVITE, "--agent", "reviewer", "--json"], await workspace(), []);
    expect(nobody.exitCode).not.toBe(0);
    expect(nobody.requests).toHaveLength(0);
    expect(JSON.parse(nobody.stderr).error.code).toBe("account_required");
  });

  it("keeps two sessions in one directory as two seats: each says and waits as its own, and a stranger must say which", async () => {
    const space = await workspace();
    const sessionA = { CLAUDE_SESSION_ID: "session-a" };
    const sessionB = { CLAUDE_SESSION_ID: "session-b" };
    const joinedAs = (memberId: string, sequence: number) => ({
      status: 200,
      body: {
        room: { id: ROOM_ID, name: "Launch review", state: "open" },
        membership: { member_id: memberId, kind: "guest", name: "claude-code", state: "active" },
        member_token: `sni_${memberId.slice(2).padEnd(43, "x")}`,
        history: { items: [message(1, "Welcome")].slice(0, sequence), next_cursor: null, has_more: false },
      },
    });
    const a = await run(["join", PASTED_INVITE, "--json"], space, [joinedAs("i_SeatAaaaaa", 1)], sessionA);
    const b = await run(["join", PASTED_INVITE, "--json"], space, [joinedAs("i_SeatBbbbbb", 1)], sessionB);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    const room = JSON.parse(await readFile(join(space.project, ".sharednet", "room.json"), "utf8"));
    expect(Object.keys(room.seats).sort()).toEqual(["i_SeatAaaaaa", "i_SeatBbbbbb"]);

    // A says as A: the request carries A's token, not the seat that joined last.
    const said = await run(["say", "from A", "--json"], space, [{ status: 201, body: { message: message(2, "from A") } }], sessionA);
    expect(said.exitCode).toBe(0);
    expect(header(said.requests[0]!, "authorization")).toBe(`Bearer sni_${"SeatAaaaaa".padEnd(43, "x")}`);
    // B waits as B, and only B's cursor moves.
    const waited = await run(["wait", "--timeout", "0", "--json"], space, [page([message(2, "from A")])], sessionB);
    expect(header(waited.requests[0]!, "authorization")).toBe(`Bearer sni_${"SeatBbbbbb".padEnd(43, "x")}`);
    expect(await cursorOf(space, "i_SeatBbbbbb")).toBe(2);
    expect(await cursorOf(space, "i_SeatAaaaaa")).toBe(1);

    // A session that is neither must say which seat it means.
    const stranger = await run(["say", "who am I", "--json"], space, [], { CLAUDE_SESSION_ID: "session-c" });
    expect(stranger.exitCode).not.toBe(0);
    expect(stranger.requests).toHaveLength(0);
    expect(JSON.parse(stranger.stderr).error.code).toBe("seat_selection_required");
    const chosen = await run(["say", "as B", "--as", "i_SeatBbbbbb", "--json"], space, [{ status: 201, body: { message: message(3, "as B") } }], { CLAUDE_SESSION_ID: "session-c" });
    expect(header(chosen.requests[0]!, "authorization")).toBe(`Bearer sni_${"SeatBbbbbb".padEnd(43, "x")}`);
    const byEnv = await run(["say", "as A", "--json"], space, [{ status: 201, body: { message: message(4, "as A") } }], { CLAUDE_SESSION_ID: "session-c", SHAREDNET_SEAT: "i_SeatAaaaaa" });
    expect(header(byEnv.requests[0]!, "authorization")).toBe(`Bearer sni_${"SeatAaaaaa".padEnd(43, "x")}`);
    // whoami lists both seats and marks the session's own.
    const who = await run(["whoami", "--json"], space, [], sessionB);
    expect(JSON.parse(who.stdout).seat).toMatchObject({
      member_id: "i_SeatBbbbbb",
      seats: [
        { member_id: "i_SeatAaaaaa", this_session: false },
        { member_id: "i_SeatBbbbbb", this_session: true },
      ],
    });
  });

  it("reads a Room file from before seats were separated as one seat with no session tie", async () => {
    const space = await joinedSpace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(space.project, ".sharednet"), { recursive: true });
    await writeFile(
      join(space.project, ".sharednet", "room.json"),
      JSON.stringify({ schema_version: 1, base_url: "https://www.sharednet.ai", room_id: ROOM_ID, member_id: MEMBER_ID, last_sequence: 1 }),
    );
    const result = await run(["wait", "--timeout", "0", "--json"], space, [page([message(2, "still here")])]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items.map((item: any) => item.sequence)).toEqual([2]);
    expect(await cursorOf(space)).toBe(2);
  });

  it("reads the Room as filter, order, window without touching the cursor: grep, sender, tag, last K oldest-first", async () => {
    const space = await joinedSpace();
    const page2 = { status: 200, body: { items: [message(5, "deploy is go"), message(3, "Deploy moved")], next_cursor: "3", has_more: false } };
    const last = await run(["read", "--last", "2", "--grep", "deploy", "--json"], space, [page2]);
    expect(last.exitCode).toBe(0);
    const url = new URL(last.requests[0]!.url);
    expect(url.pathname).toBe(`/api/v1/rooms/${ROOM_ID}/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ order: "desc", limit: "2", q: "deploy" });
    // Asked newest-first, shown oldest-first, and the cursor stays where it was.
    expect(JSON.parse(last.stdout).items.map((item: any) => item.sequence)).toEqual([3, 5]);
    expect(await cursorOf(space)).toBe(1);

    const who = await run(["read", "--from-instance", "i_HostAbcdef", "--from-agent", "default", "--after", "10", "--limit", "5", "--json"], space, [page([])]);
    expect(Object.fromEntries(new URL(who.requests[0]!.url).searchParams)).toEqual({ after: "10", limit: "5", sender_instance_id: "i_HostAbcdef", sender_agent_id: "default" });

    const clash = await run(["read", "--last", "3", "--after", "2", "--json"], space, []);
    expect(clash.exitCode).not.toBe(0);
    expect(clash.requests).toHaveLength(0);
    const badTag = await run(["read", "--from-agent", "reviewer", "--json"], space, []);
    expect(JSON.parse(badTag.stderr).error.code).toBe("invalid_arguments");
  });

  it("says who this machine acts as and which seat this directory holds, and never a secret", async () => {
    const nobody = await run(["whoami", "--json"], await workspace(), []);
    expect(nobody.exitCode).toBe(0);
    expect(JSON.parse(nobody.stdout)).toMatchObject({ base_url: "https://www.sharednet.ai", account: null, seat: null });
    expect(JSON.parse(nobody.stdout).next).toContain("sharednet login");

    const space = await joinedSpace();
    const seated = await run(["whoami", "--json"], space, []);
    expect(seated.requests).toHaveLength(0);
    expect(JSON.parse(seated.stdout)).toMatchObject({
      account: null,
      seat: { room_id: ROOM_ID, member_id: MEMBER_ID, last_sequence: 1, credential_present: true },
    });
    expect(seated.stdout).not.toContain("sni_");
    expect(seated.stdout).not.toContain("rit_");
  });

  it("returns after --timeout 0 with an empty page instead of sitting", async () => {
    const space = await joinedSpace();
    const result = await run(["wait", "--timeout", "0", "--json"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.url).toContain("after=1&timeout=0");
    expect(JSON.parse(result.stdout).items).toEqual([]);
  });

  it("prints plain lines for a hook, and nothing when the Room was quiet", async () => {
    const space = await joinedSpace();
    const quiet = await run(["wait", "--hook"], space, [
      { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    ]);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.requests[0]!.url).toContain("timeout=0");

    const spoken = await run(["wait", "--hook"], space, [
      { status: 200, body: { items: [message(2, "Ship it")], next_cursor: "2", has_more: false } },
    ]);
    expect(spoken.exitCode).toBe(0);
    expect(spoken.stdout).toBe("#2 host: Ship it\n");
  });

  it("tells a directory that never joined what to run", async () => {
    const space = await workspace();
    const result = await run(["say", "hello", "--json"], space, []);

    expect(result.exitCode).toBe(2);
    expect(result.requests).toHaveLength(0);
    expect(JSON.parse(result.stderr).error.code).toBe("not_in_a_room");
  });
});

describe("sharednet credits", () => {
  const PURSE = { principal_id: "p_AbCdEfGhIj", balance: 100, granted: 100, sent: 0, received: 0 };
  const PAYEE = "i_PayeePayee";

  /** A directory holding one seat, the way `join` leaves it. */
  async function seated() {
    const space = await workspace();
    await run(["join", PASTED_INVITE], space, [joined()]);
    return space;
  }

  it("reads the purse through the seat this directory holds", async () => {
    const space = await seated();

    const result = await run(["balance", "--json"], space, [{ body: { credits: PURSE } }]);

    expect(result.exitCode).toBe(0);
    expect(result.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/credits");
    expect(header(result.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
    expect(JSON.parse(result.stdout)).toMatchObject({ balance: 100, as: "seat", seat: { room_id: ROOM_ID, member_id: MEMBER_ID } });
  });

  it("redeems a code as typed, and reports a repeat as nothing granted rather than an error", async () => {
    const space = await seated();

    const result = await run(["redeem", "hack-2026", "--json"], space, [
      { body: { credits: PURSE, granted: 100, transfer: { id: "txn_AbCdEfGhIj" } } },
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual({ code: "hack-2026" });
    expect(JSON.parse(result.stdout).granted).toBe(100);

    const repeat = await run(["redeem", "HACK-2026", "--json"], space, [{ body: { credits: PURSE, granted: 0, transfer: null } }]);
    expect(repeat.exitCode).toBe(0);
    expect(JSON.parse(repeat.stdout).granted).toBe(0);
  });

  it("pays with a fresh idempotency key, and posts a receipt into the Room only when asked", async () => {
    const space = await seated();
    const transfer = { id: "txn_AbCdEfGhIj", amount: 25, to_principal_id: "p_OtherOther" };

    const quiet = await run(["pay", PAYEE, "25", "--memo", "map tiles", "--json"], space, [
      { status: 201, body: { transfer, credits: { ...PURSE, balance: 75, sent: 25 } } },
    ]);
    expect([quiet.exitCode, quiet.stderr]).toEqual([0, ""]);
    expect(quiet.requests).toHaveLength(1);
    expect(quiet.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/credits/transfers");
    expect(JSON.parse(String(quiet.requests[0]!.init.body))).toEqual({ to: PAYEE, amount: 25, memo: "map tiles" });
    expect(header(quiet.requests[0]!, "idempotency-key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.parse(quiet.stdout).receipt).toBeNull();

    const announced = await run(["pay", PAYEE, "25", "--room", "--json"], space, [
      { status: 201, body: { transfer, credits: { ...PURSE, balance: 50, sent: 50 } } },
      { status: 201, body: { message: { id: "msg_AbCdEfGhIj", sequence: 4 } } },
    ]);
    expect(announced.exitCode).toBe(0);
    expect(JSON.parse(String(announced.requests[0]!.init.body))).toMatchObject({ room_id: ROOM_ID });
    expect(announced.requests[1]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}/messages`);
    expect(JSON.parse(String(announced.requests[1]!.init.body)).content).toBe(`Paid 25 credits to ${PAYEE} (txn_AbCdEfGhIj)`);
    // The two writes carry different keys: the payment and the receipt are separate acts.
    expect(header(announced.requests[0]!, "idempotency-key")).not.toBe(header(announced.requests[1]!, "idempotency-key"));
  });

  it.each([
    { failure: "a closed Room", response: { status: 409, body: { error: { code: "room_closed" } } } },
    { failure: "a lost connection", response: { error: new Error("Network unavailable") } },
  ])("keeps a completed payment successful when its receipt fails because of $failure", async ({ response }) => {
    const space = await seated();
    const transfer = {
      id: "txn_AbCdEfGhIj",
      from_principal_id: PURSE.principal_id,
      to_principal_id: "p_OtherOther",
      amount: 25,
      memo: null,
      room_id: ROOM_ID,
      by_instance_id: MEMBER_ID,
      addressed_to: PAYEE,
      code: null,
      created_at: "2026-09-12T10:00:00.000Z",
    };
    const result = await run(["pay", PAYEE, "25", "--room", "--json"], space, [
      { status: 201, body: { transfer, credits: { ...PURSE, balance: 75, sent: 25 } } },
      response,
    ]);

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    const paid = JSON.parse(result.stdout);
    expect(paid.transfer.id).toBe("txn_AbCdEfGhIj");
    expect(paid.credits).toMatchObject({ balance: 75, sent: 25 });
    expect(paid.receipt).toBeNull();
    expect(paid.warning.code).toBe("receipt_not_confirmed");
    expect(paid.warning.message).toMatch(/payment succeeded/i);
    expect(paid.warning.message).toMatch(/do not repeat/i);
    expect(result.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/credits/transfers",
      `/api/v1/rooms/${ROOM_ID}/messages`,
    ]);
  });

  it("reports a refused payment as a failure without trying to post a receipt", async () => {
    const space = await seated();
    const result = await run(["pay", PAYEE, "101", "--room", "--json"], space, [
      { status: 409, body: { error: { code: "insufficient_credits" } } },
    ]);

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("insufficient_credits");
    expect(result.requests.map(({ url }) => new URL(url).pathname)).toEqual(["/api/v1/credits/transfers"]);
  });

  it("refuses a malformed payee, amount or cursor before any request leaves the machine", async () => {
    const space = await seated();

    for (const argv of [
      ["pay", "rom_AbCdEfGhIj", "25"],
      ["pay", PAYEE, "0"],
      ["pay", PAYEE, "2.5"],
      ["pay", PAYEE, "-5"],
      ["pay", PAYEE],
      ["ledger", "--last", "0"],
      ["ledger", "--before", "msg_AbCdEfGhIj"],
      ["redeem"],
    ]) {
      const result = await run(argv, space, []);
      expect(result.exitCode).toBe(2);
      expect(result.requests).toHaveLength(0);
    }
  });

  it("pages the ledger newest first, and says so when the machine is neither seated nor logged in", async () => {
    const space = await seated();

    const result = await run(["ledger", "--last", "2", "--before", "txn_AbCdEfGhIj", "--json"], space, [
      { body: { items: [], next_cursor: null, has_more: false } },
    ]);
    expect(result.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/credits/transfers?limit=2&before=txn_AbCdEfGhIj");

    const bare = await workspace();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bare.project, { recursive: true });
    const nowhere = await run(["balance"], bare, []);
    expect(nowhere.exitCode).toBe(2);
    expect(nowhere.stderr).toContain("not_logged_in");
    expect(nowhere.requests).toHaveLength(0);
  });
});

describe("sharednet files", () => {
  const ARTIFACT_ID = "art_AbCdEfGhIj";
  const LINK_KEY = `afk_${"k".repeat(43)}`;

  async function seated() {
    const space = await workspace();
    await run(["join", PASTED_INVITE], space, [joined()]);
    return space;
  }

  function artifact(overrides: Record<string, unknown> = {}) {
    return {
      id: ARTIFACT_ID,
      principal_id: "p_AbCdEfGhIj",
      uploaded_by_instance_id: MEMBER_ID,
      room_id: ROOM_ID,
      filename: "fix.patch",
      content_type: "text/plain",
      size_bytes: 4,
      sha256: "a".repeat(64),
      created_at: "2026-09-12T10:00:00.000Z",
      ...overrides,
    };
  }

  /** A response carrying bytes, the way the content route answers. */
  function bytes(body: string, filename = "fix.patch") {
    return {
      status: 200,
      raw: new Response(body, {
        headers: {
          "content-type": "text/plain",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "x-sharednet-sha256": createHash("sha256").update(body).digest("hex"),
        },
      }),
    };
  }

  it("uploads bytes with the name in a header, addressed to this directory's Room, and hands back the link", async () => {
    const space = await seated();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(space.project, "fix.patch"), "diff");

    const result = await run(["upload", "fix.patch", "--json"], space, [
      { status: 201, body: { artifact: artifact(), link_key: LINK_KEY, url: `https://www.sharednet.ai/f/${ARTIFACT_ID}?k=${LINK_KEY}` } },
    ]);

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    const request = result.requests[0]!;
    expect(request.url).toBe("https://www.sharednet.ai/api/v1/artifacts");
    expect(header(request, "x-sharednet-filename")).toBe("fix.patch");
    expect(header(request, "x-sharednet-room")).toBe(ROOM_ID);
    expect(header(request, "content-type")).toBe("text/plain");
    expect(header(request, "idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    // The bytes go up as bytes, not as JSON or base64.
    expect(Buffer.from(request.init.body as Uint8Array).toString()).toBe("diff");
    // One kind of file: there is always a link to hand over.
    expect(JSON.parse(result.stdout)).toMatchObject({ url: `https://www.sharednet.ai/f/${ARTIFACT_ID}?k=${LINK_KEY}` });
  });

  it("uploads from a directory that is in no Room: the file is addressed to nobody and still has a link", async () => {
    const space = await workspace();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(space.project, { recursive: true });
    await writeFile(join(space.project, "rows.csv"), "a,b\n");

    const result = await run(
      ["upload", "rows.csv", "--json"],
      space,
      [{ status: 201, body: { artifact: artifact({ room_id: null, filename: "rows.csv" }), link_key: LINK_KEY, url: `https://www.sharednet.ai/f/${ARTIFACT_ID}?k=${LINK_KEY}` } }],
      { SHAREDNET_API_KEY: `snk_${"K".repeat(43)}` },
    );

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(header(result.requests[0]!, "x-sharednet-room")).toBeUndefined();
    expect(JSON.parse(result.stdout).url).toContain(`/f/${ARTIFACT_ID}?k=`);
  });

  it("encodes a Unicode filename into an ASCII HTTP header", async () => {
    const space = await seated();
    const { writeFile } = await import("node:fs/promises");
    const filename = "研究报告.md";
    await writeFile(join(space.project, filename), "diff");
    const result = await run(["upload", filename], space, [{ status: 201, body: { artifact: artifact({ filename }) } }]);
    expect(result.exitCode).toBe(0);
    const request = result.requests[0]!;
    expect(() => new Request(request.url, request.init)).not.toThrow();
    expect(header(request, "x-sharednet-filename*")).toBe(`UTF-8''${encodeURIComponent(filename)}`);
    expect(header(request, "x-sharednet-filename")).toBeUndefined();
  });

  it("refuses an existing dangling symlink without creating its target", async () => {
    const space = await seated();
    const { symlink, lstat } = await import("node:fs/promises");
    const target = join(space.project, "absent-target.patch");
    const destination = join(space.project, "fix.patch");
    await symlink(target, destination);
    const result = await run(["download", ARTIFACT_ID], space, [{ body: { artifact: artifact() } }, bytes("diff")]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("file_exists");
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a downloaded file here, checks the digest, and refuses to overwrite without being told", async () => {
    const space = await seated();
    const { readFile } = await import("node:fs/promises");

    const first = await run(["download", ARTIFACT_ID, "--json"], space, [
      { body: { artifact: artifact() } },
      bytes("diff"),
    ]);
    expect([first.exitCode, first.stderr]).toEqual([0, ""]);
    expect(await readFile(join(space.project, "fix.patch"), "utf8")).toBe("diff");
    const report = JSON.parse(first.stdout);
    expect(report).toMatchObject({ artifact_id: ARTIFACT_ID, size_bytes: 4, verified: true });
    expect(report.path).toBe(join(space.project, "fix.patch"));

    // A second download would clobber it, so it stops and says how to proceed.
    const again = await run(["download", ARTIFACT_ID], space, [{ body: { artifact: artifact() } }, bytes("diff")]);
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toContain("file_exists");
    const forced = await run(["download", ARTIFACT_ID, "--force", "--json"], space, [
      { body: { artifact: artifact() } },
      bytes("newer"),
    ]);
    expect(forced.exitCode).toBe(0);
    expect(await readFile(join(space.project, "fix.patch"), "utf8")).toBe("newer");
  });

  it("opens a link with no credential of its own, and never writes outside the directory it was given", async () => {
    const space = await seated();
    const { readFile } = await import("node:fs/promises");

    const result = await run(
      ["download", `https://www.sharednet.ai/f/${ARTIFACT_ID}?k=${LINK_KEY}`, "--json"],
      space,
      [bytes("a,b\n", "rows.csv")],
    );
    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    // One request, no metadata call, and no Authorization header at all.
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/artifacts/${ARTIFACT_ID}/content?k=${LINK_KEY}`);
    expect(header(result.requests[0]!, "authorization")).toBeUndefined();
    expect(await readFile(join(space.project, "rows.csv"), "utf8")).toBe("a,b\n");

    // A server-supplied name that tries to escape is reduced to its last segment.
    const hostile = await run(["download", `https://www.sharednet.ai/f/${ARTIFACT_ID}?k=${LINK_KEY}`, "--json"], space, [
      bytes("owned", "../../../../tmp/escaped.txt"),
    ]);
    expect(hostile.exitCode).toBe(0);
    expect(JSON.parse(hostile.stdout).path).toBe(join(space.project, "escaped.txt"));
  });

  it("refuses a malformed id, link or option before anything leaves the machine", async () => {
    const space = await seated();

    for (const argv of [
      ["download", "rom_AbCdEfGhIj"],
      ["download", "https://www.sharednet.ai/f/art_AbCdEfGhIj"],
      ["download", "https://www.sharednet.ai/nope?k=afk_x"],
      ["upload", "missing.txt"],
      ["upload"],
      ["files", "--last", "0"],
      ["files", "--before", "msg_AbCdEfGhIj"],
    ]) {
      const result = await run(argv, space, []);
      expect(result.exitCode).toBe(2);
      expect(result.requests).toHaveLength(0);
    }
  });

  it("lists this Room's files when asked, and the account's otherwise", async () => {
    const space = await seated();

    const room = await run(["files", "--room", "--last", "5", "--json"], space, [
      { body: { items: [artifact()], next_cursor: null, has_more: false } },
    ]);
    expect(room.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/artifacts?limit=5&room_id=${ROOM_ID}`);

    const all = await run(["files", "--json"], space, [{ body: { items: [], next_cursor: null, has_more: false } }]);
    expect(all.requests[0]!.url).toBe("https://www.sharednet.ai/api/v1/artifacts?limit=20");
  });
});


describe("compiled Room commands", () => {
  async function joinedSpace() {
    const space = await workspace();
    expect((await run(["join", PASTED_INVITE], space, [joined()])).exitCode).toBe(0);
    return space;
  }
  const state = { protocol_version: "rac/1", sequence: 2, digest: "abc", projection: { work: {} }, obligations: "Review W with evidence", events: [] };
  const accepted = { accepted: true, code: "OK", detail: "admitted", binding: true, seq: 3, digest: "def" };
  it("opens typed state using this seat's credential", async () => {
    const space = await joinedSpace();
    const result = await run(["open", "--json"], space, [{ body: state }]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(state);
    expect(result.requests[0]!.url).toContain(`/rooms/${ROOM_ID}/state`);
    expect(result.requests[0]!.init.headers).toMatchObject({ authorization: `Bearer ${MEMBER_TOKEN}` });
  });
  it("posts a typed envelope unchanged and preserves a semantic refusal's detail", async () => {
    const space = await joinedSpace();
    const envelope = { type: "work.accept", work_id: "W", idempotency_key: "accept-W" };
    const result = await run(["act", "--data", JSON.stringify(envelope), "--json"], space, [{ status: 422, body: { ...accepted, accepted: false, code: "WRONG_ACTOR", detail: "Only the requested assignee may accept W." } }]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("WRONG_ACTOR");
    expect(result.stderr).toContain("Only the requested assignee may accept W.");
    expect(result.stdout).toBe("");
    expect(JSON.parse(String(result.requests[0]!.init.body))).toEqual(envelope);
    expect(result.requests[0]!.url).toContain(`/rooms/${ROOM_ID}/acts`);
  });
  it("uploads the actual file into the Room before delivering its stored artifact ID", async () => {
    const { writeFile } = await import("node:fs/promises");
    const space = await joinedSpace();
    const bytes = Buffer.from("diff --git a/a b/a\n+actual patch\n");
    await writeFile(join(space.project, "fix.patch"), bytes);
    const result = await run(["deliver", "--work", "W", "--name", "patch", "--file", "fix.patch", "--json"], space, [{ body: { artifact: { id: "art_AbCdEfGhIj" } } }, { body: accepted }]);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.requests[0]!.init.body as Uint8Array)).toEqual(bytes);
    expect(result.requests[0]!.init.headers).toMatchObject({ "x-sharednet-room": ROOM_ID, "x-sharednet-filename": "fix.patch" });
    expect(JSON.parse(String(result.requests[1]!.init.body))).toMatchObject({ type: "work.result", work_id: "W", artifacts: { patch: "art_AbCdEfGhIj" } });
    expect(JSON.parse(result.stdout)).toEqual(accepted);
  });
  it("reports a failed upload or refused delivery as failure without a success receipt", async () => {
    const { writeFile } = await import("node:fs/promises");
    const space = await joinedSpace();
    await writeFile(join(space.project, "fix.patch"), "patch");
    for (const responses of [
      [{ status: 403, body: { error: { code: "forbidden" } } }],
      [{ body: { artifact: { id: "art_AbCdEfGhIj" } } }, { status: 422, body: { ...accepted, accepted: false, code: "BAD_STATE", detail: "Accept W first." } }],
    ]) {
      const result = await run(["deliver", "--work", "W", "--name", "patch", "--file", "fix.patch", "--json"], space, responses);
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
    }
  });
  it("rejects malformed multi-file forms before uploading anything", async () => {
    const space = await workspace();
    for (const args of [
      ["--artifact", "patch=a", "--name", "patch", "--file", "b"],
      ["--artifact", "patch=a", "--name", "patch"],
      ["--artifact", "patch=a", "--file", "b"],
      ["--artifact", "patch=a", "--artifact", "patch=b"],
      ["--artifact", "patch=a", "--artifact", " patch =b"],
      ["--artifact", "=a"], ["--artifact", "patch="],
      ["--artifact", " =a"], ["--artifact", "patch= "],
      ["--artifact", "patch"],
      ["--name", " ", "--file", "a"], ["--name", "patch", "--file", " "],
    ]) {
      const result = await run(["deliver", "--work", "W", ...args, "--json"], space, []);
      expect(result.exitCode, JSON.stringify(args)).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe("invalid_arguments");
      expect(result.requests).toHaveLength(0);
    }
  });
  it.each(["upload", "act"])("reports multi-file %s failure without a success receipt or partial result", async (failure) => {
    const { writeFile } = await import("node:fs/promises");
    const space = await joinedSpace();
    await writeFile(join(space.project, "patch.txt"), "patch");
    await writeFile(join(space.project, "report.txt"), "report");
    const result = await run(["deliver", "--work", "W", "--artifact", "patch=patch.txt", "--artifact", "report=report.txt", "--json"], space, [
      { body: { artifact: { id: "art_AbCdEfGhIj" } } },
      ...(failure === "act" ? [{ body: { artifact: { id: "art_0123456789" } } }, { status: 422, body: { ...accepted, accepted: false, code: "BAD_STATE", detail: "Accept W first." } }] : [{ status: 403, body: { error: { code: "forbidden" } } }]),
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.requests).toHaveLength(failure === "upload" ? 2 : 3);
    expect(result.requests.slice(0, 2).every((request) => request.url.endsWith("/artifacts"))).toBe(true);
    if (failure === "act") expect(JSON.parse(String(result.requests[2]!.init.body))).toMatchObject({ artifacts: { patch: "art_AbCdEfGhIj", report: "art_0123456789" } });
  });
  it("puts current personal obligations into each compiled watch invocation", async () => {
    const space = await workspace();
    const admission = joined();
    Object.assign(admission.body.room, { type: "compiled" });
    expect((await run(["join", PASTED_INVITE], space, [admission])).exitCode).toBe(0);
    let input: unknown;
    const result = await run(["watch", "--on", "message", "--run", "driver", "--max-runs", "1", "--json"], space, [page([message(1, "act admitted")]), { body: state }], {}, { exec: async (_command, value) => { input = JSON.parse(value); return { exitCode: 0, stdout: "", stderr: "" }; } });
    expect(result.exitCode).toBe(0);
    expect(input).toMatchObject({ compiled: state });
  });
});


it("includes obligations in a compiled serve command's JSON input", async () => {
  const space = await workspace();
  const admission = joined();
  Object.assign(admission.body.room, { type: "compiled" });
  await run(["join", PASTED_INVITE, "--no-wake"], space, [admission]);
  const state = { protocol_version: "rac/1", sequence: 1, digest: "abc", projection: {}, obligations: "Accept W", events: [] };
  const { exec, calls } = recorder({ exitCode: 0, stdout: "" });
  const result = await run(["serve", "--run", "driver", "--json"], space, [page([message(2, "act admitted")]), { body: state }, revoked()], {}, { exec, service: { delivered_through: 1, acked_through: 1 } });
  expect(result.exitCode).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input).toMatchObject({ compiled: state });
});

it("keeps a compiled command wake pending until its state is available", async () => {
  const space = await workspace();
  const admission = joined();
  Object.assign(admission.body.room, { type: "compiled" });
  await run(["join", PASTED_INVITE, "--no-wake"], space, [admission]);
  const state = { protocol_version: "rac/1", sequence: 1, digest: "abc", projection: {}, obligations: "Accept W", events: [] };
  const { exec, calls } = recorder({ exitCode: 0, stdout: "" });
  const result = await run(["serve", "--run", "driver", "--json"], space, [
    page([message(2, "act admitted")]), { status: 500, body: { error: { code: "internal_error" } } },
    page([message(2, "act admitted")]), { body: state }, revoked(),
  ], {}, { exec, service: { delivered_through: 1, acked_through: 1 } });
  expect(new URL(result.requests[2]!.url).searchParams.get("after")).toBe("1");
  expect(calls).toHaveLength(1);
  expect(result.acks).toEqual([2]);
});

it("does not spend the turn allowance on unavailable compiled state", async () => {
  const space = await workspace();
  const admission = joined([message(1, "Welcome")]);
  Object.assign(admission.body.room, { type: "compiled" });
  const env = { CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "compiled-driver-thread", CODEX_HOME: "/codex-home", PATH: "" };
  await run(["join", PASTED_INVITE], space, [admission], env);
  const addressed = { ...message(2, "@codex review"), mentions: [MEMBER_ID] };
  const state = { protocol_version: "rac/1", sequence: 1, digest: "abc", projection: {}, obligations: "Review W", events: [] };
  const responses = Array.from({ length: 31 }, () => [page([addressed]), page([addressed]), { status: 500, body: { error: { code: "internal_error" } } }]).flat();
  const sleeps: number[] = [];
  let turns = 0;
  const result = await run(["serve", "--json"], space, [...responses, page([addressed]), page([addressed]), { status: 200, body: state }, revoked()], env, {
    service: { delivered_through: 1, acked_through: 1 }, now: () => new Date("2026-10-10T00:00:00Z"),
    sleep: async (ms) => { sleeps.push(ms); },
    runTurn: async () => { turns += 1; return { exitCode: 0, stdout: '{"type":"turn.completed","usage":{}}', stderr: "", timedOut: false }; },
  });
  expect(turns).toBe(1);
  expect(Math.max(...sleeps)).toBe(10_000);
  expect(result.acks).toEqual([2]);
});

it("reads personal compiled state before resuming a seat's own session", async () => {
  const space = await workspace();
  const codeEnv = { CLAUDE_SESSION_ID: "", CODEX_SESSION_ID: "compiled-driver-thread", CODEX_HOME: "/codex-home", PATH: "" };
  const admission = joined([message(1, "Welcome")]);
  Object.assign(admission.body.room, { type: "compiled" });
  await run(["join", PASTED_INVITE], space, [admission], codeEnv);
  const addressed = { ...message(2, "@codex review W"), mentions: [MEMBER_ID] };
  const state = { protocol_version: "rac/1", sequence: 3, digest: "abc", projection: { work: {} }, obligations: "Review W with the current result", events: [] };
  const turns: TurnSpec[] = [];
  const result = await run(["serve", "--json"], space, [page([addressed]), page([addressed]), { body: state }, revoked()], codeEnv, {
    service: { delivered_through: 1, acked_through: 1 },
    runTurn: async (spec) => {
      turns.push(spec);
      return { exitCode: 0, stdout: [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "(no reply)" } }), JSON.stringify({ type: "turn.completed", usage: {} })].join("\n"), stderr: "", timedOut: false };
    },
  });
  expect(result.exitCode).toBe(0);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.input).toContain(state.obligations);
  expect(turns[0]!.input).toContain("sharednet act --data");
  expect(result.requests[2]!.url).toContain(`/rooms/${ROOM_ID}/state`);
  expect(header(result.requests[2]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
});


it.each(["watch", "serve"])("hydrates a legacy compiled credential before %s invokes a driver and remembers the mode", async (verb) => {
  const { writeFile } = await import("node:fs/promises");
  const space = await workspace();
  const admission = joined([message(1, "Welcome")]);
  Object.assign(admission.body.room, { type: "compiled" });
  await run(["join", PASTED_INVITE, "--no-wake"], space, [admission]);
  const file = join(space.env.XDG_CONFIG_HOME!, "sharednet", "rooms", ROOM_ID, `${MEMBER_ID}.json`);
  const credential = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete credential.room_type;
  await writeFile(file, JSON.stringify(credential));
  const state = { protocol_version: "rac/1", sequence: 1, digest: "abc", projection: {}, obligations: "Accept W", events: [] };
  const { exec, calls } = recorder({ exitCode: 0, stdout: "" });
  const mode = roomState("open");
  Object.assign(mode.body.room, { type: "compiled" });
  const command = verb === "watch" ? ["watch", "--on", "message", "--run", "driver", "--max-runs", "1", "--json"] : ["serve", "--run", "driver", "--json"];
  const responses = [mode, page([message(2, "act admitted")]), { body: state }, ...(verb === "serve" ? [revoked()] : [])];
  const result = await run(command, space, responses, {}, { exec, service: { delivered_through: 1, acked_through: 1 } });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.requests[0]!.url).toBe(`https://www.sharednet.ai/api/v1/rooms/${ROOM_ID}`);
  expect(header(result.requests[0]!, "authorization")).toBe(`Bearer ${MEMBER_TOKEN}`);
  expect(calls[0]!.input).toMatchObject({ compiled: state });
  expect(JSON.parse(await readFile(file, "utf8")).room_type).toBe("compiled");
  // A later watch needs only its new messages and per-seat state, no second mode request.
  const again = await run(["watch", "--on", "message", "--run", "driver", "--max-runs", "1", "--json"], space, [page([message(3, "next act")]), { body: state }], {}, { exec, service: { delivered_through: 2, acked_through: 2 } });
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.requests).toHaveLength(2);
});
