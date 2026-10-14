// @vitest-environment node

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-login-"));
  cleanup.push(root);
  return {
    root,
    project: join(root, "project"),
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      SHAREDNET_BASE_URL: "http://127.0.0.1:3001",
      CODEX_SESSION_ID: "session-stays-local",
    } as Record<string, string>,
  };
}

const API_KEY = `snk_${"k".repeat(43)}`;

describe("sharednet login", () => {
  it("names only the seats this machine holds for this origin; a seat of another SharedNet is never sent here", async () => {
    const space = await workspace();
    const { getStoragePaths, writeRoomCredential } = await import("./storage.ts");
    const paths = getStoragePaths(space.env);
    const seat = (baseUrl: string, roomId: string, memberId: string, token: string) =>
      writeRoomCredential(paths, { schema_version: 1, base_url: baseUrl, room_id: roomId, member_id: memberId, name: "claude-code", member_token: token, joined_at: "2026-09-08T00:00:00.000Z" });
    const here = `sni_${"h".repeat(43)}`;
    const elsewhere = `sni_${"e".repeat(43)}`;
    await seat("http://127.0.0.1:3001", "rom_HereAbcdef", "i_HereAbcdef", here);
    await seat("https://other.example", "rom_ThereAbcde", "i_ThereAbcde", elsewhere);

    const requests: Array<{ url: string; body: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), body: String(init.body ?? "") });
      // The first answer starts the login; the second approves it.
      const body =
        requests.length === 1
          ? { login: { id: "cli_AbCdEfGhIj", expires_at: "2099-01-01T00:00:00.000Z", bind_instance_ids: ["i_HereAbcdef"] }, user_code: "ABCD-EFGH", poll_token: `clp_${"p".repeat(43)}`, verify_url: "http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH", interval_seconds: 3 }
          : { state: "approved", login: { id: "cli_AbCdEfGhIj", bind_instance_ids: ["i_HereAbcdef"] }, api_key: API_KEY, api_key_id: "key_AbCdEfGhIj", principal: { id: "p_AbCdEfGhIj", display_name: null, created_at: "2026-09-06T00:00:00.000Z", invited_by_principal_id: null } };
      return new Response(JSON.stringify(body), { status: requests.length === 1 ? 201 : 200, headers: { "content-type": "application/json" } });
    });
    const exitCode = await runCli(["login", "--no-browser", "--json"], {
      cwd: space.project,
      env: space.env,
      fetch,
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
    });
    expect(exitCode).toBe(0);
    const started = JSON.parse(requests[0]!.body);
    expect(started.seats).toEqual([here]);
    expect(JSON.stringify(requests)).not.toContain(elsewhere);
  });

  it("shows the code and URL, opens the browser, polls until approved, and keeps the key in the credential file", async () => {
    const space = await workspace();
    const responses = [
      {
        status: 201,
        body: {
          login: { id: "cli_AbCdEfGhIj", expires_at: "2099-01-01T00:00:00.000Z", bind_instance_ids: [] },
          user_code: "ABCD-EFGH",
          poll_token: `clp_${"p".repeat(43)}`,
          verify_url: "http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH",
          interval_seconds: 3,
        },
      },
      { status: 200, body: { state: "pending", login: { id: "cli_AbCdEfGhIj" } } },
      {
        status: 200,
        body: {
          state: "approved",
          login: { id: "cli_AbCdEfGhIj", bind_instance_ids: [] },
          api_key: API_KEY,
          api_key_id: "key_AbCdEfGhIj",
          principal: { id: "p_AbCdEfGhIj", display_name: "Xisen", created_at: "2026-09-06T00:00:00.000Z", invited_by_principal_id: null },
        },
      },
    ];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected fetch");
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    });
    const opened: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sleeps: number[] = [];

    const exitCode = await runCli(["login", "--label", "laptop", "--json"], {
      env: space.env,
      fetch,
      cwd: space.project,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      openBrowser: async (url) => {
        opened.push(url);
        return true;
      },
    });

    expect(exitCode).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/cli/logins",
      "http://127.0.0.1:3001/api/v1/cli/logins/cli_AbCdEfGhIj/poll",
      "http://127.0.0.1:3001/api/v1/cli/logins/cli_AbCdEfGhIj/poll",
    ]);
    // Starting a login sends no credential; polling sends the poll token.
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ label: "laptop" });
    expect((requests[1]!.init.headers as Record<string, string>).authorization).toBe(`Bearer clp_${"p".repeat(43)}`);
    expect(opened).toEqual(["http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH"]);
    expect(sleeps).toEqual([3000]);
    expect(stderr.join("")).toContain("ABCD-EFGH");
    expect(stderr.join("")).toContain("http://127.0.0.1:3001/cli/authorize?code=ABCD-EFGH");

    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual({
      principal_id: "p_AbCdEfGhIj",
      api_key_id: "key_AbCdEfGhIj",
      bound_instance_ids: [],
      credentials_file: join(space.env.XDG_CONFIG_HOME!, "sharednet", "credentials.json"),
    });
    expect(stdout.join("")).not.toContain("snk_");
    expect(stderr.join("")).not.toContain("snk_");

    const credentialsFile = join(space.env.XDG_CONFIG_HOME!, "sharednet", "credentials.json");
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsFile, "utf8"))).toMatchObject({
      base_url: "http://127.0.0.1:3001",
      principal_id: "p_AbCdEfGhIj",
      api_key_id: "key_AbCdEfGhIj",
      api_key: API_KEY,
      expires_at: null,
    });
  });

  it("writes the credential under the machine's credential lock, so it never lands inside another command's read-and-replace", async () => {
    const space = await workspace();
    const { getStoragePaths, readStoredApiCredential } = await import("./storage.ts");
    const { storeAccountCredential, withCredentialLock } = await import("./login.ts");
    const paths = getStoragePaths(space.env);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const other = withCredentialLock(paths, async () => { locked(); await gate; });
    await holding;
    const stored = storeAccountCredential(paths, "http://127.0.0.1:3001", { principal: { id: "p_LoCkEd0001" }, api_key_id: "key_LoCkEd0001", api_key: API_KEY }, new Date());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readStoredApiCredential(paths)).toBeNull();
    release();
    await Promise.all([other, stored]);
    expect((await readStoredApiCredential(paths))?.principal_id).toBe("p_LoCkEd0001");
  });

});
