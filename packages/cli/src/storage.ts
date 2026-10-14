import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { localError } from "./errors.ts";
import type { SeatWake } from "./wake-driver.ts";
import { parseSeatWake } from "./wake-plugins.ts";

type Environment = Record<string, string | undefined>;

export interface StoragePaths {
  configDir: string;
  credentialsFile: string;
  installationFile: string;
  stateDir: string;
  sessionsDir: string;
  /** One file per seat: rooms/<room_id>/<member_id>.json, so two Agents on one machine can sit in one Room. */
  roomsDir: string;
}

/**
 * A guest seat in one Room: the member token the join handed back, owner-only
 * under the config directory, never inside a project tree.
 */
export interface StoredRoomCredential {
  schema_version: 1;
  base_url: string;
  room_id: string;
  member_id: string;
  name: string;
  member_token: string;
  joined_at: string;
  room_type?: "board" | "compiled";
  /** The session that took the seat, which `serve` resumes when the seat is addressed. */
  wake?: SeatWake;
}

/**
 * The per-project cursor: which Room this checkout is in and the last
 * sequence it has seen. Nothing here is secret, and the directory ignores
 * itself so it never rides into a commit.
 */
/** One seat's view of the directory's Room: what say, wait and watch act as. */
export interface ProjectRoomState {
  schema_version: 1;
  base_url: string;
  room_id: string;
  member_id: string;
  last_sequence: number;
}

/**
 * The directory's Room, with every seat this directory has taken in it and
 * a cursor per seat. Two Agent sessions in one checkout are two seats, each
 * tied to its own session by `anchor_key` (the local Instance key derived
 * from the driver's session id and this machine's installation secret; never
 * the raw session id), so neither ever speaks or reads as the other.
 */
export interface ProjectRoom {
  schema_version: 2;
  base_url: string;
  room_id: string;
  seats: Record<string, ProjectSeat>;
}

export interface ProjectSeat {
  last_sequence: number;
  anchor_key: string | null;
  joined_at: string | null;
}

export const PROJECT_STATE_DIR = ".sharednet";

export interface StoredApiCredential {
  schema_version: 1;
  base_url: string;
  principal_id: string;
  api_key_id: string;
  api_key: string;
  installation_secret: string;
  created_at: string;
  expires_at: string | null;
}

export interface StoredSession {
  schema_version: 1;
  base_url: string;
  principal_id: string;
  /** The tag this Instance was under when the session file was written; null when untagged. */
  agent_id: string | null;
  instance_id: string;
  local_instance_key: string | null;
  instance_token: string;
  created_at: string;
  lease_expires_at: string;
  /** Always null since Instances became permanent; kept so old files still parse. */
  expires_at: string | null;
}

interface StoredInstallation {
  schema_version: 1;
  installation_secret: string;
}

function unsafeStorage(): never {
  throw localError(
    "unsafe_credential_storage",
    "SharedNet local credential storage is not owner-only.",
  );
}

export function getStoragePaths(env: Environment = process.env): StoragePaths {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) unsafeStorage();
    const root = join(localAppData, "SharedNet");
    return {
      configDir: root,
      credentialsFile: join(root, "credentials.json"),
      installationFile: join(root, "installation.json"),
      stateDir: root,
      sessionsDir: join(root, "sessions"),
      roomsDir: join(root, "rooms"),
    };
  }

  const home = env.HOME || homedir();
  if (!home) unsafeStorage();
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateRoot = env.XDG_STATE_HOME || join(home, ".local", "state");
  const configDir = join(configRoot, "sharednet");
  const stateDir = join(stateRoot, "sharednet");
  return {
    configDir,
    credentialsFile: join(configDir, "credentials.json"),
    installationFile: join(configDir, "installation.json"),
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
    roomsDir: join(configDir, "rooms"),
  };
}

async function ensureSecureDirectory(path: string): Promise<void> {
  if (process.platform === "win32") unsafeStorage();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    unsafeStorage();
  }
}

