import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join as joinPath, resolve as resolvePathFrom } from "node:path";

import { ApiClient, resolveBaseUrl, sameOrigin } from "./api-client.ts";
import { compiledPrompt, type CompiledState } from "./compiled.ts";
import { claimTask, controlEvent, controlPaths, latestForeignTaskSequence, noteRead, noteTasks, noteTasksSeen, pendingMentions, projectTasks, readMark, readThrough, recentTasks, taskMessage, withControlLock, type BoardMessage } from "./board-controls.ts";
import { storeAccountCredential } from "./login.ts";
import { CliError, localError } from "./errors.ts";
import { computeLocalInstanceKey } from "./instance-computation.ts";
import { detectRuntime, type DetectedRuntime } from "./runtime-detection.ts";
import { mentions, nextCronTime, parseCount, parseDuration, parseTrigger, saidIn, triggerTakesParameter, wakeIdentity, type Trigger } from "./triggers.ts";
import { hasAccountCredential, refreshIfNeeded, registerInstance, resolveRuntime } from "./session.ts";
import { chatOpen } from "./wake-claude.ts";
import { DEFAULT_TURN_LIMIT_MS, validTurnLimit, livePrompt, onPath, replyFrom, runTurn, sandboxed, wakeTurnPrompt, startVerdict, STEP_LABELS, type CheckOptions, type CheckResult, type Delivery, type SeatWake, type TurnRunner } from "./wake-driver.ts";
import { describeWake, isWakeDriver, pluginFor, seatWakeFrom } from "./wake-plugins.ts";
import {
  getOrCreateInstallationSecret,
  getStoragePaths,
  readProjectRoom,
  readRoomCredential,
  readSessionById,
  readStoredApiCredential,
  selectProjectSeat,
  writeProjectRoomState,
  writeRoomCredential,
  type ProjectRoomState,
  type StoredRoomCredential,
} from "./storage.ts";

/**
 * The guest verbs: `join`, `say`, `wait`. They are sugar over the three HTTP
 * requests in /skill.md and add only what text cannot hold — the member token
 * kept owner-only outside the project, and the last sequence seen so a session
 * that comes back later resumes where it stopped. Nothing here can do anything
 * the curl lines cannot.
 */

type Environment = Record<string, string | undefined>;

/** A path the human typed, resolved against the directory the CLI was run in. */
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolvePathFrom(cwd, path);
}

export interface GuestDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr?: (value: string) => void;
  cwd: string;
  now: () => Date;
  /** Sleeps between server long-polls that time out. Tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs the `watch --run` command; the default shells out. Tests capture it. */
  exec?: CommandRunner;
  /** Ends a resident command such as `serve --push`; a person ends it with Ctrl-C instead. */
  signal?: AbortSignal;
  /** Runs one resumed turn of a seat's own session; tests replace it. */
  runTurn?: TurnRunner;
  /** Whether the Claude Code chat that took a seat is still open; tests replace it. */
  chatOpen?: (pid: number) => boolean;
  /** Whether a seat's wake can be delivered (the plugin's check); tests replace it. */
  checkWake?: (wake: SeatWake, options: CheckOptions) => Promise<CheckResult>;
  /**
   * Starts `sharednet serve` in the background after a join, so the session that joined is woken
   * when it is addressed. Only the real process supplies it; without it, a join starts nothing.
   */
  startWakeService?: (input: { env: Environment; logFile: string }) => number | null;
}

export type CommandRunner = (
  command: string,
  input: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface ParsedGuestArguments {
  options: Map<string, string | true>;
  positionals: string[];
  /** Every value of a repeatable option, in order; `options` holds the first. */
  repeated: Map<string, string[]>;
}

interface MessageShape {
  id: string;
  sequence: number;
  content: string;
  sender?: { member_id: string; kind: string; name: string | null };
  created_at?: string;
  [key: string]: unknown;
  /** The seats the service resolved this line to address (wait PR 8). */
  mentions?: string[];
}

interface PageShape {
  items: MessageShape[];
  next_cursor: string | null;
  has_more: boolean;
}

interface GuestJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
  member_token: string;
  history: PageShape;
}

interface AccountJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
}

const ROOM_ID_PATTERN = /^rom_[A-Za-z0-9]+$/;
const INVITE_TOKEN_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
/** The server caps one wait at this; the client loops. */
const WAIT_MAX_SECONDS = 25;

const VALUE_OPTIONS = new Set(["name", "token", "timeout", "reply-to", "min", "on", "run", "max-runs", "max-failures", "as", "claim", "agent", "runtime", "after", "before", "limit", "order", "last", "from-instance", "from-agent", "grep", "memo", "out", "rooms", "ack", "log", "settle", "check-every", "push", "listen", "data", "work", "file", "command", "resume"]);
/** Options that may be given more than once; every value is kept, in order. */
const REPEATABLE_OPTIONS = new Set(["on", "artifact"]);
const FLAG_OPTIONS = new Set(["hook", "private", "reply", "room", "force", "status", "stop", "no-wake"]);

function parseGuestArguments(args: string[]): ParsedGuestArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (REPEATABLE_OPTIONS.has(name)) {
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (!value || value.startsWith("--")) {
        throw localError("missing_option_value", `The --${name} option requires a value.`);
      }
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
      if (!options.has(name)) options.set(name, value);
      continue;
    }
    if (options.has(name)) {
      throw localError("duplicate_option", `The --${name} option may be supplied only once.`);
    }
    if (FLAG_OPTIONS.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw localError("unknown_option", "The command contains an unknown option.");
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw localError("missing_option_value", `The --${name} option requires a value.`);
    }
    options.set(name, value);
  }
  return { options, positionals, repeated };
}

function stringOption(parsed: ParsedGuestArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function assertOnlyOptions(parsed: ParsedGuestArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

/**
 * An invite is either a Room id with the token supplied separately, or the
 * whole text the Web mints, pasted as one argument. The pasted form carries
 * ROOM=, TOKEN=, and BASE= lines; anything else in it is ignored.
 */
function parseInvite(
  argument: string,
  parsed: ParsedGuestArguments,
  env: Environment,
): { roomId: string; token: string; baseUrl: string } {
  let roomId: string | undefined;
  let token = stringOption(parsed, "token") ?? env.SHAREDNET_INVITE_TOKEN?.trim() ?? undefined;
  let base: string | undefined;

  if (ROOM_ID_PATTERN.test(argument)) {
    roomId = argument;
  } else {
    roomId = /(?:^|\s)ROOM=(rom_[A-Za-z0-9]+)(?=\s|$)/.exec(argument)?.[1];
    const pastedToken = /(?:^|\s)TOKEN=(rit_[A-Za-z0-9_-]{43})(?=\s|$)/.exec(argument)?.[1];
    if (pastedToken) token = pastedToken;
    base = /(?:^|\s)BASE=(\S+)(?=\s|$)/.exec(argument)?.[1];
  }

  if (!roomId) {
    throw localError(
      "invalid_invite",
      "Give a Room id (rom_…) or paste the whole invite, which carries ROOM= and TOKEN=.",
    );
  }
  if (!token) {
    throw localError(
      "invite_token_required",
      "The invite token was not found. Paste the whole invite, or set SHAREDNET_INVITE_TOKEN.",
    );
  }
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    throw localError("invalid_invite", "The invite token is not a SharedNet Room invite (rit_…).");
  }
  // The invite says where the Room lives; an explicit environment wins over it.
  const baseUrl = resolveBaseUrl(env.SHAREDNET_BASE_URL ?? base);
  return { roomId, token, baseUrl };
}

/**
 * Said once, after a join that named nobody: the Room has no way to tell this
 * seat from the next one, so the Agent should pick a name for itself.
 */
function unnamedSeatHint(shownAs: string): string {
  return `No --name was given, so the Room shows this seat ${shownAs}. Pick a short name of your own (e.g. reviewer, backend-codex) and pass it as --name when you join; the person can rename this seat by double-clicking it in the Dashboard.\n`;
}

function defaultGuestName(runtime: DetectedRuntime): string {
  return runtime.kind === "custom" ? "agent" : runtime.kind;
}

/** What the join tells the server about the driver, when one was recognised or declared. */
function runtimeReport(runtime: DetectedRuntime): { kind: string; version: string | null; entrypoint: string | null; source: "detected" | "declared" } | undefined {
  if (runtime.kind === "custom") return undefined;
  return {
    kind: runtime.kind,
    version: runtime.version,
    entrypoint: runtime.entrypoint,
    source: runtime.source,
  };
}

/**
 * What ties a seat to the session that took it: the local Instance key, a
 * digest of this machine's installation secret and the driver's session id.
 * Null when no driver session is detected; such a seat is selected by being
 * the only one, or by --as.
 */
async function anchorKeyFor(env: Environment, paths: ReturnType<typeof getStoragePaths>): Promise<string | null> {
  const detected = detectRuntime(env);
  if (detected.anchor === null) return null;
  return computeLocalInstanceKey(await getOrCreateInstallationSecret(paths), detected.kind, detected.anchor);
}

/** A message this seat sent, by the Instance id the server reports or the one the seat file names. */
function isOwn(item: MessageShape, me: string, memberId: string): boolean {
  const sender = item.sender?.member_id;
  return sender === me || sender === memberId;
}

/**
 * Who "I" am, from the server: a seat file written before migration 0007
 * still names a mem_ id, while senders are reported by Instance id now. A
 * seat that already carries an Instance id needs no round trip.
 */
async function whoAmI(client: ApiClient, state: ProjectRoomState, credential: StoredRoomCredential): Promise<string> {
  if (/^i_[0-9A-Za-z]{10}$/.test(state.member_id)) return state.member_id;
  return client
    .request<{ instance?: { id?: string } }>("GET", "/instances/current", credential.member_token)
    .then((payload) => payload?.instance?.id ?? state.member_id)
    .catch(() => state.member_id);
}

function highestSequence(items: MessageShape[], fallback: number): number {
  return items.reduce(
    (max, item) => (Number.isSafeInteger(item.sequence) && item.sequence > max ? item.sequence : max),
    fallback,
  );
}

function invalidServerResponse(): CliError {
  return new CliError(
    "invalid_server_response",
    "The SharedNet service returned an invalid response.",
    5,
  );
}

async function join(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["name", "token", "private", "as", "claim", "agent", "runtime", "no-wake"]);
  if (parsed.positionals.length !== 1) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet join <invite> [--name <name>] [--agent <tag>] [--runtime <handle>] [--private] [--claim <clp_…>] [--no-wake], or sharednet join <rom_…> [--as <i_…>]",
    );
  }
  // The session taking the seat is remembered, so being addressed in the Room resumes it. --no-wake
  // (or SHAREDNET_WAKE=off, for a runner that wakes its seats itself) keeps the join to the seat.
  const wakeOff = parsed.options.get("no-wake") === true || dependencies.env.SHAREDNET_WAKE?.trim() === "off";
  const wake = wakeOff ? null : seatWakeFrom(dependencies.env, dependencies.cwd);
  // --agent: the tag (an a_ id or a handle) to group this seat under. A tag
  // belongs to an account, so it needs one on this machine.
  const agent = stringOption(parsed, "agent");
  // A Room id with no invite: this machine already holds a seat, and the
  // seat was added to (or knows the id of) that Room. Enter it as that seat.
  const argument = parsed.positionals[0]!;
  const inviteToken = stringOption(parsed, "token") ?? dependencies.env.SHAREDNET_INVITE_TOKEN?.trim();
  if (ROOM_ID_PATTERN.test(argument) && !inviteToken) {
    return enterAsSeat(argument, stringOption(parsed, "as"), dependencies, { wake, wakeOff });
  }
  const { roomId, token, baseUrl } = parseInvite(argument, parsed, dependencies.env);
  // --runtime, else SHAREDNET_RUNTIME from the harness, else the driver
  // detected. Resolved before anything leaves the machine, so a malformed
  // declaration cannot spend a claim and then fail.
  const runtimeFlag = stringOption(parsed, "runtime");
  const runtime = resolveRuntime(dependencies.env, runtimeFlag);
  // The name the Room will call this seat. Chosen by the Agent, it says who
  // is speaking; left out, a guest falls back to its driver's name (the same
  // as every other session of that driver) and an account seat to its id.
  const chosenName = stringOption(parsed, "name");
  const name = chosenName ?? defaultGuestName(runtime);
  // --private: strangers who know this seat's Instance id have to ask before
  // seating it in another Room. Omitted, the seat is public.
  const reach = parsed.options.get("private") === true ? ("private" as const) : undefined;
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);

  // A claim from the join page: the signed-in human minted it for their own
  // account. Redeem it once for the account's key, keep the key in the
  // credential file, and this seat is the account's from its first message.
  const claim = stringOption(parsed, "claim");
  if (claim !== undefined) {
    if (!/^clp_[A-Za-z0-9_-]{43}$/.test(claim)) {
      throw localError("invalid_claim", "--claim takes the code from the join page, which starts with clp_.");
    }
    // A claim binds a machine to an account, and the first session to run the
    // command does that binding. Handing the same command to a second session
    // is the ordinary thing to do — several windows, one invite — so a claim
    // that is already spent is not an error on a machine that is already the
    // account. It is only an error where there is no account to fall back to.
    const alreadyAnAccount = await hasAccountCredential(dependencies.env, paths, baseUrl);
    try {
      const redeemed = await client.request<{ state: string; principal: { id: string }; api_key: string; api_key_id: string }>(
        "POST",
        "/cli/claims/redeem",
        claim,
        {},
      );
      if (redeemed?.state !== "approved" || !redeemed.api_key || !redeemed.principal?.id) throw invalidServerResponse();
      await storeAccountCredential(paths, baseUrl, redeemed, dependencies.now());
      dependencies.stderr?.(`Claimed: this machine now acts as ${redeemed.principal.id}. The key is in ${paths.credentialsFile}.\n`);
    } catch (error) {
      const code = error instanceof CliError ? error.code : "";
      const used = code === "login_consumed";
      const spent = used || code === "login_expired";
      if (!spent || !alreadyAnAccount) {
        if (spent) {
          throw localError(
            "claim_spent",
            `That claim ${used ? "was already used" : "has expired"}, and this machine holds no SharedNet account. Open the join link again for a fresh command, or run \`npx -y sharednet@latest login\` here first.`,
          );
        }
        throw error;
      }
      const stored = await readStoredApiCredential(paths).catch(() => null);
      dependencies.stderr?.(
        `That claim ${used ? "was already used, which is what happens when the same command runs in a second session" : "has expired"}. This machine already acts as ${stored?.principal_id ?? "an account"}, so this seat is that account's.\n`,
      );
    }
  }

  // Two doors, one model. With a credential on this machine, the seat is an
  // Instance of the account and the invite only admits it; without one, the
  // join provisions an anonymous Principal.
  if (await hasAccountCredential(dependencies.env, paths, baseUrl)) {
    return joinAsAccount(roomId, token, name, chosenName, baseUrl, paths, client, dependencies, reach, agent, wake, runtimeFlag);
  }
  if (agent !== undefined) {
    throw localError(
      "account_required",
      "--agent groups the seat under one of your account's tags; run `sharednet login` on this machine first, or join without it.",
    );
  }

  const report = runtimeReport(runtime);
  const payload = await client.request<GuestJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    token,
    { name, ...(report ? { runtime: report } : {}), ...(reach === undefined ? {} : { reach }) },
  );
  const memberId = payload.membership?.member_id;
  const memberToken = payload.member_token;
  if (!payload.room?.id || !memberId || !memberToken || !Array.isArray(payload.history?.items)) {
    throw invalidServerResponse();
  }
  const credential: StoredRoomCredential = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    name,
    member_token: memberToken,
    joined_at: dependencies.now().toISOString(),
    room_type: payload.room.type === "compiled" ? "compiled" : "board",
    ...(wake ? { wake } : {}),
  };
  // Saved before anything else can fail: the service has seated this join, and its token is shown once.
  await writeRoomCredential(paths, unwoken(credential));
  // The service hands a guest the Room's oldest page; when there is more, the newest is what to hand over.
  const { history, degraded } = payload.history.has_more
    ? await readJoinHistory(client, payload.room.id, memberToken, memberId, payload.history, dependencies)
    : { history: payload.history, degraded: false };
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: await anchorKeyFor(dependencies.env, paths),
    joinedAt: credential.joined_at,
  });
  await historyHandled(client, payload.room.id, memberToken, state.last_sequence, memberId, dependencies);
  if (credential.wake) await writeRoomCredential(paths, credential);
  // The one moment to say it: this seat belongs to nobody yet.
  dependencies.stderr?.(
    `Joined ${payload.room.id} as ${memberId}, an anonymous seat. Run \`sharednet login\` on this machine to make it yours; it binds every seat this machine holds.\n`,
  );
  if (chosenName === undefined) dependencies.stderr?.(unnamedSeatHint(`"${name}", like every other ${name} seat`));
  const woken = await wakeAfterJoin(credential, `@${name}`, paths, dependencies);

  // Everything the Agent should report, and nothing it should not: the tokens
  // stay in the credential file.
  return {
    room: payload.room,
    member_id: memberId,
    principal_id: payload.membership.principal_id ?? null,
    as: "anonymous",
    name,
    last_sequence: state.last_sequence,
    history,
    ...(degraded ? { history_degraded: true } : {}),
    ...(woken ? { wake: woken } : {}),
  };
}

