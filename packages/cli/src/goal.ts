import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { CompiledState } from "./compiled.ts";
import type { ApiClient } from "./api-client.ts";
import { CliError, localError } from "./errors.ts";
import { mentions, parseTrigger, saidIn, type Trigger } from "./triggers.ts";

/**
 * Goal mode on this machine (decision 2026-10-05): start a goal Room, watch it
 * until the first of its end triggers fires, close it with that trigger, and
 * keep the record. The service ends the Room itself on `count`, `after` and
 * `at`; everything that needs this machine (`check`, `idle`, what was said) is
 * evaluated here.
 */

/** Kinds an end condition may use. `every`, `cron` and `closed` wake a wait; they do not end a goal. */
const UNTIL_KINDS = new Set(["count", "after", "at", "idle", "said", "mention", "message", "check"]);
const BOUND_KINDS = new Set(["count", "after", "at", "budget"]);

/** A budget is counted in tokens, the one spend both harnesses report; it needs `goal run`, which reads it. */
export type UntilTrigger = Trigger | { kind: "budget"; label: string; tokens: number };

/** A local time with this machine's offset: `2026-10-05T17:30:00+08:00`. */
function isoWithOffset(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/**
 * One `--until`, in the words of `wait --on` plus `budget`, as the service
 * takes it: `at 17:30` becomes the next 17:30 with this machine's offset,
 * because the service cannot know this machine's clock.
 */
export function parseUntil(raw: string, now: number): { wire: string; trigger: UntilTrigger } {
  const budget = /^budget\s*:?\s*(.+)$/.exec(raw.trim());
  if (budget) {
    const tokens = /^(\d+(?:\.\d+)?)\s*([kKmM]?)(?:\s*tokens)?$/.exec(budget[1]!.trim());
    if (!tokens) throw localError("invalid_trigger", "--until budget is counted in tokens: budget 2M tokens, or budget 500k tokens.");
    const unit = tokens[2]!.toUpperCase();
    const label = `budget ${tokens[1]}${unit === "K" ? "k" : unit} tokens`;
    const scale = unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1;
    return { wire: label, trigger: { kind: "budget", label, tokens: Math.round(Number(tokens[1]) * scale) } };
  }
  const trigger = parseTrigger(raw, now);
  if (!UNTIL_KINDS.has(trigger.kind)) {
    throw localError("invalid_trigger", `--until ${trigger.kind} wakes a wait; it does not end a goal. Use count, after, at, idle, said, mention, message, check, or budget.`);
  }
  if (trigger.kind === "at") {
    const wire = `at ${isoWithOffset(trigger.time)}`;
    return { wire, trigger: { ...trigger, label: wire } };
  }
  return { wire: trigger.label, trigger };
}

/**
 * Every `--until`, refusing a goal that names no bound before anything is sent. A budget is
 * only offered where it is measured: `goal run` starts the Agents and reads their usage; a
 * Room whose Agents someone else started would carry a bound that nothing enforces.
 */
export function parseUntilList(
  raws: readonly string[],
  now: number,
  options: { budget?: boolean } = {},
): { wire: string[]; triggers: UntilTrigger[] } {
  const bounds = options.budget ? "count, after, at, or budget" : "count, after, or at";
  if (raws.length === 0) throw localError("invalid_arguments", `A goal needs at least one --until, and one of them a bound: ${bounds}.`);
  const parsed = raws.map((raw) => parseUntil(raw, now));
  if (!options.budget && parsed.some((entry) => entry.trigger.kind === "budget")) {
    throw localError(
      "budget_needs_goal_run",
      "--until budget is counted from the Agents' own usage, which only goal run reads. Start the goal with goal run, or bound it with count, after or at.",
    );
  }
  if (!parsed.some((entry) => BOUND_KINDS.has(entry.trigger.kind))) {
    throw localError("goal_unbounded", `A goal Room needs a bound it cannot outrun: add --until with ${bounds}.`);
  }
  const wire = [...new Set(parsed.map((entry) => entry.wire))];
  return { wire, triggers: parsed.map((entry) => entry.trigger) };
}

/** Make a Room this account owns a goal Room: the goal is said as the owner's first line. */
export async function startGoal(
  client: ApiClient,
  apiKey: string,
  roomId: string,
  content: string,
  until: readonly string[],
): Promise<{ room: unknown; message: unknown }> {
  return client.request("POST", `/rooms/${encodeURIComponent(roomId)}/goal`, apiKey, { content, until });
}

// ---- watching a goal ----

interface MessageShape {
  sequence: number;
  content: string;
  sender?: { member_id?: string; name?: string | null };
  sender_instance_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

interface GoalShape {
  message_id: string;
  sequence: number;
  until: string[];
  started_at: string;
  ended_by: { trigger: string; at: string; detail: string | null } | null;
}

interface RoomShape {
  room?: { id?: string; type?: "board" | "compiled"; state?: string; goal?: GoalShape | null };
  memberships?: Array<{ member_id?: string; name?: string | null; runtime_kind?: string }>;
}

export type CheckRunner = (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;

export interface GoalWatchDependencies {
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (value: string) => void;
  /** Runs a `check` in the workspace; tests replace it. */
  check?: CheckRunner;
  /** Takes a workspace snapshot; tests replace it, and null turns snapshots off. */
  snapshot?: ((label: string) => Promise<string | null>) | null;
  /** Tokens the Agents have used so far, when this runner started them (`goal run`); a budget is judged on it. */
  spend?: () => number;
}

export interface GoalWatchOptions {
  roomId: string;
  /** Where the Agents work; checks run here and its snapshots are taken from here. */
  workspace: string;
  /** Where the record goes: room.ndjson, checks.ndjson, episode.json, workspace.git. */
  out: string;
  checkEveryMs: number;
  /** Do not post a failing check back into the Room (a controlled experiment). */
  quietChecks: boolean;
  /** Read the Room's state at least this often, to notice an end the service or the owner made. */
  roomCheckMs?: number;
}

/** The wait the runner sits in, bounded the way the service bounds every wait. */
const WAIT_MAX_SECONDS = 25;
const CHECK_OUTPUT_LIMIT = 4_000;
/** No one request may take longer: the long-poll holds 25 s, so 30 s means the line went dead. */
export const REQUEST_LIMIT_MS = 30_000;
const OUTAGE_BASE_MS = 1_000;
const OUTAGE_CAP_MS = 30_000;
/** Closing is the runner's last word; it is worth a minute of trying. */
const CLOSE_ATTEMPTS = 6;
/** How often a budget is looked at while nothing is said. */
const BUDGET_LOOK_MS = 5_000;

/**
 * A fetch that gives up on any one request after `limitMs`. A runner sits for hours, and a
 * connection dropped without a reset would otherwise hold it forever: checks unrun, clock unread.
 */
export function withRequestLimit(fetchImplementation: typeof globalThis.fetch, limitMs = REQUEST_LIMIT_MS): typeof globalThis.fetch {
  return (input, init) => {
    const limit = AbortSignal.timeout(limitMs);
    return fetchImplementation(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
  };
}

/** Not reaching the service, or the service failing, is weather to wait out; a refusal is an answer. */
function isOutage(error: unknown): error is CliError {
  return error instanceof CliError && error.exitCode === 5;
}

function tail(value: string): string {
  const characters = [...value];
  return characters.length <= CHECK_OUTPUT_LIMIT ? value : characters.slice(-CHECK_OUTPUT_LIMIT).join("");
}

function defaultCheck(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveCheck) => {
    execFile("sh", ["-c", command], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveCheck({ exitCode: code, output: `${stdout}${stderr}` });
    });
  });
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveGit) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveGit({ code, stdout: String(stdout) });
    });
  });
}

