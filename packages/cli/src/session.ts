import { createRequire } from "node:module";
import { platform } from "node:os";

import { ApiClient, sameOrigin } from "./api-client.ts";
import { CliError, localError } from "./errors.ts";
import { computeLocalInstanceKey } from "./instance-computation.ts";
import {
  declareRuntime,
  detectRuntime,
  isRuntimeKind,
  runtimeMetadataOf,
  type DetectedRuntime,
} from "./runtime-detection.ts";
import {
  deleteSession,
  getOrCreateInstallationSecret,
  listSessions,
  readSessionById,
  readStoredApiCredential,
  writeSession,
  type StoragePaths,
  type StoredSession,
} from "./storage.ts";

/**
 * Acting as an account: the stored credential, registering this session as an
 * Instance, keeping its lease alive. Shared by `session start`, the Room
 * commands, and `join` when a credential is present.
 */

type Environment = Record<string, string | undefined>;

function packageVersion(): string {
  const manifest = createRequire(import.meta.url)("../package.json") as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("The SharedNet CLI package has no version.");
  }
  return manifest.version;
}

export const CLI_VERSION = packageVersion();

export interface AgentShape {
  id: string;
  principal_id?: string;
  handle?: string;
}

export interface InstanceShape {
  id: string;
  principal_id: string;
  agent_id: string | null;
  started_at: string;
  lease_expires_at: string;
  token_expires_at?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface InstanceStartPayload {
  instance: InstanceShape;
  token: string;
  heartbeat_after_seconds: number;
}

export interface CurrentInstancePayload {
  principal: unknown;
  agent: AgentShape | null;
  instance: InstanceShape;
}


function apiKeyAuthenticationError(): CliError {
  return new CliError(
    "authentication_required",
    "Set SHAREDNET_API_KEY or run sharednet login first.",
    3,
  );
}

export async function resolveApiKey(
  env: Environment,
  paths: StoragePaths,
  baseUrl: string,
): Promise<string> {
  const environmentKey = env.SHAREDNET_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  const credential = await readStoredApiCredential(paths);
  if (!credential) throw apiKeyAuthenticationError();
  if (!sameOrigin(credential.base_url, baseUrl)) {
    throw localError(
      "credential_origin_mismatch",
      "The stored credential belongs to a different SharedNet origin.",
    );
  }
  if (credential.expires_at && Date.parse(credential.expires_at) <= Date.now()) {
    throw new CliError("invalid_credentials", "The stored API key has expired.", 3);
  }
  return credential.api_key;
}

/**
 * Resolves `--agent` to a tag. An `a_` id is fetched; anything else is a
 * handle and is created on first use, the way `git tag` behaves — the server's
 * POST is idempotent by handle, so one call covers both "exists" and "new".
 * `default` names the absence of a tag and resolves to nothing.
 */
export async function resolveTag(
  client: ApiClient,
  apiKey: string,
  requested: string,
): Promise<AgentShape | null> {
  const handle = requested.normalize("NFKC").trim().toLowerCase();
  if (handle === "default") return null;
  let agent: AgentShape;
  if (/^a_[A-Za-z0-9]+$/.test(requested)) {
    const payload = await client.request<{ agent: AgentShape }>(
      "GET",
      `/agents/${encodeURIComponent(requested)}`,
      apiKey,
    );
    agent = payload.agent;
  } else {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(handle)) {
      throw localError(
        "invalid_agent",
        "An Agent is an a_ id or a handle matching ^[a-z][a-z0-9-]{0,31}$.",
      );
    }
    const payload = await client.request<{ agent: AgentShape }>("POST", "/agents", apiKey, {
      handle,
    });
    agent = payload.agent;
  }
  if (!agent?.id) {
    throw new CliError(
      "invalid_server_response",
      "The SharedNet service returned an invalid Agent response.",
      5,
    );
  }
  return agent;
}

/**
 * Where this session runs, for humans telling untagged sessions apart. It is
 * shown, never trusted: the server records it as diagnostics and nothing reads
 * it for authorization or grouping.
 *
 * Only the workspace's last path segment and the OS are sent. The full path is a
 * map of this machine — home directory, user name, client folders — and none of
 * that is needed to tell "the one in the sharednet folder" from the others. The
 * hostname is not sent either: a Mac is named after its owner by default, so it
 * names the person behind a seat, which is exactly what the path rule avoids.
 */
