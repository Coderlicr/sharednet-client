// @vitest-environment node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { getStoragePaths, writeProjectRoomState, writeRoomCredential } from "./storage.ts";

it.each([false, true])("serializes real consumers across Rooms and refuses uncertain crash recovery (crash=%s)", async crash => {
  const root = await mkdtemp(join(tmpdir(), "trigger-process-"));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const seat = "i_AbCdEfGhIj", rooms = ["rom_AbCdEfGhIj", "rom_KlMnOpQrSt"];
  let starts = 0, enrollments = 0;
  let releaseFirst: ServerResponse | undefined;
  let signalFirst!: () => void;
  const firstTurn = new Promise<void>(resolve => { signalFirst = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === "/turn") {
      starts++;
      if (starts === 1) { releaseFirst = res; signalFirst(); }
      else res.end("(no reply)");
      return;
    }
    const room = req.url?.match(/\/rooms\/(rom_[A-Za-z0-9]+)/)?.[1];
    const index = rooms.indexOf(room ?? "");
    const wake = { id: `wak_${String(index).padStart(10, "0")}`, room_id: room, target_instance_id: seat, source_message_id: "msg_AbCdEfGhIj", source_sequence: 1, source_is_human: true, state: "pending", reasons: [{ kind: "mention" }], created_at: "2026-10-11T00:00:00Z" };
    let body: unknown = {};
    if (req.url?.endsWith("/wake-mode")) { enrollments++; body = { protocol: "trigger-wakes-v1", executor_epoch: 1 }; }
    if (req.url?.includes("/wakes?")) body = { items: [wake], next_cursor: null };
    if (req.url?.endsWith("/claim")) body = { wake: { ...wake, state: "claimed" }, receipt: "process-test-receipt" };
    if (req.url?.endsWith("/start")) body = { wake: { ...wake, state: "start_authorized" }, receipt: "process-test-receipt" };
    if (req.url?.includes("/messages?")) body = { items: [{ id: "msg_AbCdEfGhIj", sequence: 1, content: "test" }] };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  const origin = `http://127.0.0.1:${address.port}`;
  const command = join(root, "adapter.mjs");
  await writeFile(command, `#!${process.execPath}\nprocess.stdin.resume();\nconsole.log(await (await fetch(${JSON.stringify(origin + "/turn")})).text());\n`, { mode: 0o700 });
  const children: ReturnType<typeof spawn>[] = [];
  const start = (index: number) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url)), "trigger", "serve", "--headless", "--once", "--as", seat, "--json"], { cwd: join(root, String(index)), env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = ""; child.stdout?.on("data", data => { output += String(data); }); child.stderr?.on("data", data => { output += String(data); });
    return new Promise<{ code: number | null; output: string }>(resolve => child.on("exit", code => resolve({ code, output })));
  };
  try {
    for (const [index, room] of rooms.entries()) {
      await writeRoomCredential(getStoragePaths(env), { schema_version: 1, base_url: origin, room_id: room, member_id: seat, name: "test", member_token: `sni_${"T".repeat(43)}`, joined_at: "2026-10-11T00:00:00Z", wake: { driver: "command", command, cwd: root } });
      await writeProjectRoomState(join(root, String(index)), { schema_version: 1, base_url: origin, room_id: room, member_id: seat, last_sequence: 0 });
    }
    const first = start(0); await firstTurn;
    if (crash) {
      children[0]!.kill("SIGKILL");
      await first;
      const restarted = await start(1);
      expect(restarted.code).not.toBe(0);
      expect(restarted.output).toContain("needs_reconciliation");
      expect(starts).toBe(1);
      expect(enrollments).toBe(1);
      return;
    }
    const sessions = join(getStoragePaths(env).stateDir, "trigger-sessions");
    const sessionRoot = join(sessions, (await readdir(sessions))[0]!);
    let watcher: ReturnType<typeof watch>;
    const waiting = new Promise<void>(resolve => {
      watcher = watch(sessionRoot, (_event, filename) => { if (String(filename).startsWith("task-candidate-")) resolve(); });
    });
    const second = start(1); await waiting; watcher!.close();
    expect(starts).toBe(1);
    expect(enrollments).toBe(1);
    releaseFirst!.end("(no reply)");
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(starts).toBe(2);
  } finally {
    releaseFirst?.end("(no reply)");
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