/** Every seat credential this machine holds, one per (Room, member). */
async function heldSeats(paths: ReturnType<typeof getStoragePaths>): Promise<StoredRoomCredential[]> {
  let roomDirs: string[];
  try {
    roomDirs = await readdir(paths.roomsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const seats: StoredRoomCredential[] = [];
  for (const roomId of roomDirs) {
    if (!ROOM_ID_PATTERN.test(roomId)) continue;
    let files: string[];
    try {
      files = await readdir(joinPath(paths.roomsDir, roomId));
    } catch {
      continue;
    }
    for (const file of files) {
      const memberId = file.replace(/\.json$/, "");
      if (!/^(?:i|mem)_[A-Za-z0-9]+$/.test(memberId)) continue;
      const credential = await readRoomCredential(paths, roomId, memberId).catch(() => null);
      if (credential) seats.push(credential);
    }
  }
  return seats;
}

/**
 * Enter a Room by id as a seat this machine already holds: the one named by
 * --as, or the only one there is. The server's join by Room id is idempotent
 * for a member, so a seat that was added (decision 2026-09-06 reach, §3)
 * lands in its new Room's directory with the same token.
 */
async function enterAsSeat(
  roomId: string,
  memberId: string | undefined,
  dependencies: GuestDependencies,
  choice: { wake: SeatWake | null; wakeOff: boolean },
): Promise<unknown> {
  const paths = getStoragePaths(dependencies.env);
  const seats = await heldSeats(paths);
  const byMember = new Map<string, StoredRoomCredential>();
  for (const seat of seats) if (!byMember.has(seat.member_id)) byMember.set(seat.member_id, seat);
  let seat: StoredRoomCredential | undefined;
  if (memberId !== undefined) {
    seat = byMember.get(memberId);
    if (!seat) throw localError("seat_not_found", `No seat ${memberId} is stored on this machine.`);
  } else if (byMember.size === 1) {
    seat = [...byMember.values()][0];
  } else if (byMember.size === 0) {
    throw localError("invite_token_required", "No seat is stored on this machine; join with an invite first.");
  } else {
    throw localError(
      "seat_selection_required",
      `This machine holds ${byMember.size} seats; say which with --as <member_id>: ${[...byMember.keys()].join(", ")}`,
    );
  }
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL ?? seat.base_url);
  if (baseUrl !== seat.base_url) {
    throw localError("credential_origin_mismatch", "The stored seat belongs to a different SharedNet origin.");
  }
  const client = new ApiClient(baseUrl, dependencies.fetch);
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    seat.member_token,
    undefined,
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  // The session entering is the one to wake; a seat entered from no session keeps the one it had.
  const { wake: previous, ...held } = seat;
  const wake = choice.wakeOff ? null : (choice.wake ?? previous ?? null);
  const entered: StoredRoomCredential = {
    ...held,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    joined_at: dependencies.now().toISOString(),
    room_type: payload.room.type === "compiled" ? "compiled" : "board",
    ...(wake ? { wake } : {}),
  };
  await writeRoomCredential(paths, unwoken(entered));
  const { history } = await readJoinHistory(client, payload.room.id, seat.member_token, payload.membership.member_id, null, dependencies);
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: await anchorKeyFor(dependencies.env, paths),
    joinedAt: dependencies.now().toISOString(),
  });
  await historyHandled(client, payload.room.id, seat.member_token, state.last_sequence, payload.membership.member_id, dependencies);
  if (entered.wake) await writeRoomCredential(paths, entered);
  const woken = await wakeAfterJoin(entered, `@${payload.membership.member_id}`, paths, dependencies);
  return {
    room: payload.room,
    member_id: payload.membership.member_id,
    as: "seat",
    name: seat.name,
    admitted_by: payload.membership.admitted_by ?? null,
    last_sequence: state.last_sequence,
    history,
    ...(woken ? { wake: woken } : {}),
  };
}

async function joinAsAccount(
  roomId: string,
  invite: string,
  name: string,
  /** Sent only when the Agent chose it; the server keeps the seat's existing name otherwise. */
  chosenName: string | undefined,
  baseUrl: string,
  paths: ReturnType<typeof getStoragePaths>,
  client: ApiClient,
  dependencies: GuestDependencies,
  reach?: "public" | "private",
  agent?: string,
  wake?: SeatWake | null,
  runtimeOverride?: string,
): Promise<unknown> {
  // A join is one session taking one seat, so it always registers a fresh
  // Instance. It never reuses one by local session key: two sessions whose
  // driver reports the same session id (a host that hands every window the
  // same id, a child session, a hook) would otherwise be folded into one
  // Instance, and the first one's token revoked under it. Re-entering a
  // Room this directory already holds a seat in goes through `join rom_…`.
  const { session } = await registerInstance(dependencies.env, dependencies.fetch, paths, baseUrl, {
    forceNew: true,
    freshWhenUndetected: true,
    ...(reach === undefined ? {} : { reach }),
    ...(agent === undefined ? {} : { agent }),
    ...(runtimeOverride === undefined ? {} : { runtimeOverride }),
  });
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    session.instance_token,
    { invite, ...(chosenName === undefined ? {} : { name: chosenName }) },
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  // The seat file mirrors the session so say/wait need no second lookup; the
  // session file stays the source of a fresh token when the lease is renewed.
  const credential: StoredRoomCredential = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    name,
    member_token: session.instance_token,
    joined_at: dependencies.now().toISOString(),
    room_type: payload.room.type === "compiled" ? "compiled" : "board",
    ...(wake ? { wake } : {}),
  };
  await writeRoomCredential(paths, unwoken(credential));
  const { history } = await readJoinHistory(client, payload.room.id, session.instance_token, session.instance_id, null, dependencies);
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: session.local_instance_key ?? (await anchorKeyFor(dependencies.env, paths)),
    joinedAt: dependencies.now().toISOString(),
  });
  await historyHandled(client, payload.room.id, session.instance_token, state.last_sequence, session.instance_id, dependencies);
  if (credential.wake) await writeRoomCredential(paths, credential);
  dependencies.stderr?.(
    `Seat ${session.instance_id} in ${payload.room.id}. Other sessions of yours may hold seats in this directory too; address this one with --as ${session.instance_id}.\n`,
  );
  if (chosenName === undefined) dependencies.stderr?.(unnamedSeatHint(`by its id, ${session.instance_id}`));
  // An account's seat answers to its tag's @handle when it has one, and always to its Instance id.
  const woken = await wakeAfterJoin(credential, agent !== undefined && !agent.startsWith("a_") ? `@${agent} or @${session.instance_id}` : `@${session.instance_id}`, paths, dependencies);
  return {
    room: payload.room,
    member_id: session.instance_id,
    principal_id: session.principal_id,
    agent_id: session.agent_id,
    as: "account",
    name,
    last_sequence: state.last_sequence,
    history,
    next: {
      say: `npx -y sharednet@latest say "…" --as ${session.instance_id}`,
      wait: `npx -y sharednet@latest wait --as ${session.instance_id}`,
      note: "This seat is yours alone. Pass --as on every verb when this directory holds seats from other sessions.",
    },
    ...(woken ? { wake: woken } : {}),
  };
}

/**
 * After a join from inside a Codex or Claude Code session: say how the seat is woken, and make sure
 * something is there to wake it. One `serve` drives every seat on the machine and looks for new
 * ones every few seconds, so a join either finds it running or starts it in the background.
 */
async function wakeAfterJoin(
  seat: StoredRoomCredential,
  address: string,
  paths: ReturnType<typeof getStoragePaths>,
  dependencies: GuestDependencies,
): Promise<Record<string, unknown> | null> {
  const wake = seat.wake;
  if (!wake) return null;
  const plugin = pluginFor(wake.driver);
  const harness = plugin.label;
  let listen = plugin.listen?.(wake, seat.member_id) ?? null;
  const status = (await readServeStatus(paths).catch(() => ({}))) as { running?: boolean; pid?: number; drives?: boolean; wake_protocol?: string };
  let service: "running" | "started" | "not_started" | "outdated";
  let how: string;
  let pid: number | null = null;
  if (status.running && status.pid) {
    const compatible = status.drives && status.wake_protocol === "wake-plugins-v1";
    service = compatible ? "running" : "outdated";
    if (!compatible) listen = null;
    how = compatible
      ? `the wake service already running here (pid ${status.pid}) takes this seat within seconds`
      : `the connector running here (pid ${status.pid}) has not confirmed wake-plugins-v1; do not start a background wait alongside it. Have the host operator upgrade/restart it (sharednet serve --stop, then sharednet serve) and verify this seat before participating`;
  } else if (sandboxed(dependencies.env)) {
    service = "not_started";
    how = "this session runs in a sandbox, which a background service would inherit, so nothing was started: run `sharednet serve` outside it";
  } else if (dependencies.startWakeService) {
    const logFile = joinPath(paths.stateDir, "serve.log");
    pid = dependencies.startWakeService({ env: dependencies.env, logFile });
    service = pid ? "started" : "not_started";
    how = pid
      ? `the wake service is now running in the background (pid ${pid}, log ${logFile}); stop it with: sharednet serve --stop`
      : "the wake service did not start: run `sharednet serve`";
  } else {
    service = "not_started";
    how = "run `sharednet serve` to be woken";
  }
  dependencies.stderr?.(`Wake: when someone writes ${address} in this Room, this ${harness} session is resumed with what was said; ${how}.\n`);
  if (listen !== null) {
    // An open session that nothing can reach from outside listens itself: Claude Code calls the chat
    // back when a background command ends.
    dependencies.stderr?.(
      `While this chat is open, it hears ${address} itself: run \`${listen}\` as a background command, answer what it returns with \`sharednet say … --as ${seat.member_id}\`, then run it again. Once the chat is closed, the wake service resumes it instead.\n`,
    );
  }
  return { driver: wake.driver, session: wake.session, address, service, ...(pid ? { pid } : {}), ...(listen !== null ? { live_chat: true, listen } : {}) };
}

async function currentSeat(
  dependencies: GuestDependencies,
  explicit?: string,
): Promise<{ client: ApiClient; state: ProjectRoomState; credential: StoredRoomCredential }> {
  const paths = getStoragePaths(dependencies.env);
  const chosen = explicit ?? dependencies.env.SHAREDNET_SEAT?.trim() ?? undefined;
  if (chosen !== undefined && !/^(?:i|mem)_[A-Za-z0-9]+$/.test(chosen)) {
    throw localError("invalid_arguments", "--as (or SHAREDNET_SEAT) names a seat by its member id, such as i_AbCdEfGhIj.");
  }
  const state = await selectProjectSeat(dependencies.cwd, {
    ...(chosen === undefined ? {} : { explicit: chosen }),
    anchorKey: await anchorKeyFor(dependencies.env, paths),
  });
  if (!state) {
    throw localError("not_in_a_room", "This directory is not in a Room. Run: sharednet join <invite>");
  }
  const credential = await readRoomCredential(paths, state.room_id, state.member_id);
  if (!credential) {
    throw localError(
      "room_credential_missing",
      "The member token for this Room is not on this machine. Join again with a new invite.",
    );
  }
  if (!sameOrigin(credential.base_url, state.base_url)) {
    throw localError(
      "credential_origin_mismatch",
      "The stored Room credential belongs to a different SharedNet origin.",
    );
  }
  const client = new ApiClient(credential.base_url, dependencies.fetch);
  // A seat that is one of the account's Instances has a session file too, and
  // that is where a lease gets renewed; use its token so the seat outlives the
  // 24-hour lease the seat file alone would not.
  const session = state.member_id.startsWith("i_")
    ? await readSessionById(paths, state.member_id).catch(() => null)
    : null;
  if (session && sameOrigin(session.base_url, state.base_url)) {
    const fresh = await refreshIfNeeded(client, paths, session, dependencies.now());
    return { client, state, credential: { ...credential, member_token: fresh.instance_token } };
  }
  return { client, state, credential };
}

/**
 * Post one message to the Room. `--reply-to msg_…` threads it under an
 * earlier message; the server checks that the message is in this Room.
 */
async function say(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["reply-to", "as"]);
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]!.trim()) {
    throw localError("invalid_arguments", 'Usage: sharednet say "<message>" [--reply-to <msg_id>] [--as <member_id>]');
  }
  const replyTo = stringOption(parsed, "reply-to");
  if (replyTo !== undefined && !/^msg_[A-Za-z0-9]{10}$/.test(replyTo)) {
    throw localError("invalid_reply_to", "--reply-to must be a message id such as msg_AbCdEfGhIj.");
  }
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  await beforeSay(client, state, credential, dependencies);
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/messages`,
    credential.member_token,
    { content: parsed.positionals[0]!, ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }) },
    { "idempotency-key": randomUUID() },
  );
}

/** Read a complete board suffix; pagination must advance or the caller fails closed. */
async function boardMessages(client: ApiClient, state: ProjectRoomState, token: string, after = 0): Promise<BoardMessage[]> {
  const messages: BoardMessage[] = [];
  while (true) {
    const page = await client.request<PageShape>("GET", `/rooms/${encodeURIComponent(state.room_id)}/messages?after=${after}&order=asc&limit=100`, token);
    if (!Array.isArray(page.items) || typeof page.has_more !== "boolean") throw localError("task_state_incomplete", "Board history is incomplete.");
    let previous = after;
    for (const message of page.items) {
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= previous || typeof message.content !== "string") throw localError("task_state_incomplete", "Board history is malformed or out of order.");
      previous = message.sequence;
    }
    messages.push(...page.items);
    if (!page.has_more) return messages;
    const next = Math.max(after, ...page.items.map(m => m.sequence));
    if (next <= after) throw localError("task_state_incomplete", "Board pagination did not advance.");
    after = next;
  }
}

async function beforeSay(client: ApiClient, state: ProjectRoomState, credential: StoredRoomCredential, dependencies: GuestDependencies): Promise<void> {
  if (dependencies.env.SHAREDNET_MENTION_GATE !== "1") return;
  const paths = controlPaths(dependencies.env, state);
  const raw = Number(dependencies.env.SHAREDNET_TURN_THROUGH ?? 0);
  const through = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  const read = await readThrough(paths);
  const messages = await boardMessages(client, state, credential.member_token, Math.max(through, read));
  const pending = pendingMentions(messages, { memberId: state.member_id, name: credential.name }, through, read);
  if (!pending.length) return;
  const maximum = Math.max(...pending.map(m => m.sequence));
  await controlEvent(paths, { kind: "mention_injected", sequences: pending.map(m => m.sequence), turn_through: through, previous_read: read });
  await noteRead(paths, maximum);
  throw localError("unread_mentions", "Nothing was posted. These addressed messages are now supplied to you. Consider them, then explicitly retry or revise your post; no reply is required.\n" + JSON.stringify(pending));
}

/** How many recent tasks a claimant is shown before its claim: SHAREDNET_TASK_RECENT, default 20. */
function taskReviewCount(env: GuestDependencies["env"]): number {
  const n = Number(env.SHAREDNET_TASK_RECENT ?? 20);
  return Number.isSafeInteger(n) && n > 0 ? n : 20;
}

async function task(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const [action, title] = parsed.positionals;
  if (!(["claim", "done"].includes(action ?? "") && parsed.positionals.length === 2) && !(action === "list" && parsed.positionals.length === 1)) {
    throw localError("invalid_arguments", 'Usage: sharednet task claim "<title>" | done "<title>" | list');
  }
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  if (credential.room_type === "compiled") throw localError("invalid_room_type", "Title tasks are for plain board Rooms; compiled Rooms use acts.");
  const paths = controlPaths(dependencies.env, state);
  return withControlLock(paths, "task", async () => {
    let history: BoardMessage[] = [];
    const list = async () => { history = await boardMessages(client, state, credential.member_token); return history; };
    const post = async (content: string) => {
      const result = await client.request<{ message: BoardMessage }>("POST", `/rooms/${encodeURIComponent(state.room_id)}/messages`, credential.member_token, { content }, { "idempotency-key": randomUUID() });
      if (!result.message?.sequence) throw localError("task_state_incomplete", "The task post has no committed sequence.");
      return result.message;
    };
    if (action === "list") {
      const tasks = projectTasks(await list());
      await noteTasks(paths, tasks, state.member_id);
      await noteTasksSeen(paths, latestForeignTaskSequence(history, state.member_id));
      return { room_id: state.room_id, member_id: state.member_id, tasks };
    }
    // Validate the title before any network side effect.
    const content = taskMessage(action as "claim" | "done", title!);
    await beforeSay(client, state, credential, dependencies);
    if (action === "claim") {
      // Look before claiming: teammates' newer tasks are shown first, and nothing is claimed until the claim is repeated.
      const latest = latestForeignTaskSequence(await list(), state.member_id);
      const seen = await readMark(paths.taskSeen);
      if (latest > seen) {
        const recent = recentTasks(projectTasks(history), taskReviewCount(dependencies.env))
          .map(t => ({ title: t.title, owner: t.owner_name ?? t.owner, status: t.status }));
        await controlEvent(paths, { kind: "claim_review", title: title!, latest, shown: recent.length });
        await noteTasksSeen(paths, latest);
        throw localError("review_tasks", "Nothing was claimed. Compare your title with these recent tasks, newest first. If your work is the same as one of them, do not claim it: pick other work, or coordinate with its owner. Otherwise run the same claim again.\n" + JSON.stringify(recent));
      }
      try {
        const claimed = await claimTask({ list, post }, state.member_id, title!);
        const tasks = projectTasks(history);
        await noteTasks(paths, tasks, state.member_id);
        // Claims committed between the last look and this one crossed it: the claimant could not have seen them.
        const crossed = tasks.filter(t => t.owner !== state.member_id && t.claim_sequence > seen && t.claim_sequence < claimed.claim_sequence)
          .map(t => ({ title: t.title, owner: t.owner_name ?? t.owner, status: t.status }));
        await noteTasksSeen(paths, claimed.claim_sequence);
        await controlEvent(paths, { kind: "task_claimed", task: claimed, crossed: crossed.length });
        return { room_id: state.room_id, task: claimed, ...(crossed.length ? { crossed, note: "These tasks were claimed just before yours, unseen by you. If one is the same work, coordinate with its owner." } : {}) };
      } catch (error) {
        // Never grant shell access from an unconfirmed claim. `task list` can recover it.
        await controlEvent(paths, { kind: "task_claim_refused", title: title!, code: error instanceof CliError ? error.code : "service_unavailable" });
        throw error;
      }
    }
    const key = title!.toLowerCase().replace(/\s/gu, "");
    const before = projectTasks(await list());
    const owned = before.find(t => t.key === key);
    if (!owned || owned.owner !== state.member_id || owned.status !== "claimed") throw localError("task_not_owned", "Only the owner of an active task can mark it done.");
    // Fail closed if POST succeeds but the response or subsequent replay is lost.
    // A later task list can restore a task whose completion did not commit.
    await controlEvent(paths, { kind: "task_released", task: owned });
    await noteTasks(paths, before.filter(t => t.key !== key), state.member_id);
    const posted = await post(content);
    const tasks = projectTasks(await list());
    const done = tasks.find(t => t.key === key);
    if (done?.status !== "done" || !history.some(m => m.sequence === posted.sequence)) throw localError("task_state_incomplete", "Completion replay is incomplete. Run sharednet task list.");
    await noteTasks(paths, tasks, state.member_id);
    await controlEvent(paths, { kind: "task_done", task: done });
    return { room_id: state.room_id, task: done };
  });
}

/** One long-poll from the cursor; the server answers within `timeout` seconds. */
/** How long a sit keeps trying when the service is unreachable, and how fast it backs off. */
const POLL_RETRY_LIMIT = 8;
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_CAP_MS = 30_000;

/** A request with nothing else to bound it waits at most the server's own cap, and this much more. */
const REQUEST_SLACK_MS = 5_000;
/** A check that must not wait (`--timeout 0`, `--hook`) gives each request this long. */
const CHECK_REQUEST_MS = 5_000;
/** Even at its deadline, a request a wait still has to make (the read a wake needs) gets this long. */
const LATE_REQUEST_MS = 1_000;

/**
 * Every request a wait makes is bounded, its setup included: a lease refresh, a legacy seat's
 * identity lookup, the long-poll, the read after it. A server that takes the connection and never
 * answers must not hold a caller past its --timeout, and must not hold a hook (which blocks the
 * Agent's turn) at all. From Dots's sharednet-client PR 4.
 */
function boundedFetch(dependencies: GuestDependencies, deadline: number | null, check: boolean): typeof globalThis.fetch {
  return (input, init) => {
    const limit = check
      ? CHECK_REQUEST_MS
      : Math.min(
          WAIT_MAX_SECONDS * 1000 + REQUEST_SLACK_MS,
          deadline === null ? Number.POSITIVE_INFINITY : Math.max(LATE_REQUEST_MS, deadline - dependencies.now().getTime()),
        );
    const timeout = AbortSignal.timeout(limit);
    return dependencies.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

/**
 * A request the wait's own deadline cut off. For a wait that was given time (`--timeout N`, N > 0),
 * that is a quiet wait, not a failure: nothing was said in time. A wait given no time (`--timeout 0`)
 * cannot have been cut by its deadline, so there it stays a failure.
 */
function cutByDeadline(error: unknown, deadline: number | null, now: number): boolean {
  return deadline !== null && now >= deadline && error instanceof CliError && error.code === "service_unavailable";
}

/** The wait filters, validated the way `read` validates the same flags. */
export function waitFiltersFrom(options: Map<string, string | true>): URLSearchParams {
  const value = (name: string): string | undefined => {
    const raw = options.get(name);
    return typeof raw === "string" ? raw : undefined;
  };
  const parameters = new URLSearchParams();
  const fromInstance = value("from-instance");
  if (fromInstance !== undefined) {
    if (!/^i_[0-9A-Za-z]{10}$/.test(fromInstance)) {
      throw localError("invalid_arguments", "--from-instance takes an Instance id such as i_AbCdEfGhIj, not a display name.");
    }
    parameters.set("sender_instance_id", fromInstance);
  }
  const fromAgent = value("from-agent");
  if (fromAgent !== undefined) {
    if (fromAgent !== "default" && !/^a_[0-9A-Za-z]{10}$/.test(fromAgent)) {
      throw localError("invalid_arguments", "--from-agent takes an Agent id such as a_AbCdEfGhIj, or default.");
    }
    parameters.set("sender_agent_id", fromAgent);
  }
  const grep = value("grep");
  if (grep !== undefined) {
    if (grep.length === 0 || [...grep].length > 256) {
      throw localError("invalid_arguments", "--grep takes 1 to 256 characters.");
    }
    parameters.set("q", grep);
  }
  return parameters;
}

/**
 * A sit outlives a blip.
 *
 * A wait with no `--timeout` is meant to last until someone speaks, which can be hours. One failed
 * poll used to end it, so an unattended watcher died on the first hiccup and nothing woke when the
 * message finally came — the wake was lost, not delayed. Retrying is what makes "it will wake you"
 * true rather than aspirational.
 *
 * Only reaching the service is retried. An answer that says no — a revoked seat, a closed Room —
 * is the service working, and is raised at once rather than hidden behind eight more attempts.
 */
async function pollThroughBlips<T>(
  poll: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  dependencies: GuestDependencies,
  deadline: number | null = null,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await poll();
    } catch (error) {
      const code = error instanceof CliError ? error.code : "";
      const reachable = code !== "service_unavailable" && code !== "invalid_server_response";
      const backoff = Math.min(POLL_RETRY_BASE_MS * 2 ** attempt, POLL_RETRY_CAP_MS);
      // A wait with a deadline never retries past it: its caller asked for an answer by then.
      const late = deadline !== null && dependencies.now().getTime() + backoff >= deadline;
      if (reachable || late || attempt >= POLL_RETRY_LIMIT) throw error;
      dependencies.stderr?.(
        `waiting: the service was unreachable (${code}); retrying in ${Math.round(backoff / 1000)}s, attempt ${attempt + 1} of ${POLL_RETRY_LIMIT}\n`,
      );
      await sleep(backoff);
    }
  }
}

async function waitPage(
  client: ApiClient,
  roomId: string,
  token: string,
  after: number,
  timeout: number,
  filters: URLSearchParams = new URLSearchParams(),
): Promise<PageShape> {
  const query = new URLSearchParams({ after: String(after), timeout: String(timeout) });
  for (const [key, value] of filters) query.set(key, value);
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/wait?${query.toString()}`,
    token,
  );
  if (!Array.isArray(page?.items)) throw invalidServerResponse();
  // Only what is past the cursor: a page that repeats what was already handed over must not hand
  // it over twice.
  return { ...page, items: page.items.filter((item) => Number.isSafeInteger(item.sequence) && item.sequence > after) };
}

