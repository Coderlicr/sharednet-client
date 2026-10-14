// Real CLI processes against a loopback stand-in for the service: what a unit test with a scripted
// fetch cannot show, such as a caller that is actually blocked in `wait` and then continues, a
// socket that stalls or drops, and a process killed mid-wait. First written by Dots for this
// repository's PR 4; adapted to the server-side filter (SharedNet #140) and to a wake that hands
// over everything said since the cursor (SharedNet #178), to the seat's place kept by the service
// (#183), to mentions (#186), and to a seat that is woken by resuming its own session (#191).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "packages/cli/bin/sharednet.js");
const roomId = "rom_LocalRoom1";
const readerId = "i_Reader0001";
const targetId = "i_Target0001";
const otherId = "i_Other00001";
const drivenId = "i_Driven0001";
const page = (items) => ({ items, next_cursor: null, has_more: false });

before(async () => {
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "packages/cli/tsconfig.build.json"], { cwd: root });
});

async function fixture(t, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "sharednet-wait-e2e-"));
  const messages = [];
  const pending = new Set();
  const requests = [];
  const reads = [];
  const children = new Set();
  const seatId = options.legacy ? "mem_Reader0001" : readerId;
  let setupRequests = 0;
  let stall = false;
  let disconnect = false;
  // Each seat's place, as the service keeps it: what it was handed, and what it has handled.
  const places = new Map();
  const placeOf = (request) => {
    const token = request.headers.authorization ?? "";
    if (!places.has(token)) places.set(token, { delivered_through: 0, acked_through: 0 });
    return places.get(token);
  };
  const seatIds = { reader: seatId, target: targetId, other: otherId, driven: drivenId };
  const answer = (response, body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname.endsWith("/join")) {
      const id = seatIds[body.name] ?? seatId;
      answer(response, { room: { id: roomId }, membership: { member_id: id }, member_token: `sni_${id.padEnd(43, "X")}`, history: page(messages) });
    } else if (url.pathname === "/api/v1/instances/current" || url.pathname === "/api/v1/instances/current/heartbeat") {
      setupRequests += 1;
      // Deliberately hold identity/lease setup open to test the client deadline.
    } else if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const token = request.headers.authorization;
      const senderId = [targetId, otherId, drivenId].find((id) => token.includes(id)) ?? readerId;
      // As the service does: the seats a line addresses by @name or @id, never the speaker.
      const mentions = Object.entries(seatIds)
        .filter(([name, id]) => id !== senderId && new RegExp(`@(?:${name}|${id})\\b`).test(body.content))
        .map(([, id]) => id);
      const message = { id: `msg_${String(messages.length + 1).padStart(10, "0")}`, sequence: messages.length + 1, content: body.content, mentions, sender: { member_id: senderId, kind: "instance", name: "same display name" } };
      messages.push(message);
      answer(response, { message });
      for (const waiter of pending) waiter.flush();
    } else if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      // The read a filtered wake makes: everything after the cursor, unfiltered, oldest first.
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      reads.push({ after, limit, filtered: url.searchParams.has("sender_instance_id") || url.searchParams.has("q") });
      const rest = messages.filter((message) => message.sequence > after);
      answer(response, { items: rest.slice(0, limit), next_cursor: null, has_more: rest.length > limit });
    } else if (request.method === "GET" && url.pathname.endsWith("/subscription")) {
      answer(response, { subscription: { room_id: roomId, ...placeOf(request) } });
    } else if (request.method === "POST" && url.pathname.endsWith("/ack")) {
      const place = placeOf(request);
      place.acked_through = Math.min(Math.max(place.acked_through, Number(body.through) || 0), messages.length);
      place.delivered_through = Math.max(place.delivered_through, place.acked_through);
      answer(response, { subscription: { room_id: roomId, ...place } });
    } else if (url.pathname.endsWith("/wait")) {
      const sender = url.searchParams.get("sender_instance_id");
      const mentioned = url.searchParams.get("mentions");
      const place = placeOf(request);
      requests.push({ after: Number(url.searchParams.get("after")), timeout: Number(url.searchParams.get("timeout")), sender });
      if (disconnect) { request.socket.destroy(); return; }
      const after = requests.at(-1).after;
      const waiter = { flush() {
        // As the service does: a filtered wait answers only when a matching message is there.
        const fresh = messages.filter((message) => message.sequence > after && (sender === null || message.sender.member_id === sender) && (mentioned === null || message.mentions.includes(mentioned)));
        if (!stall && fresh.length) {
          pending.delete(waiter);
          clearTimeout(timer);
          place.delivered_through = Math.max(place.delivered_through, fresh.at(-1).sequence);
          answer(response, page(fresh));
        }
      } };
      const timer = setTimeout(() => {
        if (!stall) { pending.delete(waiter); answer(response, page([])); }
      }, requests.at(-1).timeout * 1000);
      pending.add(waiter);
      response.on("close", () => { clearTimeout(timer); pending.delete(waiter); });
      waiter.flush();
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state"), SHAREDNET_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const projects = {};
  for (const name of ["reader", "target", "other"]) {
    projects[name] = join(scratch, name);
    await mkdir(projects[name]);
    await exec(process.execPath, [cli, "join", roomId, "--token", `rit_${"T".repeat(43)}`, "--name", name, "--json"], { cwd: projects[name], env, timeout: 5000 });
  }
  if (options.session) {
    const { getStoragePaths, writeSession } = await import("../packages/cli/dist/storage.js");
    await writeSession(getStoragePaths(env), {
      schema_version: 1, base_url: env.SHAREDNET_BASE_URL, principal_id: "p_Local00001", agent_id: null,
      instance_id: readerId, local_instance_key: null, instance_token: `sni_${"S".repeat(43)}`,
      created_at: "2026-01-01T00:00:00.000Z", lease_expires_at: "2026-01-01T00:01:00.000Z", expires_at: null,
    });
  }
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  return {
    env,
    projects,
    messages,
    requests,
    reads,
    setupRequests: () => setupRequests,
    stall(value) { stall = value; },
    disconnect(value) { disconnect = value; },
    async polls(count) {
      const deadline = Date.now() + 5000;
      while (requests.length < count && Date.now() < deadline) await delay(10);
      assert.ok(requests.length >= count, "waiting CLI never issued its long-poll");
    },
    async say(name, content) {
      await exec(process.execPath, [cli, "say", content, "--json"], { cwd: projects[name], env, timeout: 5000 });
    },
    async cursor() {
      return JSON.parse(await readFile(join(projects.reader, ".sharednet/room.json"), "utf8")).seats[seatId].last_sequence;
    },
    wait(...args) {
      const child = spawn(process.execPath, [cli, "wait", "--from-instance", targetId, "--json", ...args], { cwd: projects.reader, env });
      children.add(child);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
      });
      return { child, done };
    },
  };
}