export function runtimeMetadata(env: Environment): Record<string, string> {
  const clean = (value: string | undefined) =>
    (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 256);
  const metadata: Record<string, string> = {};
  const workspacePath = clean(env.PWD ?? process.cwd());
  const workspace = workspacePath.split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
  if (workspace) metadata.workspace = workspace;
  metadata.os = platform();
  return metadata;
}

export function validateRuntime(value: string, from = "--runtime"): string {
  const kind = value.normalize("NFKC").trim().toLowerCase();
  if (isRuntimeKind(kind)) return kind;
  throw localError(
    "invalid_runtime",
    `${from} must be a handle such as claude-code, codex, or dot, optionally followed by @version.`,
  );
}

/**
 * The runtime a harness declares for the seats it runs: `--runtime`, else
 * SHAREDNET_RUNTIME, which a hosted product sets once in the environment its
 * agents' commands run in. A handle with an optional `@version`, the shape of
 * the AI_AGENT convention (`dot`, `dot@2.1`). Null when nothing was declared.
 */
export function declaredRuntime(
  flag: string | undefined,
  env: Environment,
): { kind: string; version: string | null } | null {
  const fromFlag = flag?.trim();
  const value = fromFlag || env.SHAREDNET_RUNTIME?.trim();
  if (!value) return null;
  const from = fromFlag ? "--runtime" : "SHAREDNET_RUNTIME";
  const at = value.indexOf("@");
  const kind = validateRuntime(at === -1 ? value : value.slice(0, at), from);
  if (at === -1) return { kind, version: null };
  const version = value.slice(at + 1).trim();
  if (!/^[\x20-\x7e]{1,64}$/.test(version)) {
    throw localError(
      "invalid_runtime",
      `${from} must be a handle such as claude-code, codex, or dot, optionally followed by @version.`,
    );
  }
  return { kind, version };
}

/** What this CLI reports as its runtime: the harness's declaration, else the driver detected. */
export function resolveRuntime(env: Environment, flag?: string): DetectedRuntime {
  const detected = detectRuntime(env);
  const declared = declaredRuntime(flag, env);
  return declared === null ? detected : declareRuntime(detected, declared);
}

export function storedSessionFromStart(
  baseUrl: string,
  localInstanceKey: string | null,
  payload: InstanceStartPayload,
): StoredSession {
  const { instance, token } = payload;
  if (!instance?.id || !instance.principal_id || !token) {
    throw new CliError(
      "invalid_server_response",
      "The SharedNet service returned an invalid Instance response.",
      5,
    );
  }
  return {
    schema_version: 1,
    base_url: baseUrl,
    principal_id: instance.principal_id,
    agent_id: instance.agent_id ?? null,
    instance_id: instance.id,
    local_instance_key: localInstanceKey,
    instance_token: token,
    created_at: instance.started_at,
    lease_expires_at: instance.lease_expires_at,
    expires_at: null,
  };
}

export async function selectSession(
  paths: StoragePaths,
  baseUrl: string,
  explicitId: string | undefined,
  env: Environment,
): Promise<StoredSession> {
  const selectedId = explicitId || env.SHAREDNET_SESSION?.trim();
  if (selectedId) {
    if (!/^i_[A-Za-z0-9_-]+$/.test(selectedId)) {
      throw localError("invalid_session_id", "SHAREDNET_SESSION must be an Instance ID.");
    }
    const selected = await readSessionById(paths, selectedId);
    if (!selected || !sameOrigin(selected.base_url, baseUrl)) {
      throw localError("session_not_found", "The selected local SharedNet session was not found.");
    }
    return selected;
  }

  const usable = (await listSessions(paths)).filter(
    (session) => sameOrigin(session.base_url, baseUrl),
  );
  if (usable.length !== 1) {
    throw localError(
      "session_selection_required",
      "Select a local Instance with --session or SHAREDNET_SESSION.",
    );
  }
  return usable[0]!;
}