/**
 * Everything said in (after, through], unfiltered and in order.
 *
 * A filter decides when a seat wakes, never what it is handed. The server answers a filtered wait
 * with the matching messages only, and the cursor is about to move past everything said between
 * them: the context of the message the seat waited for, which nothing shows it again once the
 * cursor is past. So the span the cursor crosses is read once more, without the filter.
 */
async function everythingSaid(
  client: ApiClient,
  roomId: string,
  token: string,
  after: number,
  through: number,
): Promise<MessageShape[]> {
  const items: MessageShape[] = [];
  let from = after;
  while (from < through) {
    const start = from;
    const page = await client.request<PageShape>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/messages?after=${start}&limit=100`,
      token,
    );
    if (!Array.isArray(page?.items)) throw invalidServerResponse();
    items.push(...page.items.filter((item) => item.sequence > start && item.sequence <= through));
    const next = highestSequence(page.items, start);
    if (next === start) break;
    from = next;
  }
  return items;
}

/** How much of a Room a join hands over: its newest lines, at most this many. */
const JOIN_HISTORY = 100;

/**
 * The history a join hands over: the newest lines, oldest first, so the seat's place starts at the
 * Room's end. Its oldest lines would put the place there instead, and the first wake would carry
 * everything said since, however much that is; `sharednet read` reaches back further on request.
 */
async function latestHistory(client: ApiClient, roomId: string, token: string): Promise<PageShape> {
  const page = await client.request<PageShape>("GET", `/rooms/${encodeURIComponent(roomId)}/messages?order=desc&limit=${JOIN_HISTORY}`, token);
  if (!Array.isArray(page?.items)) throw invalidServerResponse();
  return { ...page, items: [...page.items].sort((a, b) => a.sequence - b.sequence) };
}

/**
 * A seat file without its wake. A join saves this first, so the seat is never lost, and a running
 * `serve` (which drives only seats with a wake) leaves it alone until the join has read its history and
 * set its place; only then is the wake written, and a failed join never activates one.
 */
function unwoken(credential: StoredRoomCredential): StoredRoomCredential {
  const { wake: _activatedLater, ...rest } = credential;
  return rest;
}

/** Transport trouble and 5xx (exit 5) or a rate limit: the next try may work. */
function temporaryFailure(error: CliError): boolean {
  return error.exitCode === 5 || error.code === "rate_limited";
}

/**
 * The newest history for a seat that is already joined and saved. A temporary failure falls back to
 * the page the service handed over with the join, when there is one, and says the join is degraded:
 * its place is that page's end, and the next wake carries the rest. Anything else (a refusal, or no
 * page to fall back to) fails the join out loud, naming the saved seat to enter again.
 */
async function readJoinHistory(
  client: ApiClient,
  roomId: string,
  token: string,
  seatId: string,
  fallback: PageShape | null,
  dependencies: GuestDependencies,
): Promise<{ history: PageShape; degraded: boolean }> {
  try {
    return { history: await latestHistory(client, roomId, token), degraded: false };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (fallback !== null && temporaryFailure(error)) {
      dependencies.stderr?.(`The Room's newest lines could not be read (${error.code}), so this join is degraded: it hands over the service's first page instead, and the next wake carries everything after it.\n`);
      return { history: fallback, degraded: true };
    }
    throw new CliError(
      error.code,
      `Joined ${roomId} as ${seatId} and saved the seat, but its history could not be read (${error.code}: ${error.message}). Nothing was marked as read. Enter the seat again with: sharednet join ${roomId} --as ${seatId}`,
      error.exitCode,
      error.requestId,
    );
  }
}

/** A join hands over the history it returns, so the seat's place starts after it, as the MCP join's does. */
async function historyHandled(client: ApiClient, roomId: string, token: string, through: number, seatId: string, dependencies: GuestDependencies): Promise<void> {
  if (through <= 0) return;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Strict, unlike acknowledgeThrough elsewhere: a running serve starts a seat from the service's mark,
  // so a join whose mark did not move must not turn the wake on, or the history would be replayed.
  try {
    await pollThroughBlips(() => client.request("POST", `/rooms/${encodeURIComponent(roomId)}/ack`, token, { through }), sleep, dependencies);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(
      error.code,
      `Joined ${roomId} as ${seatId} and saved the seat, but the service did not take its place through ${through} (${error.code}: ${error.message}), so its wake was left off. Enter the seat again with: sharednet join ${roomId} --as ${seatId}`,
      error.exitCode,
      error.requestId,
    );
  }
}

/**
 * Where this seat stands in its Room, as the service keeps it (wait PR 5): the last sequence it has
 * finished handling. Every door moves the same mark, whatever directory, connector or chat product
 * it runs in. The seat file and the connector's cursor file only mirror it: whichever is further
 * along wins and the service is told, so progress made earlier, or by an older CLI, is carried
 * over instead of handed over again.
 */
async function keptPlace(
  client: ApiClient,
  roomId: string,
  token: string,
  local: number,
  sleep: (ms: number) => Promise<void>,
  dependencies: GuestDependencies,
  deadline: number | null = null,
): Promise<number> {
  const kept = await pollThroughBlips(
    () => client.request<{ subscription?: { acked_through?: unknown } }>("GET", `/rooms/${encodeURIComponent(roomId)}/subscription`, token),
    sleep,
    dependencies,
    deadline,
  );
  const acked = kept?.subscription?.acked_through;
  if (typeof acked !== "number" || !Number.isSafeInteger(acked)) throw invalidServerResponse();
  if (local <= acked) return acked;
  await acknowledgeThrough(client, roomId, token, local, sleep, dependencies, deadline);
  return local;
}

/**
 * Tells the service this seat has handled everything through `through`. Acks are cumulative, so one
 * that is lost is covered by the next. A lost one never undoes the work: the mirror keeps this
 * directory from handing the same messages over again, so it is reported, not raised.
 */
async function acknowledgeThrough(
  client: ApiClient,
  roomId: string,
  token: string,
  through: number,
  sleep: (ms: number) => Promise<void>,
  dependencies: GuestDependencies,
  deadline: number | null = null,
): Promise<void> {
  try {
    await pollThroughBlips(
      () => client.request("POST", `/rooms/${encodeURIComponent(roomId)}/ack`, token, { through }),
      sleep,
      dependencies,
      deadline,
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    dependencies.stderr?.(`the service did not take the acknowledgement through ${through} (${error.code}); the next one covers it\n`);
  }
}

function defaultExec(command: string, input: string, env: Record<string, string>) {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawn(shell[0]!, shell.slice(1), {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => resolve({ exitCode: 127, stdout, stderr: stderr + String(error) }));
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(input);
    } catch (error) {
      resolve({ exitCode: 127, stdout, stderr: String(error) });
    }
  });
}

/** One handled (or attempted) wake of a resident wait. */
interface SitRun {
  run: number;
  /** The first trigger that fired; `fired` lists every one that had. */
  trigger: string;
  fired: string[];
  wake_id: string;
  messages: number;
  /** ok: handled and the cursor moved; failed: the command failed; reply_failed: the Room did not take the reply. */
  status: "ok" | "failed" | "reply_failed";
  exit_code: number;
  reply_message_id: string | null;
  last_sequence: number;
}

/** What a wake carries: every message since the last handled wake, and why it woke. */
interface Wake {
  wake_id: string | null;
  room_id: string;
  member_id: string;
  /** The first trigger that fired, kept for commands written when there was only one. */
  trigger: string | null;
  fired: string[];
  messages: MessageShape[];
  events: Array<Record<string, unknown>>;
  /** The handled cursor this wake starts after, and the read cursor it runs to. */
  from: number;
  through: number;
}

/** How often a `closed` wait looks at the Room, and how often a `check` runs by default. */
const ROOM_CHECK_MS = 30_000;
const DEFAULT_CHECK_EVERY_MS = 60_000;
/** A check's output is evidence, not a transcript: it is cut to this many characters. */
const CHECK_OUTPUT_LIMIT = 4_000;
/** Kinds that fire on what was said; the rest fire on the clock or on the world. */
const SAID_KINDS = new Set(["message", "mention", "said", "count", "idle"]);

function boundedOutput(value: string): string {
  const characters = [...value];
  return characters.length <= CHECK_OUTPUT_LIMIT ? value : `${characters.slice(-CHECK_OUTPUT_LIMIT).join("")}`;
}

/**
 * The triggers named by `--on`, in order, without repeats. A bare `--on every`
 * finds its parameter in the next argument, which is how `watch --on count 2`
 * was always written.
 */
function triggersFrom(parsed: ParsedGuestArguments, now: number): Trigger[] {
  const triggers: Trigger[] = [];
  for (const raw of parsed.repeated.get("on") ?? []) {
    let spec = raw;
    if (triggerTakesParameter(raw)) {
      const parameter = parsed.positionals.shift();
      if (parameter !== undefined) spec = `${raw} ${parameter}`;
    }
    const trigger = parseTrigger(spec, now);
    if (!triggers.some((existing) => existing.label === trigger.label)) triggers.push(trigger);
  }
  return triggers;
}

/** Older clients stored no mode. Learn the immutable mode once with this seat's credential. */
async function hydrateRoomMode(client: ApiClient, credential: StoredRoomCredential, dependencies: GuestDependencies): Promise<void> {
  if (credential.room_type !== undefined) return;
  const view = await client.request<{ room?: { type?: string } }>("GET", `/rooms/${encodeURIComponent(credential.room_id)}`, credential.member_token);
  if (!view.room || (view.room.type !== undefined && view.room.type !== "board" && view.room.type !== "compiled")) throw invalidServerResponse();
  credential.room_type = view.room.type === "compiled" ? "compiled" : "board";
  await writeRoomCredential(getStoragePaths(dependencies.env), credential);
}

async function roomView(
  client: ApiClient,
  roomId: string,
  token: string,
): Promise<{ state: string | null; memberships: Array<{ member_id?: string; name?: string | null }> }> {
  const view = await client.request<{ room?: { state?: string }; memberships?: Array<{ member_id?: string; name?: string | null }> }>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}`,
    token,
  );
  return { state: view?.room?.state ?? null, memberships: Array.isArray(view?.memberships) ? view.memberships : [] };
}

/** A wake delivered with `--ack manual` waits here until `sharednet ack` moves the cursor past it. */
function pendingWakePath(cwd: string, memberId: string): string {
  return joinPath(cwd, ".sharednet", "wakes", `${memberId}.json`);
}

async function readPendingWake(cwd: string, memberId: string): Promise<{ wake_id: string; room_id: string; through: number } | null> {
  try {
    const value = JSON.parse(await readFile(pendingWakePath(cwd, memberId), "utf8"));
    if (typeof value?.wake_id === "string" && typeof value?.room_id === "string" && Number.isSafeInteger(value?.through)) {
      return { wake_id: value.wake_id, room_id: value.room_id, through: value.through };
    }
    return null;
  } catch {
    return null;
  }
}

async function writePendingWake(cwd: string, memberId: string, wake: { wake_id: string; room_id: string; from: number; through: number }): Promise<void> {
  await mkdir(joinPath(cwd, ".sharednet", "wakes"), { recursive: true });
  await writeFile(pendingWakePath(cwd, memberId), `${JSON.stringify({ schema_version: 1, ...wake })}\n`, { mode: 0o600 });
}

/** One line per wake, for whoever keeps the record of a run (goal mode's wakes.ndjson). */
async function appendWakeLog(path: string | null, record: Record<string, unknown>): Promise<void> {
  if (path === null) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function parseTimeout(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) {
    throw localError("invalid_timeout", "--timeout must be a whole number of seconds.");
  }
  return Number(value);
}

const WAIT_USAGE =
  "Usage: sharednet wait [--on <trigger>]... [--run '<command>' [--reply] [--max-runs <n>] [--max-failures <n>]] [--ack on-delivery|manual|after-run] [--timeout <seconds>] [--settle <duration>] [--check-every <duration>] [--log <file>] [--from-instance i_…] [--from-agent a_…|default] [--grep TEXT] [--as <member_id>]; or, as before, sharednet wait [--timeout <seconds>] [--min <count>] [--hook]";

/**
 * One wait (decision 2026-10-05): sit in the Room until any `--on` trigger
 * fires, then hand over a wake: every other member's message since the last
 * handled wake, and the reason it woke.
 *
 * Without `--run` it returns that one wake. `--ack on-delivery` (the default)
 * moves the cursor as it returns; `--ack manual` leaves it, and `sharednet ack
 * <wake_id>` moves it once the caller has done the work, so a caller that dies
 * mid-way is handed the same wake again.
 *
 * With `--run` it stays: each wake goes to the command's stdin as JSON and, with
 * `--reply`, what the command prints is said back into the Room. The cursor moves
 * only once a wake has been handled and its reply is in the Room; a wake the
 * command fails on is offered again, with the same idempotency key for its
 * reply, and after `--max-failures` attempts the wait stops and says so. That is
 * what `watch` always was; `watch` is this, with `--run` required.
 *
 * The seat's own words never wake it, which is what keeps a replying wait from
 * talking to itself.
 */