test("a blocked CLI wakes only for the target, and hands over what others said before it", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.say("target", "old target message");
  const consumed = await f.wait("--timeout", "0").done;
  assert.equal(JSON.parse(consumed.stdout).items[0].content, "old target message");
  const waiting = f.wait("--timeout", "5");
  let continued = false;
  const continuation = waiting.done.then((result) => { continued = true; return result; });
  await f.polls(2);
  // Someone else speaking, and the reader itself, do not wake a wait narrowed to the target.
  await f.say("other", "unrelated");
  await f.say("reader", "self");
  await delay(300);
  assert.equal(continued, false);
  assert.equal(f.requests.length, 2);
  await f.say("target", "new target message; $(touch SHOULD_NOT_EXIST)");
  const result = await continuation;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(continued, true);
  // The target woke it; what the other member said came along, because the cursor moved past it.
  // The reader's own words never come back.
  assert.deepEqual(JSON.parse(result.stdout).items.map(({ sequence, content }) => ({ sequence, content })), [
    { sequence: 2, content: "unrelated" },
    { sequence: 4, content: "new target message; $(touch SHOULD_NOT_EXIST)" },
  ]);
  assert.equal(await f.cursor(), 4);
  assert.deepEqual(f.requests.map(({ after, sender }) => ({ after, sender })), [{ after: 0, sender: targetId }, { after: 1, sender: targetId }]);
  assert.deepEqual(f.reads.map(({ after, filtered }) => ({ after, filtered })), [{ after: 0, filtered: false }, { after: 1, filtered: false }]);
});

test("client deadline cancels a stalled server request", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.stall(true);
  const waiting = f.wait("--timeout", "1");
  await f.polls(1);
  const result = await waiting.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items, []);
  assert.equal(await f.cursor(), 0);
});