/**
 * Snapshots of the shared workspace in a git directory of their own, so the
 * Agents' own use of git is untouched: one commit per tick that changed
 * anything, tagged with the Room sequence it follows, so "what was said at #17"
 * and "what the files were at #17" line up. A record is made to be handed on,
 * so it never takes an .env file; and it leaves out the CLI's seat state
 * (.sharednet/), which is bookkeeping, not work.
 */
export function workspaceSnapshots(workspace: string, out: string): (label: string) => Promise<string | null> {
  const gitDir = join(out, "workspace.git");
  const base = ["-c", "user.name=sharednet goal", "-c", "user.email=goal@sharednet.invalid", `--git-dir=${gitDir}`, `--work-tree=${workspace}`];
  let ready: Promise<void> | null = null;
  const prepare = async () => {
    await mkdir(join(gitDir, "info"), { recursive: true });
    await git([`--git-dir=${gitDir}`, "init", "--quiet"], workspace);
    const excluded = [".sharednet/", ".env", ".env.*", "!.env.example"];
    // The record must not record itself when it lives inside the workspace.
    const inside = relative(workspace, out);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
      excluded.push(`/${inside.split("\\").join("/")}/`);
    }
    await writeFile(join(gitDir, "info", "exclude"), `${excluded.join("\n")}\n`);
  };
  return async (label: string) => {
    ready ??= prepare();
    await ready;
    // A file the runner may not read (a benchmark's execute-only reference binary, say) is left out
    // of the snapshot instead of failing it.
    await git([...base, "add", "-A", "--ignore-errors"], workspace);
    const staged = await git([...base, "diff", "--cached", "--quiet"], workspace);
    const empty = (await git([...base, "rev-parse", "--verify", "HEAD"], workspace)).code !== 0;
    if (staged.code === 0 && !empty) return null;
    await git([...base, "commit", "--quiet", "--allow-empty", "-m", label], workspace);
    const tag = label.replace(/[^A-Za-z0-9._-]+/g, "-");
    await git([...base, "tag", "-f", tag], workspace);
    return (await git([...base, "rev-parse", "HEAD"], workspace)).stdout.trim() || null;
  };
}