async function readSecureFile(path: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    unsafeStorage();
  }

  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== info.dev ||
      openedInfo.ino !== info.ino ||
      openedInfo.uid !== process.getuid?.() ||
      (openedInfo.mode & 0o077) !== 0
    ) {
      unsafeStorage();
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensureSecureDirectory(parent);

  // Validate an existing target before an atomic replacement. Missing is fine.
  await readSecureFile(path);
  const temp = join(parent, `.sharednet-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    await rename(temp, path);
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function createSecureJsonIfAbsent(path: string, value: unknown): Promise<boolean> {
  return createSecureTextIfAbsent(path, `${JSON.stringify(value)}\n`);
}

async function createSecureTextIfAbsent(path: string, text: string): Promise<boolean> {
  const parent = dirname(path);
  await ensureSecureDirectory(parent);
  const temp = join(parent, `.sharednet-${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temp, 0o600);
    try {
      // link(2) is an atomic create-if-absent operation. Unlike opening the
      // destination with O_EXCL and then writing it, readers can never observe
      // an empty or partially written installation secret.
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => undefined);
  }
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
  }
}

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
  }
  return value;
}

function parseCredential(raw: string): StoredApiCredential {
  const value = parseJsonObject(raw, "The credential file");
  if (value.schema_version !== 1) {
    throw localError("invalid_local_state", "The credential file has an unsupported version.");
  }
  return {
    schema_version: 1,
    base_url: requireString(value.base_url, "The credential file"),
    principal_id: requireString(value.principal_id, "The credential file"),
    api_key_id: requireString(value.api_key_id, "The credential file"),
    api_key: requireString(value.api_key, "The credential file"),
    installation_secret: requireString(value.installation_secret, "The credential file"),
    created_at: requireString(value.created_at, "The credential file"),
    expires_at:
      value.expires_at === null ? null : requireString(value.expires_at, "The credential file"),
  };
}

function parseSession(raw: string): StoredSession {
  const value = parseJsonObject(raw, "A session file");
  if (value.schema_version !== 1) {
    throw localError("invalid_local_state", "A session file has an unsupported version.");
  }
  return {
    schema_version: 1,
    base_url: requireString(value.base_url, "A session file"),
    principal_id: requireString(value.principal_id, "A session file"),
    agent_id: value.agent_id === null ? null : requireString(value.agent_id, "A session file"),
    instance_id: requireString(value.instance_id, "A session file"),
    local_instance_key:
      value.local_instance_key === null
        ? null
        : requireString(value.local_instance_key, "A session file"),
    instance_token: requireString(value.instance_token, "A session file"),
    created_at: requireString(value.created_at, "A session file"),
    lease_expires_at: requireString(value.lease_expires_at, "A session file"),
    expires_at: value.expires_at === null || value.expires_at === undefined ? null : requireString(value.expires_at, "A session file"),
  };
}

export async function readStoredApiCredential(
  paths: StoragePaths,
): Promise<StoredApiCredential | null> {
  const raw = await readSecureFile(paths.credentialsFile);
  return raw === null ? null : parseCredential(raw);
}

/** Written by `sharednet login`; owner-only, and never printed back. */
export async function writeStoredApiCredential(
  paths: StoragePaths,
  credential: StoredApiCredential,
): Promise<void> {
  await writeSecureJson(paths.credentialsFile, credential);
}

/**
 * Copies the credential file, byte for byte and owner-only, to
 * `credentials.json.bak-<time>` beside it before it is replaced. Returns the
 * copy's path, or null when there was nothing to keep.
 */
export async function backupStoredApiCredential(
  paths: StoragePaths,
  now: Date,
): Promise<string | null> {
  const raw = await readSecureFile(paths.credentialsFile);
  if (raw === null) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = `${paths.credentialsFile}.bak-${stamp}${attempt === 0 ? "" : `-${attempt}`}`;
    if (await createSecureTextIfAbsent(path, raw)) return path;
  }
  throw localError("invalid_local_state", "The credential file could not be backed up.");
}

export async function getOrCreateInstallationSecret(
  paths: StoragePaths,
): Promise<string> {
  const credential = await readStoredApiCredential(paths);
  if (credential) return credential.installation_secret;

  const raw = await readSecureFile(paths.installationFile);
  if (raw !== null) {
    const value = parseJsonObject(raw, "The installation file");
    if (value.schema_version !== 1) {
      throw localError("invalid_local_state", "The installation file has an unsupported version.");
    }
    return requireString(value.installation_secret, "The installation file");
  }

  const installation: StoredInstallation = {
    schema_version: 1,
    installation_secret: randomBytes(32).toString("base64url"),
  };
  if (await createSecureJsonIfAbsent(paths.installationFile, installation)) {
    return installation.installation_secret;
  }

  const winnerRaw = await readSecureFile(paths.installationFile);
  if (winnerRaw === null) {
    throw localError("invalid_local_state", "The installation secret could not be created.");
  }
  const winner = parseJsonObject(winnerRaw, "The installation file");
  if (winner.schema_version !== 1) {
    throw localError("invalid_local_state", "The installation file has an unsupported version.");
  }
  return requireString(winner.installation_secret, "The installation file");
}