test("deadline also bounds a stalled legacy-seat identity lookup", { timeout: 7000 }, async (t) => {
  const f = await fixture(t, { legacy: true });
  const waiting = f.wait("--timeout", "1");
  const result = await Promise.race([waiting.done, delay(3000).then(() => ({ code: "still blocked" }))]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items, []);
  assert.equal(f.setupRequests(), 1);
  assert.equal(await f.cursor(), 0);
});

test("deadline also bounds stalled account lease refresh with an explicit failure", { timeout: 7000 }, async (t) => {
  const f = await fixture(t, { session: true });
  const waiting = f.wait("--timeout", "1");
  const result = await Promise.race([waiting.done, delay(3000).then(() => ({ code: "still blocked" }))]);
  assert.equal(result.code, 5, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, "service_unavailable");
  assert.equal(f.setupRequests(), 1);
  assert.equal(await f.cursor(), 0);
});

test("disconnect and process cancellation preserve restart recovery", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.disconnect(true);
  const failed = await f.wait("--timeout", "2").done;
  assert.equal(failed.code, 5);
  assert.equal(await f.cursor(), 0);
  f.disconnect(false);
  const cancelled = f.wait();
  await f.polls(2);
  cancelled.child.kill("SIGTERM");
  assert.equal((await cancelled.done).signal, "SIGTERM");
  assert.equal(await f.cursor(), 0);
  await f.say("target", "arrived while caller was disconnected");
  const resumed = await f.wait("--timeout", "2").done;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).items[0].content, "arrived while caller was disconnected");
  assert.equal(await f.cursor(), 1);
});

test("a seat joined from inside a Codex session is resumed when addressed, and its answer is posted", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  // A stand-in for Codex: it answers with what it was resumed with, so the test sees both.
  const harness = join(f.projects.reader, "..", "harness-bin");
  await mkdir(harness);
  await writeFile(
    join(harness, "codex"),
    `#!${process.execPath}
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk)).on("end", () => {
  const resumed = args[0] === "exec" && args[1] === "resume" && args.at(-1) === "-";
  const lines = prompt.split("\\n").filter((line) => line.startsWith("#")).join(" | ");
  const said = resumed ? "resumed " + args.at(-2) + ": " + lines : "not a resume: " + args.join(" ");
  for (const event of [{ type: "item.completed", item: { type: "agent_message", text: said } }, { type: "turn.completed", usage: {} }]) console.log(JSON.stringify(event));
});
`,
    { mode: 0o755 },
  );
  // A real Codex keeps the thread's rollout under CODEX_HOME (here HOME/.codex); serve's start check
  // looks for it before it drives the seat.
  const rollouts = join(f.env.HOME, ".codex", "sessions", "2026", "10", "13");
  await mkdir(rollouts, { recursive: true });
  await writeFile(join(rollouts, "rollout-2026-10-13T00-00-00-thread-0001.jsonl"), "{}\n");
  const project = join(f.projects.reader, "..", "driven");
  await mkdir(project);
  const env = { ...f.env, PATH: `${harness}:${f.env.PATH}`, CODEX_SESSION_ID: "thread-0001" };
  const joined = JSON.parse(
    (await exec(process.execPath, [cli, "join", roomId, "--token", `rit_${"T".repeat(43)}`, "--name", "driven", "--json"], { cwd: project, env, timeout: 5000 })).stdout,
  );
  try {
    // The join remembered the session and started the wake service, which now sits on the seat.
    assert.equal(joined.wake.service, "started", JSON.stringify(joined.wake));
    assert.equal(joined.wake.session, "thread-0001");
    await f.say("other", "the build is green");
    await f.say("target", "@driven what is left?");
    let answer;
    for (let attempt = 0; attempt < 200 && !answer; attempt += 1) {
      await delay(100);
      answer = f.messages.find((message) => message.sender.member_id === drivenId);
    }
    assert.ok(answer, "the addressed seat's session was never resumed");
    // The same thread, resumed with everything said since the join, and its last words posted for it.
    assert.match(answer.content, /^resumed thread-0001: /);
    assert.match(answer.content, /#\d+ same display name: the build is green \| #\d+ same display name: @driven what is left\?$/);
  } finally {
    await exec(process.execPath, [cli, "serve", "--stop", "--json"], { cwd: project, env, timeout: 5000 }).catch(() => undefined);
    try { process.kill(joined.wake.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});