async function sit(verb: "wait" | "watch", parsed: ParsedGuestArguments, dependencies: GuestDependencies): Promise<unknown> {
  const resident = ["on", "run", "reply", "max-runs", "max-failures", "as", "from-instance", "from-agent", "grep", "log", "settle", "check-every", "ack"];
  assertOnlyOptions(parsed, verb === "watch" ? resident : [...resident, "timeout"]);
  const startedAt = dependencies.now().getTime();
  const triggers = triggersFrom(parsed, startedAt);
  if (triggers.length === 0) triggers.push({ kind: "message", label: "message" });
  const command = stringOption(parsed, "run");
  if ((verb === "watch" && !command) || parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      verb === "watch"
        ? "Usage: sharednet watch --on <trigger> [--on <trigger>]... --run '<command>' [--reply] [--from-instance i_…] [--from-agent a_…|default] [--grep TEXT] [--max-runs <n>] [--max-failures <n>] [--log <file>] [--as <member_id>]"
        : WAIT_USAGE,
    );
  }
  const reply = parsed.options.get("reply") === true;
  if (!command && (reply || parsed.options.has("max-runs") || parsed.options.has("max-failures"))) {
    throw localError("invalid_arguments", "--reply, --max-runs and --max-failures belong to a wait that runs a command (--run).");
  }
  const ackOption = stringOption(parsed, "ack");
  const ack = ackOption ?? (command ? "after-run" : "on-delivery");
  if (command ? ack !== "after-run" : ack !== "on-delivery" && ack !== "manual") {
    throw localError(
      "invalid_arguments",
      command
        ? "A wait that runs a command acknowledges after the run (--ack after-run); that is what makes a crash lose nothing."
        : "--ack takes on-delivery (the cursor moves as the wake is returned) or manual (sharednet ack <wake_id> moves it).",
    );
  }
  const filters = waitFiltersFrom(parsed.options);
  const settleMs = parsed.options.has("settle") ? parseDuration(stringOption(parsed, "settle"), "--settle") : 0;
  const checkEveryMs = parsed.options.has("check-every")
    ? parseDuration(stringOption(parsed, "check-every"), "--check-every")
    : DEFAULT_CHECK_EVERY_MS;
  const timeoutSeconds = command ? null : parseTimeout(stringOption(parsed, "timeout"));
  const logOption = stringOption(parsed, "log");
  const logPath = logOption === undefined ? null : resolvePath(dependencies.cwd, logOption);
  const maxRuns = parseCount(stringOption(parsed, "max-runs"), "--max-runs");
  const maxFailures = parseCount(stringOption(parsed, "max-failures"), "--max-failures") ?? 3;

  const deadline = timeoutSeconds === null ? null : startedAt + timeoutSeconds * 1000;
  const { client, state, credential } = await currentSeat(
    { ...dependencies, fetch: boundedFetch(dependencies, deadline, timeoutSeconds === 0) },
    stringOption(parsed, "as"),
  );
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec = dependencies.exec ?? defaultExec;
  const log = dependencies.stderr ?? (() => undefined);
  if (command) await hydrateRoomMode(client, credential, dependencies);
  const me = await whoAmI(client, state, credential);
  const iso = (ms: number) => new Date(ms).toISOString();
  // A wait that wakes only when addressed asks the service for those lines alone (wait PR 8): one
  // message to one seat wakes one seat, not every seat in the Room. Once it wakes, the wake still
  // carries everything said since the last one handled.
  const said = triggers.filter((trigger) => SAID_KINDS.has(trigger.kind));
  if (said.length > 0 && said.every((trigger) => trigger.kind === "mention")) filters.set("mentions", me);

  // What the clock-free triggers need from the Room: the seat's own name for
  // `mention`, the Room's state for `closed`. Looked up once, and `closed`
  // again every half minute.
  const wantsClosed = triggers.some((trigger) => trigger.kind === "closed");
  let myName: string | null = null;
  let closed = false;
  let lastRoomCheckAt: number | null = null;
  if (wantsClosed || triggers.some((trigger) => trigger.kind === "mention")) {
    const view = await roomView(client, state.room_id, credential.member_token).catch(() => null);
    if (view) {
      myName = view.memberships.find((member) => member.member_id === me)?.name ?? null;
      closed = view.state === "closed";
    }
    lastRoomCheckAt = startedAt;
  }

  // The service keeps this seat's place (wait PR 5); a wake starts after what it has handled.
  const start = await keptPlace(client, state.room_id, credential.member_token, state.last_sequence, sleep, dependencies, deadline);
  let cursor = start;
  let persisted = start;
  let batch: MessageShape[] = [];
  let lastRunAt = startedAt;
  let lastMessageAt: number | null = null;
  const cronDue = new Map<string, number>();
  for (const trigger of triggers) if (trigger.kind === "cron") cronDue.set(trigger.label, nextCronTime(trigger.schedule, startedAt));
  const spent = new Set<string>();
  const checks = new Map<string, { passing: boolean; ranAt: number | null; fire: { exit_code: number; output: string; at: string } | null }>();
  for (const trigger of triggers) if (trigger.kind === "check") checks.set(trigger.label, { passing: false, ranAt: null, fire: null });
  let pending: { wakeId: string; replyKey: string; reply: string | null; failures: number } | null = null;
  const runs: SitRun[] = [];
  const summaryLabel = triggers.map((trigger) => trigger.label).join(" | ");
  if (command) log(`${verb}: ${summaryLabel} in ${state.room_id} as ${me}, from sequence ${cursor}\n`);

  const isDue = (trigger: Trigger, at: number): boolean => {
    // A burst is one wake: what was said fires only once the Room has been quiet for --settle.
    const settled = lastMessageAt === null || at - lastMessageAt >= settleMs;
    switch (trigger.kind) {
      case "message":
        return batch.length > 0 && settled;
      case "mention":
        // The service resolved whom each line addresses, an account seat's tag included; the local
        // rule covers a service that predates that.
        return settled && batch.some((item) => item.mentions?.includes(me) || mentions(item.content, { memberId: me, name: myName }));
      case "said":
        return settled && batch.some((item) => saidIn(item.content, trigger));
      case "count":
        return batch.length >= trigger.count && settled;
      case "idle":
        return batch.length > 0 && lastMessageAt !== null && at - lastMessageAt >= trigger.ms;
      case "every":
        return at - lastRunAt >= trigger.ms;
      case "cron":
        return at >= cronDue.get(trigger.label)!;
      case "after":
        return !spent.has(trigger.label) && at >= startedAt + trigger.ms;
      case "at":
        return !spent.has(trigger.label) && at >= trigger.time;
      case "check":
        return checks.get(trigger.label)!.fire !== null;
      case "closed":
        return closed;
    }
  };
  /** How long until a trigger could fire by itself, so a long-poll never sleeps through it. */
  const dueIn = (trigger: Trigger, at: number): number => {
    switch (trigger.kind) {
      case "every":
        return lastRunAt + trigger.ms - at;
      case "idle":
        return batch.length > 0 && lastMessageAt !== null ? lastMessageAt + trigger.ms - at : Number.POSITIVE_INFINITY;
      case "cron":
        return cronDue.get(trigger.label)! - at;
      case "after":
        return spent.has(trigger.label) ? Number.POSITIVE_INFINITY : startedAt + trigger.ms - at;
      case "at":
        return spent.has(trigger.label) ? Number.POSITIVE_INFINITY : trigger.time - at;
      case "check": {
        const check = checks.get(trigger.label)!;
        return check.ranAt === null ? 0 : check.ranAt + checkEveryMs - at;
      }
      case "closed":
        return lastRoomCheckAt === null ? 0 : lastRoomCheckAt + ROOM_CHECK_MS - at;
      default:
        return settleMs > 0 && batch.length > 0 && lastMessageAt !== null ? lastMessageAt + settleMs - at : Number.POSITIVE_INFINITY;
    }
  };

  const stopUnhandled = (unhandled: MessageShape[]): never => {
    const first = unhandled[0]?.sequence ?? persisted + 1;
    const last = unhandled.at(-1)?.sequence ?? cursor;
    throw new CliError(
      `${verb}_failed`,
      `${verb} stopped with ${unhandled.length} message(s) unhandled after ${pending?.failures ?? 0} failed attempt(s), sequences ${first}-${last}. The cursor stays at ${persisted}; \`sharednet wait\` shows them again.`,
      4,
    );
  };

  for (;;) {
    // The world first: a check that has started to pass, a Room that has closed.
    let now = dependencies.now().getTime();
    for (const trigger of triggers) {
      if (trigger.kind !== "check") continue;
      const check = checks.get(trigger.label)!;
      if (check.ranAt !== null && now - check.ranAt < checkEveryMs) continue;
      const result = await exec(trigger.command, "", {
        SHAREDNET_ROOM_ID: state.room_id,
        SHAREDNET_MEMBER_ID: state.member_id,
        SHAREDNET_LAST_SEQUENCE: String(cursor),
      });
      check.ranAt = dependencies.now().getTime();
      const passing = result.exitCode === 0;
      // It fires when it starts to pass, not on every minute it keeps passing.
      if (passing && !check.passing) {
        check.fire = { exit_code: 0, output: boundedOutput(`${result.stdout}${result.stderr}`), at: iso(check.ranAt) };
      }
      check.passing = passing;
    }
    if (wantsClosed && !closed && (lastRoomCheckAt === null || now - lastRoomCheckAt >= ROOM_CHECK_MS)) {
      const view = await roomView(client, state.room_id, credential.member_token).catch(() => null);
      lastRoomCheckAt = dependencies.now().getTime();
      if (view?.state === "closed") closed = true;
    }

    now = dependencies.now().getTime();
    let budgetMs = WAIT_MAX_SECONDS * 1000;
    for (const trigger of triggers) budgetMs = Math.min(budgetMs, dueIn(trigger, now));
    if (deadline !== null) budgetMs = Math.min(budgetMs, deadline - now);
    // Something already fired that does not depend on what is said: look once, quickly, and go.
    if (triggers.some((trigger) => !SAID_KINDS.has(trigger.kind) && isDue(trigger, now))) budgetMs = 0;
    const timeout = Math.min(WAIT_MAX_SECONDS, Math.max(0, Math.ceil(budgetMs / 1000)));
    // --max-failures counts the command and the reply, never the poll, so an unguarded poll ended
    // the whole watch on the first hiccup. A watcher is the one thing that must outlive a blip.
    let page: PageShape;
    try {
      page = await pollThroughBlips(
        () => waitPage(client, state.room_id, credential.member_token, cursor, timeout, filters),
        sleep,
        dependencies,
        deadline,
      );
    } catch (error) {
      if (timeoutSeconds !== null && timeoutSeconds > 0 && cutByDeadline(error, deadline, dependencies.now().getTime())) {
        // Nothing was said in time; the timed-out wake below says so.
        page = { items: [], next_cursor: null, has_more: false };
      } else if (wantsClosed && error instanceof CliError && error.code === "room_closed") {
        closed = true;
        page = { items: [], next_cursor: null, has_more: false };
      } else {
        throw error;
      }
    }
    cursor = highestSequence(page.items, cursor);
    const others = page.items.filter((item) => !isOwn(item, me, state.member_id));
    if (others.length > 0) {
      batch.push(...others);
      lastMessageAt = dependencies.now().getTime();
    }

    const at = dependencies.now().getTime();
    const firedTriggers = triggers.filter((trigger) => isDue(trigger, at));
    const timedOut = deadline !== null && at >= deadline;
    if (firedTriggers.length === 0 && !(timedOut && !command)) {
      if (page.items.length === 0) await sleep(0);
      continue;
    }

    const fired = firedTriggers.map((trigger) => trigger.label);
    // A filter chose the moment; the wake still carries everything said since the last handled one.
    const handed =
      filters.size > 0 && cursor > persisted
        ? (
            await pollThroughBlips(
              () => everythingSaid(client, state.room_id, credential.member_token, persisted, cursor),
              sleep,
              dependencies,
              deadline,
            )
          ).filter((item) => !isOwn(item, me, state.member_id))
        : batch;
    const events: Array<Record<string, unknown>> = handed.map((item) => ({ kind: "message", ...item }));
    for (const trigger of firedTriggers) {
      if (trigger.kind === "check") {
        events.push({ kind: "check", trigger: trigger.label, command: trigger.command, ...checks.get(trigger.label)!.fire! });
      } else if (trigger.kind === "closed") {
        events.push({ kind: "closed", trigger: trigger.label, at: iso(at) });
      } else if (!SAID_KINDS.has(trigger.kind)) {
        events.push({ kind: "timer", trigger: trigger.label, at: iso(at) });
      }
    }
    if (pending === null && fired.length > 0) {
      const identity = wakeIdentity({ roomId: state.room_id, memberId: state.member_id, from: persisted, through: cursor, fired, messageCount: handed.length, firedAt: at });
      pending = { wakeId: identity.wakeId, replyKey: identity.replyKey, reply: null, failures: 0 };
    }
    const wake: Wake = {
      wake_id: pending?.wakeId ?? null,
      room_id: state.room_id,
      member_id: state.member_id,
      trigger: fired[0] ?? null,
      fired,
      messages: handed,
      events,
      from: persisted,
      through: cursor,
    };
    // What has fired is spent once it is handled: a one-off does not fire twice, a calendar moves
    // to its next day, a check waits to start passing again.
    const spend = () => {
      for (const trigger of firedTriggers) {
        if (trigger.kind === "after" || trigger.kind === "at") spent.add(trigger.label);
        if (trigger.kind === "cron") cronDue.set(trigger.label, nextCronTime(trigger.schedule, at));
        if (trigger.kind === "check") checks.get(trigger.label)!.fire = null;
      }
    };

    if (!command) {
      // One wake, returned. Either the cursor moves now, or it waits for `sharednet ack`.
      if (ack === "manual") {
        if (wake.wake_id !== null) {
          await writePendingWake(dependencies.cwd, state.member_id, { wake_id: wake.wake_id, room_id: state.room_id, from: persisted, through: cursor });
        }
      } else if (cursor > persisted) {
        await acknowledgeThrough(client, state.room_id, credential.member_token, cursor, sleep, dependencies, deadline);
        await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
      }
      await appendWakeLog(logPath, {
        at: iso(at),
        verb,
        room_id: state.room_id,
        member_id: state.member_id,
        wake_id: wake.wake_id,
        fired,
        from: wake.from,
        through: wake.through,
        sequences: handed.map((item) => item.sequence),
        ack,
      });
      return wake;
    }

    pending ??= { wakeId: wake.wake_id ?? "", replyKey: randomUUID(), reply: null, failures: 0 };
    let exitCode = 0;
    let replyMessageId: string | null = null;
    let status: SitRun["status"] = "ok";
    // A reply the command already produced but the Room never received is
    // posted first, without running the command again.
    if (pending.reply === null) {
      const compiled = credential.room_type === "compiled"
        ? await client.request<CompiledState>("GET", `/rooms/${encodeURIComponent(state.room_id)}/state`, credential.member_token)
        : undefined;
      const input = `${JSON.stringify({ ...wake, ...(compiled ? { compiled } : {}) })}\n`;
      const result = await exec(command, input, {
        SHAREDNET_ROOM_ID: state.room_id,
        SHAREDNET_MEMBER_ID: state.member_id,
        SHAREDNET_MESSAGE_COUNT: String(handed.length),
        SHAREDNET_LAST_SEQUENCE: String(cursor),
        SHAREDNET_WAKE_ID: pending.wakeId,
        SHAREDNET_FIRED: fired.join(" | "),
      });
      if (result.stderr) log(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      exitCode = result.exitCode;
      if (exitCode !== 0) status = "failed";
      else if (reply && result.stdout.trim().length > 0) pending.reply = result.stdout.trim();
    }
    if (status === "ok" && pending.reply !== null) {
      try {
        const posted = await client.request<{ message?: { id?: string } }>(
          "POST",
          `/rooms/${encodeURIComponent(state.room_id)}/messages`,
          credential.member_token,
          { content: pending.reply },
          { "idempotency-key": pending.replyKey },
        );
        replyMessageId = posted?.message?.id ?? null;
      } catch (error) {
        status = "reply_failed";
        log(`${verb}: reply not posted (${error instanceof CliError ? error.code : "error"}); will retry with the same key\n`);
      }
    }

    if (status === "ok") {
      if (cursor > persisted) await acknowledgeThrough(client, state.room_id, credential.member_token, cursor, sleep, dependencies, deadline);
      persisted = cursor;
      await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: persisted });
      spend();
    } else {
      pending.failures += 1;
    }
    const record: SitRun = {
      run: runs.length + 1,
      trigger: fired[0]!,
      fired,
      wake_id: pending.wakeId,
      messages: handed.length,
      status,
      exit_code: exitCode,
      reply_message_id: replyMessageId,
      last_sequence: persisted,
    };
    runs.push(record);
    await appendWakeLog(logPath, {
      at: iso(at),
      verb,
      room_id: state.room_id,
      member_id: state.member_id,
      wake_id: record.wake_id,
      fired,
      from: wake.from,
      through: wake.through,
      sequences: handed.map((item) => item.sequence),
      status,
      exit_code: exitCode,
      reply_message_id: replyMessageId,
    });
    log(
      `${verb}: run ${record.run}, ${record.messages} message(s), ${status}` +
        (status === "failed" ? ` (exit ${exitCode})` : "") +
        (replyMessageId ? `, replied ${replyMessageId}` : "") +
        (status !== "ok" ? `, ${record.messages} message(s) kept for the next wake` : "") +
        "\n",
    );
    lastRunAt = dependencies.now().getTime();
    const handledClose = status === "ok" && firedTriggers.some((trigger) => trigger.kind === "closed");
    if (status === "ok") {
      batch = [];
      pending = null;
    } else if (pending.failures >= maxFailures) {
      stopUnhandled(handed);
    }
    // A closed Room has nothing more to say: the wait that was told so ends with it.
    if (handledClose) return { room_id: state.room_id, trigger: summaryLabel, runs, closed: true };
    if (maxRuns !== null && runs.length >= maxRuns) {
      if (pending !== null) stopUnhandled(handed);
      return { room_id: state.room_id, trigger: summaryLabel, runs };
    }
  }
}

async function watch(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  return sit("watch", parseGuestArguments(args), dependencies);
}

/**
 * `wait` as it always was — sit until something new is said, then print it
 * and advance the cursor; `--timeout N` bounds the sit in seconds (0 checks
 * once), `--min N` waits for N, `--hook` is the shape a Claude Code hook wants:
 * one immediate check, plain lines, exit 0 whether or not anything arrived —
 * and, with any of the newer options, the one wait above.
 */