export async function refreshIfNeeded(
  client: ApiClient,
  paths: StoragePaths,
  session: StoredSession,
  now: Date,
): Promise<StoredSession> {
  if (Date.parse(session.lease_expires_at) - now.getTime() > 30_000) return session;

  try {
    const payload = await client.request<{
      instance: InstanceShape;
      heartbeat_after_seconds: number;
    }>("POST", "/instances/current/heartbeat", session.instance_token, {});
    const refreshed: StoredSession = {
      ...session,
      lease_expires_at: payload.instance.lease_expires_at,
      expires_at: null,
    };
    await writeSession(paths, refreshed);
    return refreshed;
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) {
      await deleteSession(paths, session.instance_id);
    }
    throw error;
  }
}


export interface RegisterInstanceOptions {
  /** `--runtime`: overrides the detected driver's name, never its session. SHAREDNET_RUNTIME when absent. */
  runtimeOverride?: string;
  /** `--new`: a fresh Instance even though the session was detected. */
  forceNew: boolean;
  /** `--agent`: a tag id or handle to group the Instance under. */
  agent?: string;
  /** Without a detected session and without `forceNew`, refuse (session start) or register fresh (join). */
  freshWhenUndetected: boolean;
  /** Sent as given; omitted, the server applies the Principal's default (public). */
  reach?: "public" | "private";
  /**
   * The account key the caller already settled on, used instead of reading the
   * credential file again, so the Instance is the account the caller checked
   * even if the file changes in between.
   */
  apiKey?: string;
}

/**
 * Registers this session as an Instance of the account behind the stored
 * credential. A same-session re-registration comes back with the existing
 * Instance and a fresh token; a new session comes back created.
 */
export async function registerInstance(
  env: Environment,
  fetchImplementation: typeof globalThis.fetch,
  paths: StoragePaths,
  baseUrl: string,
  options: RegisterInstanceOptions,
): Promise<{ session: StoredSession; payload: InstanceStartPayload }> {
  const installationSecret = await getOrCreateInstallationSecret(paths);
  // The driver is read off its own environment; a declaration (--runtime, or
  // SHAREDNET_RUNTIME from a harness) only overrides the name, and a name other
  // than the detected driver's comes without that driver's session.
  const runtime = resolveRuntime(env, options.runtimeOverride);
  let localInstanceKey: string | null = null;

  if (!options.forceNew) {
    if (runtime.anchor === null && !options.freshWhenUndetected) {
      throw localError(
        "runtime_session_not_detected",
        "The current runtime session could not be detected; use --new deliberately.",
      );
    }
    if (runtime.anchor !== null) {
      // The key goes to the server, which is the one place that can guarantee
      // one live Instance per runtime session. The raw session id stays here.
      localInstanceKey = computeLocalInstanceKey(installationSecret, runtime.kind, runtime.anchor);
    }
  }

  const apiKey = options.apiKey ?? await resolveApiKey(env, paths, baseUrl);
  const client = new ApiClient(baseUrl, fetchImplementation);
  const tag = options.agent ? await resolveTag(client, apiKey, options.agent) : undefined;

  const payload = await client.request<InstanceStartPayload>("POST", "/instances", apiKey, {
    runtime_kind: runtime.kind,
    cli_version: CLI_VERSION,
    ...(localInstanceKey ? { local_instance_key: localInstanceKey } : {}),
    ...(tag === undefined ? {} : { agent_id: tag?.id ?? null }),
    ...(options.reach === undefined ? {} : { reach: options.reach }),
    runtime_metadata: { ...runtimeMetadata(env), ...runtimeMetadataOf(runtime) },
  });
  const session = storedSessionFromStart(baseUrl, localInstanceKey, payload);
  await writeSession(paths, session);
  return { session, payload };
}

/** True when this machine can act as an account: a key in the environment or a stored credential for this origin. */
export async function hasAccountCredential(env: Environment, paths: StoragePaths, baseUrl: string): Promise<boolean> {
  if (env.SHAREDNET_API_KEY?.trim()) return true;
  const credential = await readStoredApiCredential(paths).catch(() => null);
  return credential !== null && sameOrigin(credential.base_url, baseUrl);
}
