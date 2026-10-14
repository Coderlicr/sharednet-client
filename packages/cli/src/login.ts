import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { ApiClient, resolveBaseUrl, sameOrigin } from "./api-client.ts";
import { withControlLock } from "./board-controls.ts";
import { CliError, localError } from "./errors.ts";
import {
  getOrCreateInstallationSecret,
  getStoragePaths,
  readRoomCredential,
  writeStoredApiCredential,
  type StoragePaths,
  type StoredApiCredential,
} from "./storage.ts";

/**
 * `sharednet login`: a device-style approval. The CLI starts a login, shows a
 * code and a URL, the human approves it in the Web, and the CLI polls until
 * it is handed an API key minted at that moment. Any anonymous seats this
 * machine holds are sent as proof of possession so the approval binds their
 * Principals to the account. Decision 2026-09-06 §3.
 */

type Environment = Record<string, string | undefined>;

export interface LoginDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Opens a URL in the human's browser; the default shells out. */
  openBrowser?: (url: string) => Promise<boolean>;
}

interface StartPayload {
  login: { id: string; expires_at: string; bind_instance_ids: string[] };
  user_code: string;
  poll_token: string;
  verify_url: string;
  interval_seconds: number;
}

type PollPayload =
  | { state: "pending"; login: { id: string } }
  | {
      state: "approved";
      login: { id: string; bind_instance_ids: string[] };
      api_key: string;
      api_key_id: string;
      principal: { id: string; display_name: string | null };
    };

const VALUE_OPTIONS = new Set(["label"]);
const FLAG_OPTIONS = new Set(["no-browser"]);

function parseLoginArguments(args: string[]): { label?: string; openBrowser: boolean } {
  let label: string | undefined;
  let openBrowser = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      throw localError("invalid_arguments", "Usage: sharednet login [--label <where>] [--no-browser]");
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (FLAG_OPTIONS.has(name)) {
      if (separator !== -1) throw localError("invalid_option", `The --${name} option does not accept a value.`);
      openBrowser = false;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw localError("unknown_option", "The command contains an unknown option.");
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) throw localError("missing_option_value", `The --${name} option requires a value.`);
    label = value;
  }
  return { label, openBrowser };
}

async function defaultOpenBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  return new Promise((resolve) => {
    try {
      const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Every seat token this machine holds, so approval can bind their Principals. */
/**
 * The seat tokens this machine holds for one SharedNet origin. A seat of
 * another origin is never named to this one: a token is proof of possession
 * to the server that issued it, and nothing to any other.
 */
async function heldSeatTokens(paths: StoragePaths, baseUrl: string): Promise<string[]> {
  let roomDirs: string[];
  try {
    roomDirs = await readdir(paths.roomsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const tokens: string[] = [];
  for (const roomId of roomDirs) {
    if (!/^rom_[A-Za-z0-9]+$/.test(roomId)) continue;
    let files: string[];
    try {
      files = await readdir(join(paths.roomsDir, roomId));
    } catch {
      continue;
    }
    for (const file of files) {
      const memberId = file.replace(/\.json$/, "");
      if (!/^(?:i|mem)_[A-Za-z0-9]+$/.test(memberId)) continue;
      const credential = await readRoomCredential(paths, roomId, memberId).catch(() => null);
      if (
        credential &&
        sameOrigin(credential.base_url, baseUrl) &&
        /^(?:sni|rmt)_[A-Za-z0-9_-]{43}$/.test(credential.member_token)
      ) {
        tokens.push(credential.member_token);
      }
    }
  }
  return tokens.slice(0, 50);
}

/**
 * The one lock every writer of this machine's credential file takes, so that
 * a read, a decision and a write by one command cannot interleave with a
 * write by another (`login`, or a claim in a second session).
 */
export function withCredentialLock<T>(paths: StoragePaths, work: () => Promise<T>): Promise<T> {
  return withControlLock({ root: paths.configDir }, "credential", work);
}

/** The credential a login or claim result becomes; the installation secret is the machine's, kept across accounts. */
export async function accountCredentialFrom(
  paths: StoragePaths,
  baseUrl: string,
  result: { principal: { id: string }; api_key_id: string; api_key: string },
  now: Date,
): Promise<StoredApiCredential> {
  return {
    schema_version: 1,
    base_url: baseUrl,
    principal_id: result.principal.id,
    api_key_id: result.api_key_id,
    api_key: result.api_key,
    installation_secret: await getOrCreateInstallationSecret(paths),
    created_at: now.toISOString(),
    expires_at: null,
  };
}

/** The key stays in the credential file, owner-only; the terminal sees only ids. */
export async function storeAccountCredential(
  paths: StoragePaths,
  baseUrl: string,
  result: { principal: { id: string }; api_key_id: string; api_key: string },
  now: Date,
): Promise<void> {
  await withCredentialLock(paths, async () => {
    await writeStoredApiCredential(paths, await accountCredentialFrom(paths, baseUrl, result, now));
  });
}

export async function login(args: string[], dependencies: LoginDependencies): Promise<unknown> {
  const { label, openBrowser } = parseLoginArguments(args);
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);
  const seats = await heldSeatTokens(paths, baseUrl);

  const started = await client.request<StartPayload>("POST", "/cli/logins", "", {
    label: label ?? hostname() ?? null,
    ...(seats.length > 0 ? { seats } : {}),
  });
  if (!started?.login?.id || !started.user_code || !started.poll_token || !started.verify_url) {
    throw new CliError("invalid_server_response", "The SharedNet service returned an invalid response.", 5);
  }

  dependencies.stderr(
    `Approve this terminal in your browser.\n\n  Code:  ${started.user_code}\n  Open:  ${started.verify_url}\n\n` +
      (started.login.bind_instance_ids.length > 0
        ? `Approval also binds ${started.login.bind_instance_ids.length} seat(s) this machine holds to your account.\n\n`
        : ""),
  );
  if (openBrowser) {
    const opened = await (dependencies.openBrowser ?? defaultOpenBrowser)(started.verify_url);
    if (!opened) dependencies.stderr("Could not open a browser; open the URL yourself.\n");
  }

  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = Math.max(1, started.interval_seconds || 3) * 1000;
  const deadline = Date.parse(started.login.expires_at);
  for (;;) {
    const result = await client.request<PollPayload>(
      "POST",
      `/cli/logins/${encodeURIComponent(started.login.id)}/poll`,
      started.poll_token,
    );
    if (result.state === "approved") {
      await storeAccountCredential(paths, baseUrl, result, dependencies.now());
      // The key stays in the credential file; the terminal sees only ids.
      return {
        principal_id: result.principal.id,
        api_key_id: result.api_key_id,
        bound_instance_ids: result.login.bind_instance_ids,
        credentials_file: paths.credentialsFile,
      };
    }
    if (Number.isFinite(deadline) && dependencies.now().getTime() >= deadline) {
      throw new CliError("login_expired", "The login was not approved in time. Run sharednet login again.", 4);
    }
    await sleep(intervalMs);
  }
}