async function wait(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  const newer = ["on", "run", "reply", "max-runs", "max-failures", "ack", "log", "settle", "check-every"];
  if (newer.some((name) => parsed.options.has(name))) {
    if (parsed.options.has("hook") || parsed.options.has("min")) {
      throw localError("invalid_arguments", "--hook and --min belong to the plain wait; with --on, use --on count <n> for a minimum.");
    }
    return sit("wait", parsed, dependencies);
  }
  assertOnlyOptions(parsed, ["timeout", "hook", "min", "as", "from-instance", "from-agent", "grep"]);
  if (parsed.positionals.length !== 0) {
    throw localError("invalid_arguments", WAIT_USAGE);
  }
  // The same filters a read takes, so being woken can be as narrow as reading is. On a Room with
  // thirty Agents, one message must not start thirty of them. They narrow when the caller wakes,
  // not what it is handed (everythingSaid).
  const filters = waitFiltersFrom(parsed.options);
  const hook = parsed.options.get("hook") === true;
  const totalSeconds = hook ? 0 : parseTimeout(stringOption(parsed, "timeout"));
  const minimum = parseCount(stringOption(parsed, "min"), "--min") ?? 1;
  const deadline =
    totalSeconds === null ? null : dependencies.now().getTime() + totalSeconds * 1000;
  const { client, state, credential } = await currentSeat(
    { ...dependencies, fetch: boundedFetch(dependencies, deadline, totalSeconds === 0) },
    stringOption(parsed, "as"),
  );
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const me = await whoAmI(client, state, credential);

  // The Room log is raw and includes what this seat said; the cursor moves
  // over all of it, but only other members' words wake the caller, count
  // toward --min, or come back. A page of nothing but one's own words is
  // consumed and the sit continues.
  const items: MessageShape[] = [];
  // The service keeps this seat's place (wait PR 5); the seat file mirrors it.
  const start = await keptPlace(client, state.room_id, credential.member_token, state.last_sequence, sleep, dependencies, deadline);
  let cursor = start;
  for (;;) {
    // Setup may already have spent the time this wait was given.
    if (totalSeconds !== null && totalSeconds > 0 && dependencies.now().getTime() >= deadline!) break;
    const remaining =
      deadline === null
        ? WAIT_MAX_SECONDS
        : Math.max(0, Math.ceil((deadline - dependencies.now().getTime()) / 1000));
    const timeout = Math.min(WAIT_MAX_SECONDS, remaining);
    let page: PageShape;
    try {
      page = await pollThroughBlips(
        () => waitPage(client, state.room_id, credential.member_token, cursor, timeout, filters),
        sleep,
        dependencies,
        deadline,
      );
    } catch (error) {
      if (totalSeconds !== null && totalSeconds > 0 && cutByDeadline(error, deadline, dependencies.now().getTime())) break;
      throw error;
    }
    const advanced = highestSequence(page.items, cursor) > cursor;
    cursor = highestSequence(page.items, cursor);
    items.push(...page.items.filter((item) => !isOwn(item, me, state.member_id)));
    if (items.length >= minimum) break;
    if (deadline !== null && dependencies.now().getTime() >= deadline) break;
    // The server answered at its cap, or with only our own words; ask again.
    if (!advanced) await sleep(0);
  }
  // A filter chose the moment; what comes back is everything said since the cursor, not only the match.
  if (filters.size > 0 && cursor > start) {
    const everything = await pollThroughBlips(
      () => everythingSaid(client, state.room_id, credential.member_token, start, cursor),
      sleep,
      dependencies,
      deadline,
    );
    items.splice(0, items.length, ...everything.filter((item) => !isOwn(item, me, state.member_id)));
  }
  const page: PageShape = { items, next_cursor: null, has_more: false };

  if (cursor > start) {
    await acknowledgeThrough(client, state.room_id, credential.member_token, cursor, sleep, dependencies, deadline);
    await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
  }

  if (hook) {
    return {
      hook: true,
      lines: page.items.map(
        (item) => `#${item.sequence} ${item.sender?.name ?? item.sender?.member_id ?? "member"}: ${item.content}`,
      ),
    };
  }
  return page;
}

/**
 * Acknowledge a wake delivered with `wait --ack manual`: the work is done, move
 * the cursor past it. Only the wake this seat is holding can be acknowledged,
 * and the cursor only ever moves forward.
 */
async function ackWake(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const [wakeId] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !/^wk_[A-Za-z0-9_-]{16}$/.test(wakeId!)) {
    throw localError("invalid_arguments", "Usage: sharednet ack <wk_…> [--as <member_id>]");
  }
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const held = await readPendingWake(dependencies.cwd, state.member_id);
  if (!held || held.wake_id !== wakeId || held.room_id !== state.room_id) {
    throw localError(
      "unknown_wake",
      "This seat is not holding that wake, so nothing moved. `sharednet wait --ack manual` shows what is pending.",
    );
  }
  // Asked for by name, so a refusal is reported and the wake stays held for another try.
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await pollThroughBlips(
    () => client.request("POST", `/rooms/${encodeURIComponent(state.room_id)}/ack`, credential.member_token, { through: held.through }),
    sleep,
    dependencies,
  );
  const lastSequence = Math.max(state.last_sequence, held.through);
  await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: lastSequence });
  const { rm } = await import("node:fs/promises");
  await rm(pendingWakePath(dependencies.cwd, state.member_id), { force: true });
  return { wake_id: wakeId, room_id: state.room_id, member_id: state.member_id, last_sequence: lastSequence };
}

/**
 * `sharednet handed`: the wakes this machine's connector handed to an open session that the session
 * has not settled. Listing only reads. `sharednet handed settle <rom_…> <through> --as <seat>` records
 * that the session handled that one hand-over, whether or not it replied.
 */
async function handedVerb(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const as = stringOption(parsed, "as");
  const [action, roomId, through] = parsed.positionals;
  const settling = action === "settle";
  if (
    (parsed.positionals.length !== 0 && !settling) ||
    (settling && (parsed.positionals.length !== 3 || !ROOM_ID_PATTERN.test(roomId!) || !/^\d+$/.test(through!) || as === undefined))
  ) {
    throw localError("invalid_arguments", "Usage: sharednet handed [--as <member_id>], or sharednet handed settle <rom_…> <through> --as <member_id>");
  }
  const paths = getStoragePaths(dependencies.env);
  const seats = (await heldSeats(paths)).filter((seat) => (as === undefined || seat.member_id === as) && (!settling || seat.room_id === roomId));
  if (as !== undefined && seats.length === 0) throw localError("not_in_a_room", "This machine holds no such seat.");
  if (settling) {
    const seat = seats[0]!;
    let found = false;
    await updateHanded(paths, seat.room_id, seat.member_id, (handed) => {
      found = handed.some((item) => item.through === Number(through));
      return handed.filter((item) => item.through !== Number(through));
    });
    if (!found) throw localError("invalid_arguments", `Seat ${seat.member_id} has no unsettled hand-over through #${through} in ${seat.room_id}.`);
    return { settled: { room_id: seat.room_id, member_id: seat.member_id, through: Number(through) } };
  }
  const unanswered: Array<HandedWake & { room_id: string; member_id: string; name: string }> = [];
  for (const seat of seats) {
    unanswered.push(...(await readHanded(paths, seat.room_id, seat.member_id)).map((item) => ({ ...item, room_id: seat.room_id, member_id: seat.member_id, name: seat.name })));
  }
  return { unanswered };
}

/** The read flags, as a query string: filter, order, window. `--last K` is newest-first, K of them. */
export function messageQueryFrom(options: Map<string, string | true>): URLSearchParams {
  const value = (name: string): string | undefined => {
    const raw = options.get(name);
    return typeof raw === "string" ? raw : undefined;
  };
  const parameters = new URLSearchParams();
  const last = value("last");
  const after = value("after");
  const before = value("before");
  const limit = value("limit");
  const order = value("order");
  for (const [name, raw] of [["after", after], ["before", before], ["limit", limit], ["last", last]] as const) {
    if (raw !== undefined && !/^\d+$/.test(raw)) throw localError("invalid_arguments", `--${name} takes a whole number.`);
  }
  if (last !== undefined && (after !== undefined || before !== undefined || limit !== undefined || order !== undefined)) {
    throw localError("invalid_arguments", "--last stands alone; use --order desc --limit K to combine.");
  }
  if (limit !== undefined && (Number(limit) < 1 || Number(limit) > 100)) throw localError("invalid_limit", "--limit must be an integer from 1 to 100.");
  if (last !== undefined && (Number(last) < 1 || Number(last) > 100)) throw localError("invalid_limit", "--last must be an integer from 1 to 100.");
  if (order !== undefined && order !== "asc" && order !== "desc") throw localError("invalid_arguments", "--order is asc or desc.");
  if (after !== undefined) parameters.set("after", after);
  if (before !== undefined) parameters.set("before", before);
  if (limit !== undefined) parameters.set("limit", limit);
  if (order !== undefined) parameters.set("order", order);
  if (last !== undefined) {
    parameters.set("order", "desc");
    parameters.set("limit", last);
  }
  const fromInstance = value("from-instance");
  if (fromInstance !== undefined) {
    if (!/^i_[0-9A-Za-z]{10}$/.test(fromInstance)) throw localError("invalid_arguments", "--from-instance takes an Instance id such as i_AbCdEfGhIj, not a display name.");
    parameters.set("sender_instance_id", fromInstance);
  }
  const fromAgent = value("from-agent");
  if (fromAgent !== undefined) {
    if (fromAgent !== "default" && !/^a_[0-9A-Za-z]{10}$/.test(fromAgent)) throw localError("invalid_arguments", "--from-agent takes an Agent id such as a_AbCdEfGhIj, or default.");
    parameters.set("sender_agent_id", fromAgent);
  }
  const grep = value("grep");
  if (grep !== undefined) {
    if (grep.length === 0 || [...grep].length > 256) throw localError("invalid_arguments", "--grep takes 1 to 256 characters.");
    parameters.set("q", grep);
  }
  return parameters;
}

export const READ_OPTIONS = ["after", "before", "limit", "order", "last", "from-instance", "from-agent", "grep"] as const;

/**
 * `sharednet read`: a window of this Room's log. Filter (grep, sender, tag),
 * order, window; the cursor is untouched, so reading is never "seeing".
 */
async function read(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, [...READ_OPTIONS, "as"]);
  if (parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet read [--grep TEXT] [--from-instance i_…] [--from-agent a_…|default] [--last K | --after N | --before N] [--limit K] [--order asc|desc]",
    );
  }
  const query = messageQueryFrom(parsed.options);
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(state.room_id)}/messages${query.size ? `?${query.toString()}` : ""}`,
    credential.member_token,
  );
  if (dependencies.env.SHAREDNET_MENTION_GATE === "1" && Array.isArray(page.items)) {
    await noteRead(controlPaths(dependencies.env, state), Math.max(0, ...page.items.map(m => m.sequence)));
  }
  // --last K is asked newest-first and shown oldest-first, the way a person reads a tail.
  if (parsed.options.has("last") && Array.isArray(page?.items)) {
    return { ...page, items: [...page.items].reverse() };
  }
  return page;
}

/**
 * `sharednet whoami`: who this machine acts as, and which seat this
 * directory holds, from the files alone. Ids only; never a key or a token.
 */
async function whoami(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet whoami");
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const stored = await readStoredApiCredential(paths).catch(() => null);
  const envKey = Boolean(dependencies.env.SHAREDNET_API_KEY?.trim());
  const account =
    stored && sameOrigin(stored.base_url, baseUrl)
      ? { principal_id: stored.principal_id, api_key_id: stored.api_key_id, source: "credentials_file" as const, credentials_file: paths.credentialsFile }
      : envKey
        ? { principal_id: null, api_key_id: null, source: "SHAREDNET_API_KEY" as const, credentials_file: null }
        : null;
  const room = await readProjectRoom(dependencies.cwd);
  const anchorKey = await anchorKeyFor(dependencies.env, paths);
  const chosen = dependencies.env.SHAREDNET_SEAT?.trim() || undefined;
  const selected = room
    ? await selectProjectSeat(dependencies.cwd, { ...(chosen ? { explicit: chosen } : {}), anchorKey }).catch(() => null)
    : null;
  // The seats this directory holds, on whatever origin the Room lives, and
  // which one this session acts as; say/wait act on that origin.
  const seat = room
    ? {
        base_url: room.base_url,
        room_id: room.room_id,
        member_id: selected?.member_id ?? null,
        last_sequence: selected?.last_sequence ?? null,
        credential_present:
          selected !== null && (await readRoomCredential(paths, room.room_id, selected.member_id).catch(() => null)) !== null,
        seats: Object.entries(room.seats).map(([memberId, entry]) => ({
          member_id: memberId,
          last_sequence: entry.last_sequence,
          this_session: entry.anchor_key !== null && entry.anchor_key === anchorKey,
        })),
      }
    : null;
  return {
    base_url: baseUrl,
    account,
    seat,
    // What to do about it, in one line each.
    next:
      account === null
        ? "This machine acts as nobody. Run `sharednet login` so seats are your account's; `join` without it seats an anonymous Principal."
        : seat === null
          ? "Logged in. Run `sharednet join <invite>` in a project directory to take a seat."
          : seat.member_id === null
            ? "This directory holds several seats and none is this session's; say which with --as <member_id> or SHAREDNET_SEAT."
            : "Logged in and seated. `say`, `wait`, and `watch` act as this seat.",
  };
}

/**
 * Seat more Instances in this directory's Room, by id: public ones at once,
 * private ones by asking (decision 2026-09-06 reach, §3).
 */
async function add(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const ids = parsed.positionals;
  if (ids.length === 0 || ids.some((id) => !/^i_[0-9A-Za-z]{10}$/.test(id))) {
    throw localError("invalid_arguments", "Usage: sharednet add <i_…> [<i_…> …]");
  }
  const { client, state, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/members`,
    credential.member_token,
    { with: ids },
  );
}

/** `sharednet reach private|public`: whether strangers who know this seat's id must ask first. */
async function reach(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const value = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || (value !== "public" && value !== "private")) {
    throw localError("invalid_arguments", "Usage: sharednet reach public|private");
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request("PATCH", "/instances/current", credential.member_token, { reach: value });
}

/** The Rooms this seat sits in, newest first; where a seat that was added finds its new Room. */
async function rooms(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet rooms");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/rooms", credential.member_token);
}

/** Requests waiting on this seat: someone wants it in a Room while it is private. */
async function requests(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet requests");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/decisions?status=pending", credential.member_token);
}