export async function writeSession(
  paths: StoragePaths,
  session: StoredSession,
): Promise<void> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(session.instance_id)) {
    throw localError("invalid_local_state", "The Instance ID is invalid.");
  }
  await writeSecureJson(join(paths.sessionsDir, `${session.instance_id}.json`), session);
}

export async function listSessions(paths: StoragePaths): Promise<StoredSession[]> {
  let entries;
  try {
    await ensureSecureDirectory(paths.sessionsDir);
    entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: StoredSession[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) unsafeStorage();
    const raw = await readSecureFile(join(paths.sessionsDir, entry.name));
    if (raw !== null) sessions.push(parseSession(raw));
  }
  return sessions;
}

export async function readSessionById(
  paths: StoragePaths,
  instanceId: string,
): Promise<StoredSession | null> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(instanceId)) {
    throw localError("invalid_session_id", "The Instance ID is invalid.");
  }
  const raw = await readSecureFile(join(paths.sessionsDir, `${instanceId}.json`));
  return raw === null ? null : parseSession(raw);
}

export async function deleteSession(paths: StoragePaths, instanceId: string): Promise<void> {
  if (!/^i_[A-Za-z0-9_-]+$/.test(instanceId)) return;
  const path = join(paths.sessionsDir, `${instanceId}.json`);
  const raw = await readSecureFile(path);
  if (raw === null) return;
  await unlink(path);
}

const ROOM_ID_PATTERN = /^rom_[A-Za-z0-9]+$/;
/** A seat is an Instance (`i_`); `mem_` files written before migration 0007 still open. */
const MEMBER_ID_PATTERN = /^(?:i|mem)_[A-Za-z0-9]+$/;

/**
 * A seat is one member in one Room. Two Agents on the same machine that join
 * the same Room are two seats and must never share a file, or the second join
 * would silently take over the first one's credential.
 */
function roomCredentialFile(paths: StoragePaths, roomId: string, memberId: string): string {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw localError("invalid_local_state", "The Room ID is invalid.");
  }
  if (!MEMBER_ID_PATTERN.test(memberId)) {
    throw localError("invalid_local_state", "The member ID is invalid.");
  }
  return join(paths.roomsDir, roomId, `${memberId}.json`);
}

function parseRoomCredential(raw: string): StoredRoomCredential {
  const value = parseJsonObject(raw, "A Room credential file");
  if (value.schema_version !== 1) {
    throw localError("invalid_local_state", "A Room credential file has an unsupported version.");
  }
  const source = "A Room credential file";
  const wake = parseSeatWake(value.wake);
  return {
    schema_version: 1,
    base_url: requireString(value.base_url, source),
    room_id: requireString(value.room_id, source),
    member_id: requireString(value.member_id, source),
    name: requireString(value.name, source),
    member_token: requireString(value.member_token, source),
    joined_at: requireString(value.joined_at, source),
    ...(value.room_type === "board" || value.room_type === "compiled" ? { room_type: value.room_type } : {}),
    ...(wake ? { wake } : {}),
  };
}

export async function writeRoomCredential(
  paths: StoragePaths,
  credential: StoredRoomCredential,
): Promise<void> {
  await writeSecureJson(
    roomCredentialFile(paths, credential.room_id, credential.member_id),
    credential,
  );
}

export async function readRoomCredential(
  paths: StoragePaths,
  roomId: string,
  memberId: string,
): Promise<StoredRoomCredential | null> {
  const raw = await readSecureFile(roomCredentialFile(paths, roomId, memberId));
  return raw === null ? null : parseRoomCredential(raw);
}

function projectStateFile(cwd: string): string {
  return join(cwd, PROJECT_STATE_DIR, "room.json");
}