export interface GoalWatchResult {
  room_id: string;
  ended_by: { trigger: string; at: string; detail: string | null } | null;
  messages: number;
  checks: number;
  snapshots: number;
  out: string;
}

/**
 * Sit in a goal Room until one of its end triggers fires, then close it with
 * that trigger and write the record. `said` is a claim: when the goal also has
 * a `check`, a claim runs the check and only a passing check ends the Room; a
 * failing one is said back into the Room by the runner, unless the run is an
 * experiment that must not intervene.
 */
export async function goalWatch(
  client: ApiClient,
  memberToken: string,
  apiKey: string,
  options: GoalWatchOptions,
  dependencies: GoalWatchDependencies,
): Promise<GoalWatchResult> {
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const log = dependencies.stderr ?? (() => undefined);
  const runCheck = dependencies.check ?? defaultCheck;
  const snapshot = dependencies.snapshot === undefined ? workspaceSnapshots(options.workspace, options.out) : dependencies.snapshot;
  const roomPath = `/rooms/${encodeURIComponent(options.roomId)}`;
  const roomCheckMs = options.roomCheckMs ?? 30_000;

  const readRoom = () => client.request<RoomShape>("GET", roomPath, memberToken);
  let view = await readRoom();
  const goal = view.room?.goal ?? null;
  if (!goal) throw localError("not_a_goal_room", "That Room has no goal. Start one with sharednet room create --goal <file> --until <trigger>.");
  const startedAt = Date.parse(goal.started_at);
  // A budget this CLI cannot read (a dollar amount, from an older CLI) is kept by the service and left unjudged here.
  const triggers = goal.until.flatMap((raw) => {
    try {
      return [parseUntil(raw, dependencies.now().getTime()).trigger];
    } catch (error) {
      if (/^budget\b/.test(raw)) return [];
      throw error;
    }
  });
  const checks = triggers.filter((trigger): trigger is Extract<Trigger, { kind: "check" }> => trigger.kind === "check");
  const said = triggers.filter((trigger): trigger is Extract<Trigger, { kind: "said" }> => trigger.kind === "said");
  // The person a `mention` addresses is the goal's speaker; the runner's own lines never count as the Agents'.
  const goalSpeaker = (view.memberships ?? []).find((member) => member.runtime_kind === "human") ?? null;
  const runnerSeats = new Set((view.memberships ?? []).filter((member) => member.runtime_kind === "runner").map((member) => member.member_id ?? ""));

  await mkdir(options.out, { recursive: true });
  const roomLog = join(options.out, "room.ndjson");
  const checkLog = join(options.out, "checks.ndjson");
  // The Room's log is read again from its start; checks a stopped runner already ran are history and stay.
  await writeFile(roomLog, "");
  const earlierChecks = await readFile(checkLog, "utf8").then((text) => text.split("\n").filter(Boolean).length, () => null);
  if (earlierChecks === null) await writeFile(checkLog, "");
  const runnerStartedAt = dependencies.now().toISOString();

  let cursor = 0;
  let messages = 0;
  let checkCount = earlierChecks ?? 0;
  let snapshots = 0;
  let lastMessageAt: number | null = null;
  let lastRoomCheckAt = dependencies.now().getTime();
  const checkState = new Map<string, { passing: boolean; ranAt: number | null }>();
  for (const check of checks) checkState.set(check.label, { passing: false, ranAt: null });
  let end: { trigger: string; detail: string | null } | null = null;
  let endedByService: GoalShape["ended_by"] = goal.ended_by;

  const takeSnapshot = async (label: string) => {
    if (!snapshot) return;
    if ((await snapshot(label).catch(() => null)) !== null) snapshots += 1;
  };

  /** Runs one check; returns whether it passes now, and its output. */
  const evaluate = async (check: Extract<Trigger, { kind: "check" }>, cause: "schedule" | "claim") => {
    const result = await runCheck(check.command, options.workspace);
    const at = dependencies.now();
    const state = checkState.get(check.label)!;
    state.ranAt = at.getTime();
    const passing = result.exitCode === 0;
    const startedPassing = passing && !state.passing;
    state.passing = passing;
    checkCount += 1;
    await appendFile(
      checkLog,
      `${JSON.stringify({ at: at.toISOString(), trigger: check.label, command: check.command, cause, exit_code: result.exitCode, passed: passing, sequence: cursor, output: tail(result.output) })}\n`,
    );
    return { passing, startedPassing, exitCode: result.exitCode, output: tail(result.output) };
  };

  const feedback = async (content: string) => {
    if (options.quietChecks) return;
    try {
      const posted = await client.request<{ message?: { sender_instance_id?: string } }>(
        "POST",
        `${roomPath}/owner-messages`,
        apiKey,
        { content, as: "runner" },
      );
      if (posted?.message?.sender_instance_id) runnerSeats.add(posted.message.sender_instance_id);
    } catch (error) {
      log(`goal: the check result was not posted (${error instanceof CliError ? error.code : "error"})\n`);
    }
  };

  /** An outage is ridden out with a growing pause, and the loop goes on: the clock and the checks still count. */
  let failedAttempts = 0;
  const rideOut = async (error: unknown, doing: string) => {
    if (!isOutage(error)) throw error;
    const pause = Math.min(OUTAGE_BASE_MS * 2 ** failedAttempts, OUTAGE_CAP_MS);
    failedAttempts += 1;
    log(`goal: the service did not answer while ${doing} (${error.code}); trying again in ${Math.round(pause / 1000)}s, attempt ${failedAttempts}\n`);
    await sleep(pause);
  };
  const answered = () => {
    if (failedAttempts > 0) log(`goal: the service answers again, after ${failedAttempts} failed attempt${failedAttempts === 1 ? "" : "s"}\n`);
    failedAttempts = 0;
  };

  await takeSnapshot(earlierChecks === null ? "start" : "restart");
  log(`goal: watching ${options.roomId} until ${goal.until.join(" | ")}\n`);
  const spend = dependencies.spend ?? null;
  for (const trigger of triggers) {
    if (trigger.kind === "budget" && !spend) log(`goal: ${trigger.label} is not measured here; goal watch did not start the Agents, so it cannot read their spend\n`);
  }

  for (;;) {
    if (endedByService) break;
    const now = dependencies.now().getTime();

    // What has come round on the clock, or gone quiet for long enough.
    for (const trigger of triggers) {
      if (end) break;
      if (trigger.kind === "count" && cursor - goal.sequence >= trigger.count) end = { trigger: trigger.label, detail: null };
      if (trigger.kind === "after" && now >= startedAt + trigger.ms) end = { trigger: trigger.label, detail: null };
      if (trigger.kind === "at" && now >= trigger.time) end = { trigger: trigger.label, detail: null };
      if (trigger.kind === "idle" && lastMessageAt !== null && now - lastMessageAt >= trigger.ms) end = { trigger: trigger.label, detail: null };
      if (trigger.kind === "budget" && spend) {
        const used = spend();
        if (used >= trigger.tokens) end = { trigger: trigger.label, detail: `${used} tokens` };
      }
    }
    // A check that has started to pass ends it; checked on its schedule.
    for (const check of checks) {
      if (end) break;
      const state = checkState.get(check.label)!;
      if (state.ranAt !== null && now - state.ranAt < options.checkEveryMs) continue;
      const result = await evaluate(check, "schedule");
      if (result.startedPassing) end = { trigger: check.label, detail: result.output.trim() || null };
    }
    if (end) break;

    // Sit until something is said, or the next thing on the clock is due.
    let waitMs = WAIT_MAX_SECONDS * 1000;
    for (const trigger of triggers) {
      if (trigger.kind === "after") waitMs = Math.min(waitMs, startedAt + trigger.ms - now);
      if (trigger.kind === "at") waitMs = Math.min(waitMs, trigger.time - now);
      if (trigger.kind === "idle" && lastMessageAt !== null) waitMs = Math.min(waitMs, lastMessageAt + trigger.ms - now);
      // Spend grows between messages, as turns end: look at it every few seconds.
      if (trigger.kind === "budget" && spend) waitMs = Math.min(waitMs, BUDGET_LOOK_MS);
    }
    for (const check of checks) {
      const ranAt = checkState.get(check.label)!.ranAt;
      waitMs = Math.min(waitMs, ranAt === null ? 0 : ranAt + options.checkEveryMs - now);
    }
    const timeout = Math.min(WAIT_MAX_SECONDS, Math.max(0, Math.ceil(waitMs / 1000)));
    let items: MessageShape[] = [];
    // A closed Room answers every wait at once; read its end now rather than ask again in a loop.
    let closed = false;
    try {
      const page = await client.request<{ items?: MessageShape[] }>("GET", `${roomPath}/wait?after=${cursor}&timeout=${timeout}`, memberToken);
      items = Array.isArray(page?.items) ? page.items : [];
      answered();
    } catch (error) {
      if (error instanceof CliError && error.code === "room_closed") closed = true;
      else {
        await rideOut(error, "waiting in the Room");
        continue;
      }
    }

    let claim: MessageShape | null = null;
    for (const item of items.sort((left, right) => left.sequence - right.sequence)) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence <= cursor) continue;
      cursor = item.sequence;
      messages += 1;
      await appendFile(roomLog, `${JSON.stringify(item)}\n`);
      if (item.sequence <= goal.sequence) continue;
      const sender = item.sender_instance_id ?? item.sender?.member_id ?? "";
      if (runnerSeats.has(sender)) continue;
      lastMessageAt = dependencies.now().getTime();
      if (end) continue;
      if (triggers.some((trigger) => trigger.kind === "message")) end = { trigger: "message", detail: item.content.slice(0, 500) };
      else if (
        goalSpeaker !== null &&
        triggers.some((trigger) => trigger.kind === "mention") &&
        mentions(item.content, { memberId: goalSpeaker.member_id ?? "", name: goalSpeaker.name ?? null })
      ) {
        end = { trigger: "mention", detail: item.content.slice(0, 500) };
      } else if (said.some((trigger) => saidIn(item.content, trigger)) && claim === null) {
        claim = item;
      }
    }
    if (items.length > 0) await takeSnapshot(`seq ${cursor}`);

    // A claim of being done: the check decides when there is one, and a failing check is said back.
    if (!end && claim) {
      const claimed = said.find((trigger) => saidIn(claim!.content, trigger))!;
      if (checks.length === 0) {
        end = { trigger: claimed.label, detail: claim.content.slice(0, 500) };
      } else {
        for (const check of checks) {
          const result = await evaluate(check, "claim");
          if (result.passing) {
            end = { trigger: check.label, detail: result.output.trim() || null };
            break;
          }
          await feedback(
            `#${claim.sequence} says done, but \`${check.command}\` still fails (exit ${result.exitCode}):\n\n${tail(result.output).trim() || "(no output)"}`,
          );
        }
      }
    }
    if (end) break;

    // The service ends a goal on count, after and at by itself, and the owner may close it from
    // the Dashboard: read the Room now and then so either is noticed.
    const at = dependencies.now().getTime();
    if (closed || at - lastRoomCheckAt >= roomCheckMs || (items.length === 0 && timeout === 0)) {
      lastRoomCheckAt = at;
      try {
        view = await readRoom();
        answered();
      } catch (error) {
        await rideOut(error, "reading the Room");
        continue;
      }
      if (closed || view.room?.state === "closed") {
        endedByService = view.room?.goal?.ended_by ?? { trigger: "owner", at: new Date(at).toISOString(), detail: null };
      }
    }
    if (items.length === 0 && timeout === 0) await sleep(0);
  }

  // Close with the trigger that fired; the service keeps the first end it was told.
  let endedBy = endedByService;
  for (let attempt = 1; !endedBy && end; attempt += 1) {
    try {
      const closed = await client.request<{ room?: { goal?: GoalShape | null } }>("POST", `${roomPath}/close`, apiKey, end);
      endedBy = closed?.room?.goal?.ended_by ?? { ...end, at: dependencies.now().toISOString() };
    } catch (error) {
      if (isOutage(error) && attempt < CLOSE_ATTEMPTS) {
        await rideOut(error, "closing the Room");
        continue;
      }
      log(`goal: the Room was not closed (${error instanceof CliError ? error.code : "error"}); its end is recorded here\n`);
      endedBy = { ...end, at: dependencies.now().toISOString() };
    }
  }
  await takeSnapshot("end");
  if (view.room?.type === "compiled") await exportCompiled(client, memberToken, options.roomId, options.out);
  const budget = spend ? [] : triggers.filter((trigger) => trigger.kind === "budget").map((trigger) => trigger.label);
  const result: GoalWatchResult = { room_id: options.roomId, ended_by: endedBy, messages, checks: checkCount, snapshots, out: options.out };
  await writeFile(
    join(options.out, "episode.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        room_id: options.roomId,
        goal: { message_id: goal.message_id, sequence: goal.sequence, until: goal.until, started_at: goal.started_at },
        ended_by: endedBy,
        runner: { started_at: runnerStartedAt, ended_at: dependencies.now().toISOString(), workspace: resolve(options.workspace) },
        totals: { messages, checks: checkCount, snapshots, ...(spend ? { tokens: spend() } : {}) },
        ...(budget.length > 0 ? { not_measured: budget.map((label) => `${label}: goal watch did not start the Agents, so it cannot read their spend; goal run can`) } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return result;
}

/** The Room's log and its goal, written out without watching: for a Room that has already ended. */
export async function goalExport(client: ApiClient, memberToken: string, roomId: string, out: string): Promise<{ room_id: string; messages: number; out: string }> {
  const roomPath = `/rooms/${encodeURIComponent(roomId)}`;
  const view = await client.request<RoomShape>("GET", roomPath, memberToken);
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  let after = 0;
  for (;;) {
    const page = await client.request<{ items?: MessageShape[]; has_more?: boolean }>("GET", `${roomPath}/messages?after=${after}&limit=100`, memberToken);
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const item of items) {
      lines.push(JSON.stringify(item));
      after = Math.max(after, item.sequence);
    }
    if (!page?.has_more || items.length === 0) break;
  }
  if (view.room?.type === "compiled") await exportCompiled(client, memberToken, roomId, out);
  await writeFile(join(out, "room.ndjson"), lines.length ? `${lines.join("\n")}\n` : "");
  await writeFile(
    join(out, "episode.json"),
    `${JSON.stringify({ schema_version: 1, room_id: roomId, goal: view.room?.goal ?? null, state: view.room?.state ?? null, totals: { messages: lines.length } }, null, 2)}\n`,
  );
  return { room_id: roomId, messages: lines.length, out };
}

/** The goal file, read as the Room will see it. */
export async function readGoalFile(cwd: string, path: string): Promise<string> {
  try {
    const content = await readFile(resolve(cwd, path), "utf8");
    if (content.trim() === "") throw localError("invalid_arguments", "--goal names an empty file.");
    return content;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw localError("invalid_arguments", `--goal names a file that could not be read: ${path}`);
  }
}

/** Keep the authoritative typed state and canonical replay log alongside the prose export. */
async function exportCompiled(client: ApiClient, token: string, roomId: string, out: string): Promise<void> {
  const state = await client.request<CompiledState>("GET", `/rooms/${encodeURIComponent(roomId)}/state`, token);
  await writeFile(join(out, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(join(out, "acts.ndjson"), state.events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}