/** The seat answers for itself: accept takes the seat, deny refuses it. */
async function answer(
  resolution: "approved" | "denied",
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const decisionId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !decisionId || !/^dec_[0-9A-Za-z]{10}$/.test(decisionId)) {
    const verb = resolution === "approved" ? "accept" : "deny";
    throw localError("invalid_arguments", `Usage: sharednet ${verb} <dec_…>`);
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/decisions/${encodeURIComponent(decisionId)}/resolve`,
    credential.member_token,
    { resolution },
  );
}

/**
 * Credits (decision 2026-09-11): the purse is the account's, so a seat in this
 * directory pays as its account and the ledger records the seat; a directory
 * that is in no Room pays with the account key `sharednet login` left here.
 */
type CreditCredential = {
  client: ApiClient;
  token: string;
  as: "seat" | "account";
  seat: { room_id: string; member_id: string } | null;
};

async function creditCredential(dependencies: GuestDependencies, explicitSeat?: string): Promise<CreditCredential> {
  try {
    const { client, state, credential } = await currentSeat(dependencies, explicitSeat);
    return { client, token: credential.member_token, as: "seat", seat: { room_id: state.room_id, member_id: state.member_id } };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_in_a_room") throw error;
  }
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const stored = await readStoredApiCredential(paths).catch(() => null);
  const key = stored && sameOrigin(stored.base_url, baseUrl) ? stored.api_key : dependencies.env.SHAREDNET_API_KEY?.trim() || null;
  if (!key) {
    throw localError(
      "not_logged_in",
      "This directory is not in a Room and this machine acts as nobody. Run sharednet login, or join a Room first.",
    );
  }
  return { client: new ApiClient(baseUrl, dependencies.fetch), token: key, as: "account", seat: null };
}

type CreditsShape = { credits: { principal_id: string; balance: number; granted: number; sent: number; received: number } };
type TransferShape = { id: string; amount: number; to_principal_id: string; [key: string]: unknown };

async function balance(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet balance [--as <i_…>]");
  const { client, token, as, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  const payload = await client.request<CreditsShape>("GET", "/credits", token);
  return { ...payload.credits, as, seat };
}

async function redeem(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const code = parsed.positionals[0]?.trim();
  if (parsed.positionals.length !== 1 || !code) throw localError("invalid_arguments", "Usage: sharednet redeem <CODE>");
  const { client, token } = await creditCredential(dependencies, stringOption(parsed, "as"));
  return client.request("POST", "/credits/redeem", token, { code });
}

/**
 * `pay <target> <amount>`: the target is a Principal, Agent or Instance id;
 * the amount a whole number. With `--room`, the payment is recorded against
 * this directory's Room and the seat posts a one-line receipt into it, so a
 * trade is visible where it was agreed. Every payment carries its own key.
 */
async function pay(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["memo", "room", "as"]);
  const [target, amountText] = parsed.positionals;
  if (parsed.positionals.length !== 2 || !target || !amountText) {
    throw localError("invalid_arguments", "Usage: sharednet pay <p_…|a_…|i_…> <amount> [--memo <text>] [--room] [--as <i_…>]");
  }
  if (!/^(?:p|a|i)_[0-9A-Za-z]{10}$/.test(target)) {
    throw localError("invalid_arguments", "The target must be a Principal (p_…), Agent (a_…) or Instance (i_…) id.");
  }
  const amount = Number(amountText);
  if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1) {
    throw localError("invalid_arguments", "The amount must be a whole number of credits, at least 1.");
  }
  const memo = stringOption(parsed, "memo");
  const announce = parsed.options.has("room");
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  if (announce && seat === null) {
    throw localError("not_in_a_room", "--room records the payment against this directory's Room; join one first.");
  }
  const paid = await client.request<{ transfer: TransferShape; credits: CreditsShape["credits"] }>(
    "POST",
    "/credits/transfers",
    token,
    { to: target, amount, ...(memo === undefined ? {} : { memo }), ...(announce && seat ? { room_id: seat.room_id } : {}) },
    { "idempotency-key": randomUUID() },
  );
  let receipt: unknown = null;
  let warning: { code: "receipt_not_confirmed"; message: string } | undefined;
  if (announce && seat) {
    try {
      receipt = await client.request(
        "POST",
        `/rooms/${encodeURIComponent(seat.room_id)}/messages`,
        token,
        { content: `Paid ${amount} credit${amount === 1 ? "" : "s"} to ${target}${memo ? ` — ${memo}` : ""} (${paid.transfer.id})` },
        { "idempotency-key": randomUUID() },
      );
    } catch {
      // The payment is final even if the separate receipt fails or its reply
      // is lost. Reporting the payment as failed invites a second debit.
      warning = {
        code: "receipt_not_confirmed",
        message: "Payment succeeded, but the Room receipt was not confirmed. Do not repeat this payment.",
      };
    }
  }
  return { ...paid, receipt, ...(warning ? { warning } : {}) };
}

async function ledger(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["last", "before", "as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet ledger [--last <n>] [--before <txn_…>]");
  const lastText = stringOption(parsed, "last");
  const last = lastText === undefined ? 20 : Number(lastText);
  if (!Number.isSafeInteger(last) || last < 1 || last > 100) throw localError("invalid_arguments", "--last must be between 1 and 100.");
  const before = stringOption(parsed, "before");
  if (before !== undefined && !/^txn_[0-9A-Za-z]{10}$/.test(before)) throw localError("invalid_arguments", "--before must be a transfer id such as txn_AbCdEfGhIj.");
  const { client, token } = await creditCredential(dependencies, stringOption(parsed, "as"));
  const query = new URLSearchParams({ limit: String(last), ...(before === undefined ? {} : { before }) });
  return client.request("GET", `/credits/transfers?${query.toString()}`, token);
}

/**
 * Artifacts (decision 2026-09-11): a file handed to the Room. `upload` puts
 * one in the Room this directory sits in, or behind a link for anyone;
 * `download` takes an id or a link and writes the bytes here.
 */
type ArtifactShape = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  room_id: string | null;
};

/** A name to write on this machine: the last segment, never a path. */
function safeBasename(value: string): string {
  const name = value.split(/[\\/]+/).pop()?.trim() ?? "";
  if (name === "" || name === "." || name === "..") {
    throw localError("invalid_filename", "That file has no usable name; pass --out to say where to write it.");
  }
  return name;
}

async function compiledCommand(verb: "act" | "open" | "deliver", args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, verb === "act" ? ["data", "as"] : verb === "deliver" ? ["work", "name", "file", "artifact", "as"] : ["as"]);
  if (parsed.positionals.length > 0) throw localError("invalid_arguments", `sharednet ${verb} uses the Room joined in this directory.`);
  let envelope: unknown;
  if (verb === "act") {
    try { envelope = JSON.parse(stringOption(parsed, "data") ?? ""); }
    catch { throw localError("invalid_arguments", "Usage: sharednet act --data '<JSON envelope>' [--as i_…]"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw localError("invalid_arguments", "--data must be a JSON object.");
  }
  const work = stringOption(parsed, "work");
  const name = stringOption(parsed, "name");
  const file = stringOption(parsed, "file");
  const files: Array<{ name: string; path: string }> = [];
  if (verb === "deliver") {
    const usage = "Use deliver --work W --name patch --file PATH, or --artifact patch=PATH --artifact report=PATH. Do not mix the two forms.";
    const artifacts = parsed.repeated.get("artifact") ?? [];
    if (!work?.trim() || (artifacts.length > 0 && (name !== undefined || file !== undefined))) throw localError("invalid_arguments", usage);
    if (artifacts.length > 0) {
      for (const artifact of artifacts) {
        const separator = artifact.indexOf("=");
        if (separator < 0) throw localError("invalid_arguments", "--artifact takes NAME=PATH.");
        files.push({ name: artifact.slice(0, separator).trim(), path: artifact.slice(separator + 1) });
      }
    } else {
      files.push({ name: name?.trim() ?? "", path: file ?? "" });
    }
    const names = new Set<string>();
    for (const item of files) {
      if (!item.name || !item.path.trim() || names.has(item.name)) throw localError("invalid_arguments", "Every artifact needs a unique nonempty name and a nonempty file path.");
      names.add(item.name);
    }
  }
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const path = `/rooms/${encodeURIComponent(state.room_id)}`;
  if (verb === "open") return client.request("GET", `${path}/state`, credential.member_token);
  if (verb === "deliver") {
    // Require a Room seat first: upload must never silently fall back to an account-only artifact.
    const artifacts: Array<[string, string]> = [];
    for (const item of files) {
      const uploaded = await upload([item.path, "--as", state.member_id], dependencies) as { artifact?: { id?: string } };
      if (!uploaded.artifact?.id) throw invalidServerResponse();
      artifacts.push([item.name, uploaded.artifact.id]);
    }
    // Publish one result only after every upload succeeds; partial uploads never become a result.
    envelope = { type: "work.result", work_id: work, artifacts: Object.fromEntries(artifacts), idempotency_key: randomUUID() };
  }
  return client.request("POST", `${path}/acts`, credential.member_token, envelope);
}

async function upload(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["name", "as"]);
  const path = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !path) {
    throw localError("invalid_arguments", "Usage: sharednet upload <path> [--name <filename>] [--as <i_…>]");
  }
  const resolved = resolvePath(dependencies.cwd, path);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw localError("file_not_found", `Nothing to upload at ${path}.`);
  }
  if (bytes.byteLength === 0) throw localError("file_empty", "That file is empty.");
  const filename = safeBasename(stringOption(parsed, "name") ?? resolved);
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  // Every file comes back with a link. A directory that holds a seat also
  // hands the file to that Room, so the others can read it by id.
  return client.request("POST", "/artifacts", token, bytes, {
    "content-type": contentTypeFor(filename),
    ...(/[^\x20-\x7e]/.test(filename)
      ? { "x-sharednet-filename*": `UTF-8''${encodeURIComponent(filename)}` }
      : { "x-sharednet-filename": filename }),
    ...(seat === null ? {} : { "x-sharednet-room": seat.room_id }),
    "idempotency-key": randomUUID(),
  });
}

async function download(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["out", "force", "as"]);
  const target = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !target) {
    throw localError("invalid_arguments", "Usage: sharednet download <art_… | link> [--out <path>] [--force]");
  }
  // A link carries its own key and needs no credential; an id is read as this seat.
  const link = /^https?:\/\//.test(target) ? new URL(target) : null;
  let artifactId: string;
  let client: ApiClient;
  let token = "";
  let key: string | null = null;
  if (link) {
    const match = /\/(?:f|api\/v1\/artifacts)\/(art_[0-9A-Za-z]{10})(?:\/content)?$/.exec(link.pathname);
    key = link.searchParams.get("k");
    if (!match || key === null) {
      throw localError("invalid_arguments", "That link does not point at a SharedNet file.");
    }
    artifactId = match[1]!;
    client = new ApiClient(`${link.protocol}//${link.host}`, dependencies.fetch);
  } else {
    if (!/^art_[0-9A-Za-z]{10}$/.test(target)) {
      throw localError("invalid_arguments", "Pass a file id such as art_AbCdEfGhIj, or a link.");
    }
    artifactId = target;
    const credential = await creditCredential(dependencies, stringOption(parsed, "as"));
    client = credential.client;
    token = credential.token;
  }
  const meta = key === null ? await client.request<{ artifact: ArtifactShape }>("GET", `/artifacts/${artifactId}`, token) : null;
  const bytes = await client.requestBytes(
    `/artifacts/${artifactId}/content${key === null ? "" : `?k=${encodeURIComponent(key)}`}`,
    token,
  );
  const name = safeBasename(stringOption(parsed, "out") ?? meta?.artifact.filename ?? bytes.filename ?? artifactId);
  const out = resolvePath(dependencies.cwd, stringOption(parsed, "out") ?? name);
  try {
    // Exclusive creation handles competing downloads and dangling symlinks in
    // the same operation that opens the file; a prior stat cannot protect it.
    await writeFile(out, bytes.bytes, { flag: parsed.options.has("force") ? "w" : "wx" });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw localError("file_exists", `${name} is already here. Pass --force to overwrite it, or --out to write elsewhere.`);
    }
    throw error;
  }
  const digest = createHash("sha256").update(bytes.bytes).digest("hex");
  return {
    artifact_id: artifactId,
    path: out,
    size_bytes: bytes.bytes.byteLength,
    sha256: digest,
    // The server states the digest it stored; a mismatch means the bytes changed on the way.
    verified: bytes.sha256 === null ? null : bytes.sha256 === digest,
  };
}

async function files(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["last", "before", "room", "as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet files [--room] [--last <n>] [--before <art_…>]");
  const lastText = stringOption(parsed, "last");
  const last = lastText === undefined ? 20 : Number(lastText);
  if (!Number.isSafeInteger(last) || last < 1 || last > 100) throw localError("invalid_arguments", "--last must be between 1 and 100.");
  const before = stringOption(parsed, "before");
  if (before !== undefined && !/^art_[0-9A-Za-z]{10}$/.test(before)) {
    throw localError("invalid_arguments", "--before must be a file id such as art_AbCdEfGhIj.");
  }
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  if (parsed.options.has("room") && seat === null) {
    throw localError("not_in_a_room", "--room lists this directory's Room; join one first.");
  }
  const query = new URLSearchParams({
    limit: String(last),
    ...(before === undefined ? {} : { before }),
    ...(parsed.options.has("room") && seat ? { room_id: seat.room_id } : {}),
  });
  return client.request("GET", `/artifacts?${query.toString()}`, token);
}

/** Enough of a media type for the common things Agents pass; the rest are bytes. */
function contentTypeFor(filename: string): string {
  const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const known: Record<string, string> = {
    csv: "text/csv",
    diff: "text/plain",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    log: "text/plain",
    md: "text/markdown",
    patch: "text/plain",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp",
    yaml: "text/plain",
    yml: "text/plain",
  };
  return known[extension] ?? "application/octet-stream";
}

/**
 * The resident connector.
 *
 * `wait` and `watch` each sit in one Room, in the foreground, until something ends them. That
 * makes waking conditional on someone having started a command and nothing having gone wrong
 * since, which is not what "you can be woken" should mean. `serve` is the process that makes it
 * unconditional while the machine is up: it sits in **every** Room this machine holds a seat in,
 * each on its own loop, and it does not stop.
 *
 * Multi-Room costs nothing here and that is the point. `heldSeats` already walks every seat under
 * `rooms/<room_id>/<member_id>.json`, so one process covering all of them is less work than one
 * process per Room — no seat file to pick, no `--as` to pass, and a Room that goes wrong takes
 * only its own loop down.
 *
 * Where `wait` gives up after a bounded number of attempts, because a foreground command should
 * not hang forever, this never does. A daemon that exits on a long outage is a daemon that was
 * not running when the message finally came.
 */
/**
 * The local end of a seat's doorbell (wait PR 7): an HTTP listener on this machine that the service
 * rings through a tunnel, ngrok on a laptop. A ring is checked against the seat's secret and its
 * timestamp, answered at once, and only makes the seat look; it carries nothing to trust.
 */
