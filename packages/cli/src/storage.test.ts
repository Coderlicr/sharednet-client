// @vitest-environment node

import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backupStoredApiCredential,
  getOrCreateInstallationSecret,
  getStoragePaths,
  listSessions,
  readStoredApiCredential,
  writeSession,
  writeStoredApiCredential,
  type StoredApiCredential,
} from "./storage.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-cli-test-"));
  cleanup.push(root);
  return root;
}

describe("secure local state", () => {
  it("creates session directories as 0700 and files as 0600", async () => {
    const root = await fixtureRoot();
    const paths = getStoragePaths({
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });

    await writeSession(paths, {
      schema_version: 1,
      base_url: "https://www.sharednet.ai",
      principal_id: "p_demo",
      agent_id: "a_default",
      instance_id: "i_one",
      local_instance_key: "local-one",
      instance_token: "sni_super-secret",
      created_at: "2026-09-04T00:00:00.000Z",
      lease_expires_at: "2026-09-04T00:01:30.000Z",
      expires_at: "2026-09-05T00:00:00.000Z",
    });

    expect((await stat(paths.sessionsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.sessionsDir, "i_one.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect(await listSessions(paths)).toMatchObject([{ instance_id: "i_one", agent_id: "a_default" }]);
  });

  it("rejects credential symlinks and permissive credential files", async () => {
    const root = await fixtureRoot();
    const paths = getStoragePaths({
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    const target = join(root, "credential-target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, paths.credentialsFile);

    await expect(readStoredApiCredential(paths)).rejects.toMatchObject({
      code: "unsafe_credential_storage",
    });

    await (await import("node:fs/promises")).unlink(paths.credentialsFile);
    await writeFile(paths.credentialsFile, "{}", { mode: 0o644 });
    await chmod(paths.credentialsFile, 0o644);
    await expect(readStoredApiCredential(paths)).rejects.toMatchObject({
      code: "unsafe_credential_storage",
    });
  });

  it("finds sessions by local key without putting provider ids in filenames or files", async () => {
    const root = await fixtureRoot();
    const paths = getStoragePaths({
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });
    await writeSession(paths, {
      schema_version: 1,
      base_url: "http://127.0.0.1:3001",
      principal_id: "p_demo",
      agent_id: "a_default",
      instance_id: "i_two",
      local_instance_key: "hmac-only",
      instance_token: "sni_secret",
      created_at: "2026-09-04T00:00:00.000Z",
      lease_expires_at: "2026-09-04T00:01:30.000Z",
      expires_at: "2026-09-05T00:00:00.000Z",
    });

    const serialized = await readFile(join(paths.sessionsDir, "i_two.json"), "utf8");
    expect(serialized).not.toContain("CODEX_SESSION_ID");
    expect((await listSessions(paths)).map((session) => session.instance_id)).toEqual([
      "i_two",
    ]);
  });

  it("elects one installation secret during concurrent first use", async () => {
    const root = await fixtureRoot();
    const paths = getStoragePaths({
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });

    const secrets = await Promise.all(
      Array.from({ length: 16 }, () => getOrCreateInstallationSecret(paths)),
    );

    expect(new Set(secrets)).toHaveLength(1);
    expect(Buffer.from(secrets[0]!, "base64url")).toHaveLength(32);
    expect((await stat(paths.installationFile)).mode & 0o777).toBe(0o600);
  });

  it("backs a credential up byte for byte, owner-only, without overwriting an earlier copy", async () => {
    const root = await fixtureRoot();
    const paths = getStoragePaths({
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
    });
    // Synthetic values only.
    const credential = (principal: string): StoredApiCredential => ({
      schema_version: 1, base_url: "https://www.sharednet.ai", principal_id: principal, api_key_id: `key_${principal}`,
      api_key: `snk_synthetic_${principal}`, installation_secret: "synthetic-installation", created_at: "2026-10-12T00:00:00.000Z", expires_at: null,
    });

    expect(await backupStoredApiCredential(paths, new Date())).toBeNull();
    await writeStoredApiCredential(paths, credential("p_first"));
    const before = await readFile(paths.credentialsFile);
    const at = new Date("2026-10-12T08:30:07.123Z");
    const first = await backupStoredApiCredential(paths, at);
    const second = await backupStoredApiCredential(paths, at);
    expect(first).toBe(`${paths.credentialsFile}.bak-2026-10-12T08-30-07-123Z`);
    expect(second).toBe(`${paths.credentialsFile}.bak-2026-10-12T08-30-07-123Z-1`);
    for (const copy of [first!, second!]) {
      expect(await readFile(copy)).toEqual(before);
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
    }
    await writeStoredApiCredential(paths, credential("p_next"));
    expect(await readFile(first!)).toEqual(before);
  });

});