export async function readProjectRoom(cwd: string): Promise<ProjectRoom | null> {
  let raw: string;
  try {
    raw = await readFile(projectStateFile(cwd), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = parseJsonObject(raw, "The project Room state");
  const source = "The project Room state";
  const sequence = (candidate: unknown): number => {
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
    }
    return candidate as number;
  };
  // A file from before seats were separated: one member, one cursor, no session tie.
  if (value.schema_version === 1) {
    const memberId = requireString(value.member_id, source);
    return {
      schema_version: 2,
      base_url: requireString(value.base_url, source),
      room_id: requireString(value.room_id, source),
      seats: { [memberId]: { last_sequence: sequence(value.last_sequence), anchor_key: null, joined_at: null } },
    };
  }
  if (value.schema_version !== 2) {
    throw localError("invalid_local_state", "The project Room state has an unsupported version.");
  }
  const seatsValue = value.seats;
  if (typeof seatsValue !== "object" || seatsValue === null || Array.isArray(seatsValue)) {
    throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
  }
  const seats: Record<string, ProjectSeat> = {};
  for (const [memberId, seat] of Object.entries(seatsValue as Record<string, unknown>)) {
    if (typeof seat !== "object" || seat === null) {
      throw localError("invalid_local_state", `${source} is not valid SharedNet state.`);
    }
    const record = seat as Record<string, unknown>;
    seats[memberId] = {
      last_sequence: sequence(record.last_sequence),
      anchor_key: typeof record.anchor_key === "string" ? record.anchor_key : null,
      joined_at: typeof record.joined_at === "string" ? record.joined_at : null,
    };
  }
  return {
    schema_version: 2,
    base_url: requireString(value.base_url, source),
    room_id: requireString(value.room_id, source),
    seats,
  };
}

async function writeProjectRoom(cwd: string, room: ProjectRoom): Promise<void> {
  const directory = join(cwd, PROJECT_STATE_DIR);
  await mkdir(directory, { recursive: true });
  // The directory ignores itself, so a project that has no .gitignore entry for
  // it still never commits a cursor file by accident.
  await writeFile(join(directory, ".gitignore"), "*\n", { flag: "w" });
  const temp = join(directory, `.room-${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, `${JSON.stringify(room, null, 2)}\n`, "utf8");
  await rename(temp, projectStateFile(cwd));
}

/**
 * Records one seat's cursor in the directory's Room. A different Room
 * replaces the file: a directory is in one Room at a time. `anchorKey` ties
 * the seat to the session that took it; omitted, an existing tie is kept.
 */
export async function writeProjectRoomState(
  cwd: string,
  state: ProjectRoomState,
  options: { anchorKey?: string | null; joinedAt?: string } = {},
): Promise<void> {
  const existing = await readProjectRoom(cwd).catch(() => null);
  const sameRoom = existing !== null && existing.room_id === state.room_id;
  const previous = sameRoom ? existing.seats[state.member_id] : undefined;
  const seats = sameRoom ? { ...existing.seats } : {};
  seats[state.member_id] = {
    last_sequence: state.last_sequence,
    anchor_key: options.anchorKey !== undefined ? options.anchorKey : (previous?.anchor_key ?? null),
    joined_at: options.joinedAt ?? previous?.joined_at ?? null,
  };
  await writeProjectRoom(cwd, { schema_version: 2, base_url: state.base_url, room_id: state.room_id, seats });
}

/**
 * The seat this call acts as. In order: `--as` or SHAREDNET_SEAT; the seat
 * tied to this session; the only seat there is. Two seats and no way to
 * tell them apart is refused rather than guessed, since guessing is how one
 * session ends up speaking as another.
 */
export async function selectProjectSeat(
  cwd: string,
  choice: { explicit?: string; anchorKey: string | null },
): Promise<ProjectRoomState | null> {
  const room = await readProjectRoom(cwd);
  if (!room) return null;
  const view = (memberId: string): ProjectRoomState => ({
    schema_version: 1,
    base_url: room.base_url,
    room_id: room.room_id,
    member_id: memberId,
    last_sequence: room.seats[memberId]!.last_sequence,
  });
  const ids = Object.keys(room.seats);
  if (choice.explicit) {
    if (!room.seats[choice.explicit]) {
      throw localError(
        "seat_not_found",
        `This directory holds no seat ${choice.explicit} in ${room.room_id}; it holds: ${ids.join(", ") || "none"}.`,
      );
    }
    return view(choice.explicit);
  }
  if (choice.anchorKey) {
    const mine = ids.filter((id) => room.seats[id]!.anchor_key === choice.anchorKey);
    if (mine.length === 1) return view(mine[0]!);
  }
  if (ids.length === 1) return view(ids[0]!);
  if (ids.length === 0) return null;
  throw localError(
    "seat_selection_required",
    `This directory holds ${ids.length} seats in ${room.room_id} and none is this session's; say which with --as <member_id> or SHAREDNET_SEAT: ${ids.join(", ")}`,
  );
}