async function openDoorbell(port: number, dependencies: GuestDependencies, signal: AbortSignal) {
  const { createServer } = await import("node:http");
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const secrets = new Map<string, string>();
  const pending = new Set<string>();
  const waiters = new Map<string, (rung: boolean) => void>();
  const server = createServer((request, response) => {
    const match = /^\/sharednet\/push\/(i_[0-9A-Za-z]{10})$/.exec((request.url ?? "").split("?")[0]!);
    if (request.method !== "POST" || !match) {
      response.writeHead(404).end();
      return;
    }
    const memberId = match[1]!;
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const secret = secrets.get(memberId);
      const timestamp = String(request.headers["x-sharednet-timestamp"] ?? "");
      const given = String(request.headers["x-sharednet-signature"] ?? "");
      const expected = secret === undefined ? "" : `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
      // A ring more than five minutes off is a replay, or a clock to fix; either way it is refused.
      const fresh = /^\d+$/.test(timestamp) && Math.abs(dependencies.now().getTime() - Number(timestamp) * 1000) <= 300_000;
      const valid = secret !== undefined && fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!valid) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(204).end();
      const waiter = waiters.get(memberId);
      if (waiter) {
        waiters.delete(memberId);
        waiter(true);
      } else {
        pending.add(memberId);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  signal.addEventListener(
    "abort",
    () => {
      for (const [memberId, waiter] of waiters) {
        waiters.delete(memberId);
        waiter(false);
      }
    },
    { once: true },
  );
  return {
    register(memberId: string, secret: string) {
      secrets.set(memberId, secret);
    },
    /** Resolves true when the seat is rung (or was, while it was busy), false once serve is stopping. */
    rung(memberId: string): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      if (pending.delete(memberId)) return Promise.resolve(true);
      return new Promise((resolve) => waiters.set(memberId, resolve));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Where the service should ring: the public address given, or the https tunnel a local ngrok has open to this port. */
async function doorbellAddress(option: string, port: number, dependencies: GuestDependencies): Promise<string> {
  if (option !== "ngrok") {
    try {
      const url = new URL(option);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      return url.toString().replace(/\/$/, "");
    } catch {
      throw localError("invalid_arguments", "--push takes the public address that reaches --listen, such as https://abc.ngrok.app, or ngrok.");
    }
  }
  type Tunnel = { public_url?: unknown; config?: { addr?: unknown } };
  const listed = await dependencies
    .fetch("http://127.0.0.1:4040/api/tunnels")
    .then((response) => response.json() as Promise<{ tunnels?: Tunnel[] }>)
    .catch(() => null);
  const tunnels = Array.isArray(listed?.tunnels) ? listed.tunnels : [];
  const https = tunnels.filter((tunnel) => typeof tunnel.public_url === "string" && tunnel.public_url.startsWith("https://"));
  const tunnel = https.find((candidate) => String(candidate.config?.addr ?? "").endsWith(`:${port}`)) ?? https[0];
  if (!tunnel) throw localError("ngrok_not_running", `No ngrok tunnel reaches port ${port}. Run: ngrok http ${port}`);
  return String(tunnel.public_url).replace(/\/$/, "");
}

/** How often a running `serve` looks for seats joined since it started. */
const RESCAN_MS = 5_000;
// Checkpoints contain agent-written progress, never captured process output or credentials.
function checkpointPath(stateDir: string, room: string, member: string): string {
  return joinPath(stateDir, "wake-progress", `${createHash("sha256").update(`${room}/${member}`).digest("hex")}.json`);
}
async function saveWakeProgress(path: string, value: unknown): Promise<void> {
  await mkdir(resolvePathFrom(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}
/**
 * A backstop, not a budget: two seats that keep addressing each other would otherwise wake each
 * other for ever. Past this many turns in an hour a seat's next wake waits for the hour to pass,
 * and still carries everything said meanwhile.
 */
const MAX_TURNS_PER_HOUR = 30;
/**
 * Seats that resume the same session take turns. While one seat's turn holds the session, a second
 * resume would find an "active writer" and queue its lines into that turn, which neither belongs to
 * the seat nor keeps the lines if it ends early. So the next seat waits, then resumes, in order.
 */
export function sessionTurnOrder() {
  const held = new Map<string, { holder: string; done: Promise<void> }>();
  return async <T>(key: string, holder: string, onWait: (holder: string) => void, work: () => Promise<T>): Promise<T> => {
    for (let current = held.get(key); current; current = held.get(key)) {
      onWait(current.holder);
      await current.done;
    }
    let release!: () => void;
    held.set(key, { holder, done: new Promise<void>((resolve) => { release = resolve; }) });
    try {
      return await work();
    } finally {
      held.delete(key);
      release();
    }
  };
}

function wakeSessionKey(wake: SeatWake): string | null {
  return wake.session ? JSON.stringify([wake.driver, wake.codex_home ?? null, wake.session]) : null;
}

/** A wake program that did not start is looked at again after this, doubling up to the cap. */
const CHECK_RETRY_MS = 30_000;
const CHECK_RETRY_MAX_MS = 600_000;
/** The service takes a message of at most this many bytes. */
const MAX_MESSAGE_BYTES = 32_768;

async function serve(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["run", "reply", "rooms", "from-instance", "from-agent", "grep", "status", "stop", "push", "listen"]);
  if (parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet serve [--run '<command>'] [--reply] [--rooms all|rom_…,rom_…] [--grep TEXT] [--push <public address>|ngrok [--listen <port>]], or sharednet serve --status | --stop",
    );
  }
  const pushOption = stringOption(parsed, "push");
  const listenOption = stringOption(parsed, "listen");
  if (listenOption !== undefined && (pushOption === undefined || !/^\d+$/.test(listenOption) || Number(listenOption) < 1 || Number(listenOption) > 65535)) {
    throw localError("invalid_arguments", "--listen takes a port from 1 to 65535, and goes with --push.");
  }
  const listen = listenOption === undefined ? 8787 : Number(listenOption);
  const paths = getStoragePaths(dependencies.env);
  if (parsed.options.get("status") === true) return readServeStatus(paths);
  if (parsed.options.get("stop") === true) return stopServe(paths, dependencies);

  const command = stringOption(parsed, "run");
  const reply = parsed.options.get("reply") === true;
  if (reply && !command) throw localError("invalid_arguments", "--reply needs --run: it says back what the command prints.");
  const filters = waitFiltersFrom(parsed.options);
  const wanted = stringOption(parsed, "rooms");
  const only = wanted === undefined || wanted === "all" ? null : new Set(wanted.split(",").map((value) => value.trim()));
  if (only) {
    for (const roomId of only) {
      if (!ROOM_ID_PATTERN.test(roomId)) throw localError("invalid_arguments", `--rooms takes Room ids such as rom_AbCdEfGhIj, or all. Got ${roomId}.`);
    }
  }
  // Without --run there is nothing to do for a seat but resume the session that took it, so only
  // those seats are served. Any other seat is left to its own waits: a connector that sat in it
  // would count what it never handled as handled, and that seat's next `wait` would miss it.
  const served = (seat: StoredRoomCredential) => (only ? only.has(seat.room_id) : true) && (command !== undefined || seat.wake !== undefined);

  const held = await heldSeats(paths);
  const seats = held.filter(served);
  if (seats.length === 0) {
    throw localError(
      "not_in_a_room",
      held.length === 0
        ? "This machine holds no Room seats yet. Run: sharednet join <invite>"
        : only && !held.some((seat) => only.has(seat.room_id))
          ? "This machine holds no seat in the Rooms named by --rooms."
          : "No seat here was joined from a Codex or Claude Code session, so there is no session to wake. Give --run '<command>' to serve every seat with a command.",
    );
  }

  // One connector per machine. Two would each resume the same session for the same line.
  const started = dependencies.now().toISOString();
  const health = new Map<string, { state: "starting" | "listening" | "working" | "retrying" | "stopped"; last_error?: string; updated_at: string }>();
  const seatKey = (seat: StoredRoomCredential) => `${seat.room_id}/${seat.member_id}`;
  const tracked = new Map(seats.map((seat) => [seatKey(seat), seat]));
  const turnTimes = new Map<string, number[]>();
  /** What serve's start check doubted about a seat it drives anyway (`wake_warnings` in `serve --status`). */
  const wakeWarnings = new Map<string, string[]>();
  const inTurnOrder = sessionTurnOrder();
  const statusOf = (all: StoredRoomCredential[]): ServeStatus => ({
    pid: process.pid,
    started_at: started,
    rooms: [...new Set(all.map((seat) => seat.room_id))],
    drives: !command,
    ...(!command ? { wake_protocol: "wake-plugins-v1" as const } : {}),
    seats: all.map((seat) => ({
      room_id: seat.room_id,
      member_id: seat.member_id,
      name: seat.name,
      resumes: !command && seat.wake ? describeWake(seat.wake) : null,
      ...(health.get(seatKey(seat)) ?? { state: "starting" as const, updated_at: started }),
      ...(wakeWarnings.get(seatKey(seat))?.length ? { wake_warnings: wakeWarnings.get(seatKey(seat)) } : {}),
    })),
  });
  const holder = await claimServe(paths, statusOf(seats));
  if (holder !== null) {
    throw localError(
      "serve_running",
      `${holder === 0 ? "Another connector is starting on this machine" : `A connector is already running on this machine (pid ${holder})`}; it serves every seat here, including ones joined after it started. Stop it first with: sharednet serve --stop`,
    );
  }

  // Serialize snapshots: two seats finishing together must not overwrite a newer state.
  let statusWrite = Promise.resolve();
  const setHealth = (seat: StoredRoomCredential, state: "starting" | "listening" | "working" | "retrying" | "stopped", last_error?: string) => {
    tracked.set(seatKey(seat), seat);
    health.set(seatKey(seat), { state, ...(last_error ? { last_error } : {}), updated_at: dependencies.now().toISOString() });
    statusWrite = statusWrite.then(() => writeServeStatus(paths, statusOf([...tracked.values()]))).catch(() => {
      // Health reporting must not stop message delivery or skip ownership cleanup.
      dependencies.stderr?.("serve: could not update seat status; on-disk health may be stale\n");
    });
    return statusWrite;
  };
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec = dependencies.exec ?? defaultExec;
  const drive = dependencies.runTurn ?? runTurn;
  const open = dependencies.chatOpen ?? chatOpen;
  const checkWake = dependencies.checkWake ?? ((wake: SeatWake, options: CheckOptions) => pluginFor(wake.driver).check(wake, dependencies.env, drive, options));

  // With --push the seats sit behind a doorbell (wait PR 7): no long-poll, and not one request while
  // nothing is said. Ctrl-C takes the doorbells down before it goes.
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  dependencies.signal?.addEventListener("abort", stop, { once: true });
  /** A startup retry must not keep an installed service alive for the full backoff after shutdown. */
  const retryDelay = async (ms: number): Promise<void> => {
    if (stopping.signal.aborted) return;
    if (dependencies.sleep) {
      let stopped!: () => void;
      const aborted = new Promise<void>((resolve) => (stopped = resolve));
      stopping.signal.addEventListener("abort", stopped, { once: true });
      try {
        await Promise.race([sleep(ms), aborted]);
      } finally {
        stopping.signal.removeEventListener("abort", stopped);
      }
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        stopping.signal.removeEventListener("abort", done);
        resolve();
      }
      stopping.signal.addEventListener("abort", done, { once: true });
    });
  };
  let doorbell: Awaited<ReturnType<typeof openDoorbell>> | null = null;
  let base: string | null = null;
  try {
    if (pushOption !== undefined) {
      base = await doorbellAddress(pushOption, listen, dependencies);
      doorbell = await openDoorbell(listen, dependencies, stopping.signal);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    await releaseServe(paths);
    throw error;
  }

  dependencies.stderr?.(`serve: sitting in ${seats.length} Room(s): ${seats.map((seat) => seat.room_id).join(", ")}\n`);
  if (base !== null) dependencies.stderr?.(`serve: doorbell at ${base}/sharednet/push/<seat>, listening on 127.0.0.1:${listen}; idle until rung\n`);

  const sitIn = async (seat: StoredRoomCredential) => {
    const client = new ApiClient(seat.base_url, boundedFetch(dependencies, null, false));
    const me = seat.member_id;
    // A seat taken from inside a Codex or Claude Code session is driven: being addressed resumes
    // that session (the drivers). An explicit --run serves every seat with the command instead.
    const driving = !command && seat.wake !== undefined;
    // Driven, a seat wakes when a line addresses it; the wake still carries everything said since.
    const seatFilters = driving ? new URLSearchParams({ mentions: me }) : filters;
    if (driving) {
      // A program that cannot start would take every wake and answer none (#20): look once, first,
      // and leave the seat's lines unread when it does not start.
      // A failed look is often passing (a slow `--version`, a busy machine), so it is tried again,
      // backing off to every 10 minutes, rather than leaving the seat unheard until serve restarts.
      for (let attempt = 0; ; attempt += 1) {
        const wake = (await readRoomCredential(paths, seat.room_id, seat.member_id))?.wake;
        if (!wake) {
          await setHealth(seat, "stopped");
          await retryDelay(RESCAN_MS);
          if (stopping.signal.aborted) return;
          attempt = -1;
          continue;
        }
        // Only the steps that cost no model call; `sharednet wake check` also makes one. Only a
        // program that does not start holds the seat back: a sign-in or session in doubt is shown
        // in `serve --status`, and a delivery that does fail says so in the Room.
        const checked = startVerdict(await checkWake(wake, { call: false }));
        if (checked.ok) {
          // The repair may have replaced the command or session while serve was retrying.
          seat.wake = wake;
          wakeWarnings.set(seatKey(seat), checked.warnings);
          for (const warning of checked.warnings) dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} (${me}) wake warning: ${warning}. Check with \`sharednet wake check --as ${me}\`.\n`);
          break;
        }
        const delay = Math.min(CHECK_RETRY_MS * 2 ** attempt, CHECK_RETRY_MAX_MS);
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} (${me}) not driven: ${checked.message}. Looking again in ${Math.round(delay / 1000)}s; repair it and check with \`sharednet wake check --as ${me}\`.\n`);
        await setHealth(seat, "retrying", "wake_command_unavailable");
        await retryDelay(delay);
        if (stopping.signal.aborted) return;
      }
      dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} (${me}) wakes ${describeWake(seat.wake!)} when addressed\n`);
    }
    const turns = turnTimes.get(seatKey(seat)) ?? [];
    turnTimes.set(seatKey(seat), turns);
    // An account's seat can be handed a new token while this runs (its session registered again);
    // the session file holds the current one, which is the one `say` and `wait` use too.
    const current = async () => {
      if (!seat.member_id.startsWith("i_")) return;
      const session = await readSessionById(paths, seat.member_id).catch(() => null);
      if (session && sameOrigin(session.base_url, seat.base_url)) seat.member_token = session.instance_token;
    };
    await current();
    // The place is the service's (wait PR 5), shared with every other door this seat uses; the
    // connector's file mirrors it. A seat that has handled nothing anywhere starts at the Room's
    // current end, so a first start does not hand over the whole history as if it were new.
    await hydrateRoomMode(client, seat, dependencies);
    const mirrored = await readServeCursor(paths, seat.room_id, seat.member_id);
    const kept = await keptPlace(client, seat.room_id, seat.member_token, mirrored ?? 0, sleep, dependencies);
    // A driven seat's join counted the history as handled, so its place is exact from then on, and
    // what was said since is the session's to hear when it is next woken.
    let cursor = driving || kept > 0 || mirrored !== null ? kept : await roomEnd(client, seat);
    if (cursor > kept) await acknowledgeThrough(client, seat.room_id, seat.member_token, cursor, sleep, dependencies);
    await writeServeCursor(paths, seat.room_id, seat.member_id, cursor);
    if (doorbell !== null && base !== null) {
      const set = await client.request<{ push?: { secret?: unknown } }>("PUT", `/rooms/${encodeURIComponent(seat.room_id)}/subscription`, seat.member_token, {
        push_url: `${base}/sharednet/push/${seat.member_id}`,
      });
      if (typeof set?.push?.secret !== "string") throw invalidServerResponse();
      doorbell.register(seat.member_id, set.push.secret);
    }
    const handled = async (through: number) => {
      cursor = through;
      await acknowledgeThrough(client, seat.room_id, seat.member_token, cursor, sleep, dependencies);
      await writeServeCursor(paths, seat.room_id, seat.member_id, cursor);
    };
    const post = (content: string) =>
      client.request("POST", `/rooms/${encodeURIComponent(seat.room_id)}/messages`, seat.member_token, { content }, { "idempotency-key": randomUUID() });
    /** One wake of a driven seat, delivered by its plugin. What that means for the Room is decided here. */
    const deliverWake = async (said: MessageShape[], from: number, through: number): Promise<Delivery | null> => {
      const hour = dependencies.now().getTime() - 3_600_000;
      while (turns.length > 0 && turns[0]! <= hour) turns.shift();
      if (turns.length >= MAX_TURNS_PER_HOUR) {
        const wait = turns[0]! + 3_600_000 - dependencies.now().getTime();
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} was resumed ${turns.length} times in the last hour; the next turn waits ${Math.ceil(wait / 60_000)} min\n`);
        await sleep(Math.max(wait, 0));
      }
      // The seat file names the session; a later join or `wake set` replaces it.
      let wake = (await readRoomCredential(paths, seat.room_id, seat.member_id))?.wake;
      // `wake off` may have run while the poll or turn backstop was waiting.
      if (!wake) return null;
      type WakeRun =
        | { state: "cancelled" }
        | { state: "moved"; wake: SeatWake }
        | { state: "delivered"; delivery: Delivery; pluginLabel: string; started: number; timeoutMs: number };
      const take = async (currentWake: SeatWake): Promise<WakeRun> => {
        if (stopping.signal.aborted) return { state: "cancelled" };
        const about = { roomId: seat.room_id, seat: seat.name, memberId: seat.member_id, messages: said, from, through };
        const checkpoint = checkpointPath(paths.stateDir, seat.room_id, seat.member_id);
        let compiled = "";
        if (seat.room_type === "compiled") {
          const state = await client.request<CompiledState>("GET", `/rooms/${encodeURIComponent(seat.room_id)}/state`, seat.member_token);
          compiled = `\n\n${compiledPrompt(state)}`;
        }
        // A queued turn can outlive daemon shutdown. Do not start its harness after the stop.
        if (stopping.signal.aborted) return { state: "cancelled" };
        const plugin = pluginFor(currentWake.driver);
        const timeoutMs = currentWake.turn_limit_ms ?? DEFAULT_TURN_LIMIT_MS;
        const started = dependencies.now().getTime();
        const deadline = started + timeoutMs;
        const checkpointAt = deadline - Math.min(120_000, timeoutMs / 4);
        const prompt = wakeTurnPrompt(about) + `\n\nExecution budget: ${timeoutMs / 60_000} minutes; deadline ${new Date(deadline).toISOString()}. Save progress by ${new Date(checkpointAt).toISOString()} and after each significant milestone: sharednet wake checkpoint "completed; next step; blockers; evidence paths" --as ${seat.member_id}. Keep secrets out. Previous checkpoint (if any): ${checkpoint}. Read it to recover context, then verify current state before repeating actions. A checkpoint does not authorize automatic retries. You can set the NEXT turn's limit with sharednet wake limit 60m --as ${seat.member_id}; this does not extend this running turn. This budget applies to headless execution, not a handoff into an open chat.${compiled}`;
        const delivery = await plugin.deliver(currentWake, { ...about, prompt, livePrompt: livePrompt(about) }, { env: dependencies.env, run: drive, chatOpen: open, timeoutMs });
        return { state: "delivered", delivery, pluginLabel: plugin.label, started, timeoutMs };
      };
      let ran: WakeRun;
      for (;;) {
        if (stopping.signal.aborted) return null;
        const sessionKey = wakeSessionKey(wake);
        if (sessionKey === null) {
          // A session wake may have been changed to a command wake since the first read. Take the
          // latest command only after confirming it still has no session to serialize.
          const currentWake = (await readRoomCredential(paths, seat.room_id, seat.member_id))?.wake;
          if (!currentWake || stopping.signal.aborted) return null;
          if (wakeSessionKey(currentWake) !== null) {
            wake = currentWake;
            continue;
          }
          ran = await take(currentWake);
        } else {
          ran = await inTurnOrder(
            sessionKey,
            `${seat.room_id} ${seat.name}`,
            (holder) => dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} addressed; its session is in ${holder}'s turn, so it resumes after that\n`),
            async () => {
              if (stopping.signal.aborted) return { state: "cancelled" };
              // Waiting can last an entire model turn. `wake off`, `wake set`, or a new join may
              // have changed this seat meanwhile, so no captured wake may cross the lock boundary.
              const currentWake = (await readRoomCredential(paths, seat.room_id, seat.member_id))?.wake;
              if (!currentWake || stopping.signal.aborted) return { state: "cancelled" };
              if (wakeSessionKey(currentWake) !== sessionKey) return { state: "moved", wake: currentWake };
              return take(currentWake);
            },
          );
        }
        if (ran.state === "cancelled") return null;
        if (ran.state === "moved") {
          // Release the old session before entering the replacement's queue; nesting the locks can
          // deadlock when two seats swap sessions while both are waiting.
          wake = ran.wake;
          continue;
        }
        break;
      }
      const { delivery, pluginLabel, started, timeoutMs } = ran;
      // The backstop counts turns that ran; a wake handed on, left or put off ran none.
      if (delivery.kind === "replied" || delivery.kind === "failed") turns.push(started);
      const span = `#${from + 1}..#${through}`;
      if (delivery.kind === "replied") {
        // The turn's last message is the seat's reply; the session does not have to reach the Room.
        const answer = replyFrom(delivery.reply, MAX_MESSAGE_BYTES);
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} finished its turn${answer ? `: ${answer.replace(/\s+/g, " ").slice(0, 160)}` : " with nothing to say"}\n`);
        if (answer) {
          await post(answer).catch((error: unknown) => {
            dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name}'s reply was not posted (${error instanceof CliError ? error.code : "error"})\n`);
          });
        }
      } else if (delivery.kind === "handed") {
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} addressed; ${span} ${delivery.note}; it answers in the Room itself\n`);
        // Written before the cursor moves past it: a session that never answers leaves it unanswered.
        const addressed = said.filter((item) => item.mentions?.includes(me)).map((item) => item.sequence);
        await updateHanded(paths, seat.room_id, me, (earlier) => [
          ...earlier.filter((item) => item.through !== through),
          { from, through, addressed: addressed.length > 0 ? addressed : said.map((item) => item.sequence), handed_at: dependencies.now().toISOString() },
        ]);
      } else if (delivery.kind === "failed") {
        // The Room hears the harness's own words, or the exit code; the machine's output stays in the log.
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.name} could not be resumed: ${delivery.why}${delivery.detail ? ` (${delivery.detail})` : ""}\n`);
        // Whoever addressed the seat would otherwise hear nothing at all, and not know why.
        const notice = delivery.timedOut
          ? `(${seat.name}'s turn was stopped after ${timeoutMs / 60_000} minutes. The listener remains available for the next mention; this task was not automatically retried.)`
          : `(${seat.name} was addressed, but its ${pluginLabel} session could not be resumed: ${delivery.why})`;
        await post(notice).catch(() => undefined);
      }
      return delivery;
    };

    // Where the long-poll resumes. Without a filter it is the cursor. With one it can run ahead, past
    // the seat's own matching words, while the cursor stays at what has been handed over.
    let polled = cursor;
    let idle = false;
    /** The last line already reported as left or put off, so the log says it once. */
    let reported = 0;
    for (;;) {
      if (stopping.signal.aborted) return;
      if (driving && !(await readRoomCredential(paths, seat.room_id, seat.member_id))?.wake) {
        // Keep this loop available for a later `wake set`, but leave the seat's messages unread.
        await setHealth(seat, "stopped");
        await sleep(RESCAN_MS);
        continue;
      }
      // Behind a doorbell there is no long-poll: once nothing is left to hand over, the seat waits to
      // be rung, and looks once when it is.
      if (doorbell !== null && idle && !(await doorbell.rung(seat.member_id))) return;
      await current();
      await setHealth(seat, "listening");
      const page = await waitPage(client, seat.room_id, seat.member_token, polled, doorbell !== null ? 0 : WAIT_MAX_SECONDS, seatFilters);
      idle = page.items.length === 0;
      polled = highestSequence(page.items, polled);
      const matched = page.items.filter((item) => !isOwn(item, me, seat.member_id));
      if (matched.length === 0 && seatFilters.size > 0) continue;
      // A filter chose the moment; the wake still carries everything said since the last one.
      let others = matched;
      if (seatFilters.size > 0) {
        others = (await everythingSaid(client, seat.room_id, seat.member_token, cursor, polled)).filter(
          (item) => !isOwn(item, me, seat.member_id),
        );
      }
      if (driving && others.length > 0) {
        await setHealth(seat, "working");
        const delivery = await deliverWake(others, cursor, polled);
        if (delivery === null) {
          polled = cursor;
          continue;
        }
        if (delivery.kind === "left" || delivery.kind === "busy") {
          // Not this seat's to acknowledge yet. A session that answers for itself acknowledges what it
          // handled, and that becomes the place; what it leaves comes round again.
          if (polled > reported) {
            dependencies.stderr?.(
              delivery.kind === "left"
                ? `serve: ${seat.room_id} ${seat.name} addressed while ${delivery.note}; leaving #${cursor + 1}..#${polled} to it\n`
                : `serve: ${seat.room_id} ${seat.name} addressed, but ${delivery.why}; trying #${cursor + 1}..#${polled} again in ${Math.round(delivery.retryMs / 1000)}s\n`,
            );
            reported = polled;
          }
          await sleep(delivery.kind === "left" ? 10_000 : delivery.retryMs);
          const kept = await keptPlace(client, seat.room_id, seat.member_token, cursor, sleep, dependencies);
          if (kept > cursor) {
            cursor = kept;
            await writeServeCursor(paths, seat.room_id, seat.member_id, cursor);
          }
          polled = cursor;
          continue;
        }
        // Handled only now, so a wake cut short by a crash or a restart is handed over again.
        await handled(polled);
        continue;
      }
      if (others.length === 0 || !command) {
        if (polled > cursor) await handled(polled);
        continue;
      }
      const compiled = seat.room_type === "compiled"
        ? await client.request<CompiledState>("GET", `/rooms/${encodeURIComponent(seat.room_id)}/state`, seat.member_token)
        : undefined;
      // Preparatory reads must succeed before marking a command wake attempted.
      if (polled > cursor) await handled(polled);
      dependencies.stderr?.(`serve: ${seat.room_id} woke on ${others.length} message(s) through sequence ${cursor}\n`);
      const input = `${JSON.stringify({ room_id: seat.room_id, member_id: seat.member_id, trigger: "message", messages: others, ...(compiled ? { compiled } : {}) })}\n`;
      await setHealth(seat, "working");
      const result = await exec(command, input, {
        SHAREDNET_ROOM_ID: seat.room_id,
        SHAREDNET_MEMBER_ID: seat.member_id,
        SHAREDNET_MESSAGE_COUNT: String(others.length),
        SHAREDNET_LAST_SEQUENCE: String(cursor),
      });
      if (result.stderr) dependencies.stderr?.(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      if (result.exitCode !== 0) {
        dependencies.stderr?.(`serve: ${seat.room_id} command exited ${result.exitCode}\n`);
        continue;
      }
      if (reply && result.stdout.trim().length > 0) {
        await client
          .request("POST", `/rooms/${encodeURIComponent(seat.room_id)}/messages`, seat.member_token, { content: result.stdout.trim() }, { "idempotency-key": randomUUID() })
          .catch((error: unknown) => {
            dependencies.stderr?.(`serve: ${seat.room_id} reply not posted (${error instanceof CliError ? error.code : "error"})\n`);
          });
      }
    }

  };

  const supervise = async (seat: StoredRoomCredential) => {
    while (!stopping.signal.aborted) {
      try {
        await setHealth(seat, "starting");
        await sitIn(seat);
        await setHealth(seat, "stopped");
        return;
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        // ApiClient uses exit 5 for transport/invalid-response/HTTP 5xx failures, regardless
        // of the server's error envelope (including internal_error). Auth/refusals stay terminal.
        const retryable = error.exitCode === 5 || error.code === "rate_limited";
        await setHealth(seat, retryable ? "retrying" : "stopped", error.code);
        dependencies.stderr?.(`serve: ${seat.room_id} ${seat.member_id} ${retryable ? "retrying in 10s" : "stopped"}: ${error.code}\n`);
        if (!retryable) return;
        await sleep(10_000);
      }
    }
    await setHealth(seat, "stopped");
  };

  // Every seat gets its own loop, and no loop awaits another, so a slow or broken Room cannot make
  // another Room miss a message. A seat joined while this runs is picked up by the next look.
  const loops = new Map<string, Promise<void>>();
  const sitting: StoredRoomCredential[] = [];
  let live = 0;
  let failure: unknown = null;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const begin = (seat: StoredRoomCredential) => {
    const key = `${seat.room_id}/${seat.member_id}`;
    if (loops.has(key)) return false;
    sitting.push(seat);
    live += 1;
    loops.set(
      key,
      supervise(seat).then(
        () => {
          live -= 1;
          if (live === 0) finish();
        },
        (error: unknown) => {
          failure ??= error;
          finish();
        },
      ),
    );
    return true;
  };
  for (const seat of seats) begin(seat);
  let looking = false;
  const rescan = setInterval(() => {
    if (looking || stopping.signal.aborted) return;
    looking = true;
    void heldSeats(paths)
      .then(async (all) => {
        const fresh = all.filter(served).filter(begin);
        if (fresh.length === 0) return;
        dependencies.stderr?.(`serve: now also sitting in ${fresh.map((seat) => `${seat.room_id} as ${seat.name}`).join(", ")}\n`);
        await statusWrite;
      })
      .catch(() => undefined)
      .finally(() => (looking = false));
  }, RESCAN_MS);
  await finished;
  await statusWrite;
  clearInterval(rescan);
  if (doorbell !== null) {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // The service stops ringing an address nobody answers; taking the doorbells down says so now.
    await Promise.all(
      sitting.map((seat) =>
        new ApiClient(seat.base_url, boundedFetch(dependencies, null, true))
          .request("PUT", `/rooms/${encodeURIComponent(seat.room_id)}/subscription`, seat.member_token, { push_url: null })
          .catch(() => undefined),
      ),
    );
    await doorbell.close();
  }
  await releaseServe(paths);
  if (failure !== null) throw failure;
  return { served: loops.size };
}

/** Where the connector remembers how far it has read in one Room. */
function serveCursorPath(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): string {
  return joinPath(paths.roomsDir, roomId, `${memberId}.serve-cursor`);
}

async function readServeCursor(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): Promise<number | null> {
  try {
    const raw = await readFile(serveCursorPath(paths, roomId, memberId), "utf8");
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeServeCursor(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string, cursor: number): Promise<void> {
  await writeFile(serveCursorPath(paths, roomId, memberId), `${cursor}\n`, { mode: 0o600 }).catch(() => undefined);
}

/**
 * A wake handed to an open session is out of the connector's hands: the session may drop it, be
 * interrupted, or answer. The cursor still moves on (else the same lines are queued again), so the
 * hand-over is written down here and stays unanswered until its session settles it, by Room, seat
 * and through, with `sharednet handed settle`. Other words from the seat do not settle it.
 */
type HandedWake = { from: number; through: number; addressed: number[]; handed_at: string };

function handedPath(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): string {
  return joinPath(paths.roomsDir, roomId, `${memberId}.handed.json`);
}

async function readHanded(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): Promise<HandedWake[]> {
  let raw: string;
  try {
    raw = await readFile(handedPath(paths, roomId, memberId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const value = JSON.parse(raw) as { schema_version?: unknown; handed?: unknown };
    if (value?.schema_version !== 1 || !Array.isArray(value.handed)) throw new Error();
    return value.handed.map((candidate) => {
      const item = candidate as Partial<HandedWake> | null;
      if (
        item === null || !Number.isSafeInteger(item.from) || (item.from as number) < 0 ||
        !Number.isSafeInteger(item.through) || (item.through as number) < (item.from as number) ||
        !Array.isArray(item.addressed) || !item.addressed.every((sequence) => Number.isSafeInteger(sequence) && sequence >= 0) ||
        typeof item.handed_at !== "string" || item.handed_at.length === 0
      ) throw new Error();
      return item as HandedWake;
    });
  } catch {
    throw localError("invalid_local_state", `The unsettled hand-over file for ${memberId} in ${roomId} is not valid SharedNet state.`);
  }
}

async function writeHanded(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string, handed: HandedWake[]): Promise<void> {
  const target = handedPath(paths, roomId, memberId);
  if (handed.length === 0) {
    await rm(target, { force: true });
    return;
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schema_version: 1, handed })}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Every change to a seat's hand-overs reads and writes under one lock, so serve adding one and a
 * settle removing another cannot overwrite each other.
 */
export async function updateHanded(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string, change: (handed: HandedWake[]) => HandedWake[]): Promise<HandedWake[]> {
  const root = joinPath(paths.roomsDir, roomId);
  return withControlLock({ root }, "handed", async () => {
    const next = change(await readHanded(paths, roomId, memberId));
    await writeHanded(paths, roomId, memberId, next);
    return next;
  });
}

/** The newest sequence in a Room, so a first start listens forward instead of replaying. */
async function roomEnd(client: ApiClient, seat: StoredRoomCredential): Promise<number> {
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(seat.room_id)}/messages?order=desc&limit=1`,
    seat.member_token,
  );
  return page.items[0]?.sequence ?? 0;
}

type ServeStatus = {
  pid: number;
  started_at: string;
  rooms: string[];
  /** True for a connector that resumes sessions; one running a --run command, or an older one, does not. */
  drives?: boolean;
  /** Capability of the running daemon, not the invoking CLI. */
  wake_protocol?: "wake-plugins-v1";
  seats?: Array<{ room_id: string; member_id: string; name: string; resumes: string | null; state?: string; last_error?: string; updated_at?: string; wake_warnings?: string[] }>;
};

function serveStatusPath(paths: ReturnType<typeof getStoragePaths>): string {
  return joinPath(paths.configDir, "serve.json");
}

async function writeServeStatus(paths: ReturnType<typeof getStoragePaths>, status: ServeStatus): Promise<void> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const temporary = `${serveStatusPath(paths)}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  await rename(temporary, serveStatusPath(paths));
}

/**
 * Takes the machine's one connector slot: null when it is now this process's, or the pid of the
 * live connector that holds it. A slot whose process is gone is taken over.
 */
async function claimServe(paths: ReturnType<typeof getStoragePaths>, status: ServeStatus): Promise<number | null> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(serveStatusPath(paths), `${JSON.stringify(status)}\n`, { mode: 0o600, flag: "wx" });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: { running?: boolean; pid?: number };
    try {
      holder = (await readServeStatus(paths)) as { running?: boolean; pid?: number };
    } catch {
      // Being written this moment by a connector that is starting.
      return 0;
    }
    // A connector run inside this very process (a test, an embedding) is this process's own.
    if (holder.running && holder.pid && holder.pid !== process.pid) return holder.pid;
    await unlink(serveStatusPath(paths)).catch(() => undefined);
  }
  return 0;
}

/** Gives the slot back, if it is still this process's. */
async function releaseServe(paths: ReturnType<typeof getStoragePaths>): Promise<void> {
  const status = (await readServeStatus(paths).catch(() => null)) as { pid?: number } | null;
  if (status?.pid === process.pid) await unlink(serveStatusPath(paths)).catch(() => undefined);
}

/** `running` is checked, not claimed: a status file outlives the process that wrote it. */
async function readServeStatus(paths: ReturnType<typeof getStoragePaths>): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(serveStatusPath(paths), "utf8");
  } catch {
    return { running: false, reason: "no connector has been started on this machine" };
  }
  const status = JSON.parse(raw) as ServeStatus;
  let running = false;
  try {
    process.kill(status.pid, 0);
    running = true;
  } catch {
    running = false;
  }
  return { running, ...status, ...(running ? {} : { reason: "the process that wrote this status is gone" }) };
}

async function stopServe(paths: ReturnType<typeof getStoragePaths>, dependencies: GuestDependencies): Promise<unknown> {
  const status = (await readServeStatus(paths)) as { running?: boolean; pid?: number };
  if (!status.running || !status.pid) return { stopped: false, reason: "no connector is running on this machine" };
  process.kill(status.pid, "SIGTERM");
  dependencies.stderr?.(`serve: asked pid ${status.pid} to stop\n`);
  return { stopped: true, pid: status.pid };
}

const TIMER_USAGE =
  "Usage: sharednet timer add '<every 20m | cron 0 9 * * 1-5 | after 2h | at 2026-10-06T09:00Z>' '<what the clock says>', sharednet timer list, or sharednet timer cancel <tm_…> [--as <member_id>]";

/**
 * `sharednet timer`: a line the Room's clock says on a schedule (wait PR 6), whether or not any
 * process is running. Name a seat in it ("@alpha review the open PRs") to wake that seat on
 * schedule; a cron is read in UTC.
 */
async function timer(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const [action, ...rest] = parsed.positionals;
  const valid =
    action === "add" ? rest.length === 2 : action === "list" ? rest.length === 0 : action === "cancel" ? rest.length === 1 && /^tm_[0-9A-Za-z]{10}$/.test(rest[0]!) : false;
  if (!valid) throw localError("invalid_arguments", TIMER_USAGE);
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const timers = `/rooms/${encodeURIComponent(state.room_id)}/timers`;
  if (action === "list") return client.request("GET", timers, credential.member_token);
  if (action === "cancel") return client.request("POST", `${timers}/${rest[0]}/cancel`, credential.member_token);
  return client.request("POST", timers, credential.member_token, { when: rest[0], say: rest[1] });
}

const WAKE_USAGE =
  "Usage: sharednet wake [--as <i_…>], sharednet wake set codex|claude-code|command [--command <path>] [--resume <session>] [--as <i_…>], sharednet wake off [--as <i_…>], sharednet wake check [--as <i_…>], sharednet wake limit <1m..24h> [--as <i_…>], or sharednet wake checkpoint <progress> [--as <i_…>]";

/**
 * A seat's wake, by hand (docs/wake-plugins.md): which plugin delivers it, what it resumes, the
 * program it calls. Local only: the service never hears a session id.
 */
async function wakeVerb(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as", "command", "resume"]);
  const [action = "show", driver, ...extra] = parsed.positionals;
  if (extra.length > 0 || !["show", "set", "off", "check", "limit", "checkpoint"].includes(action) || ["set", "limit", "checkpoint"].includes(action) !== (driver !== undefined)) {
    throw localError("invalid_arguments", WAKE_USAGE);
  }
  const paths = getStoragePaths(dependencies.env);
  const chosen = stringOption(parsed, "as") ?? dependencies.env.SHAREDNET_SEAT?.trim() ?? undefined;
  const state = await selectProjectSeat(dependencies.cwd, {
    ...(chosen === undefined ? {} : { explicit: chosen }),
    anchorKey: await anchorKeyFor(dependencies.env, paths),
  });
  if (!state) throw localError("not_in_a_room", "This directory is not in a Room. Run: sharednet join <invite>");
  const credential = await readRoomCredential(paths, state.room_id, state.member_id);
  if (!credential) throw localError("room_credential_missing", "The member token for this Room is not on this machine. Join again with a new invite.");
  const seat = { room_id: credential.room_id, member_id: credential.member_id, name: credential.name };
  const shown = (wake: SeatWake | undefined) => ({ ...seat, wake: wake ?? null, ...(wake ? { turn_limit_ms: wake.turn_limit_ms ?? DEFAULT_TURN_LIMIT_MS, checkpoint_path: checkpointPath(paths.stateDir, credential.room_id, credential.member_id), wakes: describeWake(wake), address: `@${credential.member_id}` } : {}) });

  if (action === "show") return shown(credential.wake);
  if (action === "limit") {
    if (!credential.wake) throw localError("not_driven", "Set a wake before setting its execution limit.");
    const duration = parseDuration(driver!, "wake limit");
    if (!validTurnLimit(duration)) throw localError("invalid_arguments", "The turn limit must be between 1m and 24h.");
    const wake = { ...credential.wake, turn_limit_ms: duration };
    await writeRoomCredential(paths, { ...credential, wake });
    return { ...shown(wake), applies: "next headless turn; does not extend a running turn" };
  }
  if (action === "checkpoint") {
    if (!driver?.trim() || Buffer.byteLength(driver, "utf8") > 32_768) throw localError("invalid_arguments", "Progress must contain 1–32768 bytes of text.");
    const path = checkpointPath(paths.stateDir, credential.room_id, credential.member_id);
    await saveWakeProgress(path, { room_id: credential.room_id, member_id: credential.member_id, saved_at: dependencies.now().toISOString(), progress: driver });
    return { ...seat, checkpoint_path: path, saved: true };
  }
  if (action === "off") {
    const { wake: _dropped, ...kept } = credential;
    await writeRoomCredential(paths, kept);
    dependencies.stderr?.(`${credential.member_id} is no longer woken; serve leaves it alone from its next look.\n`);
    return shown(undefined);
  }
  if (action === "check") {
    if (!credential.wake) throw localError("not_driven", `${credential.member_id} has no wake. Set one with: sharednet wake set <driver> --as ${credential.member_id}`);
    const wake = credential.wake;
    // Explicitly asked, the check proves the whole path, including one throwaway model call.
    const check = dependencies.checkWake ?? ((candidate: SeatWake, options: CheckOptions) => pluginFor(candidate.driver).check(candidate, dependencies.env, dependencies.runTurn ?? runTurn, options));
    const checked = await check(wake, { call: true });
    // Every step, so a person sees what passed as well as what failed; the error carries the failures.
    for (const step of checked.steps ?? []) dependencies.stderr?.(`wake check: ${STEP_LABELS[step.step]} ${step.status}: ${step.message}\n`);
    if (!checked.ok) throw localError("wake_command_unavailable", `${describeWake(wake)}: ${checked.message}`);
    return { ...shown(wake), check: checked.message, ...(checked.steps ? { steps: checked.steps } : {}) };
  }

  if (!isWakeDriver(driver)) throw localError("invalid_arguments", `The wake drivers are codex, claude-code and command. ${WAKE_USAGE}`);
  // What this process is, when it is the harness being set: its session, its program, its open chat.
  const here = pluginFor(driver).capture(dependencies.env, dependencies.cwd);
  const before = credential.wake?.driver === driver ? credential.wake : undefined;
  const session = stringOption(parsed, "resume") ?? before?.session ?? here?.session;
  const command = stringOption(parsed, "command") ?? before?.command ?? here?.command;
  if (driver === "command" && command === undefined) throw localError("invalid_arguments", "A command wake needs --command <path>: the adapter that is handed each wake.");
  if (driver !== "command" && session === undefined) {
    throw localError("invalid_arguments", `A ${pluginFor(driver).label} wake resumes a session: give --resume <session id>, or run this from inside that session.`);
  }
  const home = before?.codex_home ?? here?.codex_home;
  // An open chat is only this one, and only when it is the session being set.
  const live = here?.live_pid !== undefined && here.session === session ? here.live_pid : undefined;
  const wake: SeatWake = {
    driver,
    ...(driver === "command" ? {} : { session: session! }),
    cwd: before?.cwd ?? dependencies.cwd,
    ...(credential.wake?.turn_limit_ms !== undefined ? { turn_limit_ms: credential.wake.turn_limit_ms } : {}),
    command: command ?? (driver === "codex" ? (onPath("codex", dependencies.env) ?? "codex") : (onPath("claude", dependencies.env) ?? "claude")),
    ...(driver === "codex" && home ? { codex_home: home } : {}),
    ...(driver === "claude-code" && live !== undefined ? { live_pid: live } : {}),
  };
  await writeRoomCredential(paths, { ...credential, wake });
  dependencies.stderr?.(`${credential.member_id} wakes ${describeWake(wake)} when addressed; a running serve uses it from the next wake.\n`);
  return shown(wake);
}

export type GuestVerb =
  | "wake"
  | "task"
  | "timer"
  | "serve"
  | "whoami"
  | "join"
  | "say"
  | "read"
  | "wait"
  | "ack"
  | "handed"
  | "balance"
  | "redeem"
  | "pay"
  | "ledger"
  | "act"
  | "open"
  | "deliver"
  | "upload"
  | "download"
  | "files"
  | "watch"
  | "add"
  | "rooms"
  | "requests"
  | "accept"
  | "deny"
  | "reach";

export function isGuestVerb(value: string | undefined): value is GuestVerb {
  return (
    value === "wake" ||
    value === "task" ||
    value === "timer" ||
    value === "serve" ||
    value === "whoami" ||
    value === "join" ||
    value === "say" ||
    value === "read" ||
    value === "wait" ||
    value === "ack" ||
    value === "handed" ||
    value === "balance" ||
    value === "redeem" ||
    value === "pay" ||
    value === "ledger" ||
    value === "act" || value === "open" || value === "deliver" ||
    value === "upload" ||
    value === "download" ||
    value === "files" ||
    value === "watch" ||
    value === "add" ||
    value === "rooms" ||
    value === "requests" ||
    value === "accept" ||
    value === "deny" ||
    value === "reach"
  );
}

export async function runGuestVerb(
  verb: GuestVerb,
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  if (verb === "wake") return wakeVerb(args, dependencies);
  if (verb === "task") return task(args, dependencies);
  if (verb === "act" || verb === "open" || verb === "deliver") return compiledCommand(verb, args, dependencies);
  if (verb === "timer") return timer(args, dependencies);
  if (verb === "serve") return serve(args, dependencies);
  if (verb === "whoami") return whoami(args, dependencies);
  if (verb === "join") return join(args, dependencies);
  if (verb === "say") return say(args, dependencies);
  if (verb === "read") return read(args, dependencies);
  if (verb === "watch") return watch(args, dependencies);
  if (verb === "ack") return ackWake(args, dependencies);
  if (verb === "handed") return handedVerb(args, dependencies);
  if (verb === "add") return add(args, dependencies);
  if (verb === "rooms") return rooms(args, dependencies);
  if (verb === "requests") return requests(args, dependencies);
  if (verb === "accept") return answer("approved", args, dependencies);
  if (verb === "deny") return answer("denied", args, dependencies);
  if (verb === "reach") return reach(args, dependencies);
  if (verb === "balance") return balance(args, dependencies);
  if (verb === "redeem") return redeem(args, dependencies);
  if (verb === "pay") return pay(args, dependencies);
  if (verb === "ledger") return ledger(args, dependencies);
  if (verb === "upload") return upload(args, dependencies);
  if (verb === "download") return download(args, dependencies);
  if (verb === "files") return files(args, dependencies);
  return wait(args, dependencies);
}
