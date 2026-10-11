import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { ApiClient } from "./api-client.ts";
import { withControlLock } from "./board-controls.ts";
import { CliError, localError } from "./errors.ts";
import type { GuestDependencies } from "./guest.ts";
import { getStoragePaths, readSecureFile, writeSecureJson, type StoredRoomCredential } from "./storage.ts";
import { pluginFor } from "./wake-plugins.ts";
import { replyFrom, runTurn, wakeTurnPrompt, type SeatWake, type WakeMessage } from "./wake-driver.ts";

const PROTOCOL = "trigger-wakes-v1";
const HEADERS = { "X-SharedNet-Wake-Protocol": PROTOCOL };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELP = "Usage: sharednet trigger list | continuation --reply-to msg_… [--request-key UUID] | cancel trg_… | serve --headless [--once] [--no-continuation], with --as i_…";
interface Seat { client: ApiClient; credential: StoredRoomCredential }
interface Wake {
  id: string;
  room_id: string;
  target_instance_id: string;
  source_message_id: string;
  source_sequence: number;
  source_is_human: boolean;
  state: string;
  reasons?: { kind: "mention" | "continuation" }[];
}
interface Execution {
  wake: Wake;
  base_url: string;
  execution_key: string;
  executor_epoch: number;
  stage: "reserved" | "claimed" | "starting" | "output" | "published" | "completed" | "cancelled";
  receipt?: string;
  reply?: string | null;
  outcome?: "completed" | "failed";
  continuation: boolean;
}
interface Journal { blocked?: boolean; version: 1; executor_id: string; executions: Record<string, Execution>; cursors: Record<string, string> }

/** A runtime session, independent of Room, seat, working directory and service origin. */
function sessionScope(wake: SeatWake): string {
  return createHash("sha256").update(JSON.stringify(wake.session ? [wake.driver, wake.session] : [wake.driver, wake.command, wake.cwd])).digest("hex");
}
function journalError(): never { throw localError("trigger_journal_invalid", "The execution journal is invalid; reconcile it before continuing."); }
function parseJournal(raw: string | null): Journal {
  if (raw === null) return { version: 1, executor_id: randomUUID(), executions: {}, cursors: {} };
  let value: Journal;
  try { value = JSON.parse(raw) as Journal; } catch { return journalError(); }
  if (!value || value.version !== 1 || !UUID.test(value.executor_id) || !value.executions || typeof value.executions !== "object" || Array.isArray(value.executions)) return journalError();
  if (!value.cursors || typeof value.cursors !== "object" || Array.isArray(value.cursors) || !Object.values(value.cursors).every(cursor => typeof cursor === "string")) return journalError();
  for (const entry of Object.values(value.executions)) {
    if (!entry || !UUID.test(entry.execution_key) || !validWake(entry.wake) || typeof entry.base_url !== "string" || typeof entry.continuation !== "boolean" || !Number.isSafeInteger(entry.executor_epoch) || !["reserved", "claimed", "starting", "output", "published", "completed", "cancelled"].includes(entry.stage)) return journalError();
    if (!["reserved", "cancelled"].includes(entry.stage) && typeof entry.receipt !== "string") return journalError();
    if (["output", "published", "completed"].includes(entry.stage) && (!(entry.reply === null || typeof entry.reply === "string") || !["completed", "failed"].includes(entry.outcome ?? ""))) return journalError();
  }
  return value;
}
function validWake(value: unknown): value is Wake {
  if (!value || typeof value !== "object") return false;
  const w = value as Wake;
  return /^wak_[A-Za-z0-9]{10}$/.test(w.id) && /^rom_[A-Za-z0-9]{10}$/.test(w.room_id) && /^i_[A-Za-z0-9]{10}$/.test(w.target_instance_id) && /^msg_[A-Za-z0-9]{10}$/.test(w.source_message_id) && Number.isSafeInteger(w.source_sequence) && w.source_sequence > 0 && typeof w.source_is_human === "boolean" && ["pending", "claimed", "start_authorized", "completed", "failed", "interrupted", "cancelled"].includes(w.state);
}
function uncertain(): never { throw localError("needs_reconciliation", "A turn may already have started in this session. Reconcile its execution journal before serving again; it will not be relaunched."); }
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function assertClosed(wake: SeatWake): void {
  // PID metadata cannot prove a live process is harmless. Refuse while it exists.
  if (wake.live_pid !== undefined && processExists(wake.live_pid)) {
    throw localError("trigger_headless_required", "The saved session is open; only closed headless sessions support trigger delivery.");
  }
}

export async function runTriggerCommand(args: string[], dependencies: GuestDependencies, resolve: (explicit?: string) => Promise<Seat>): Promise<unknown> {
  const [verb, ...rest] = args;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    if (["--headless", "--once", "--no-continuation"].includes(arg)) {
      if (flags.has(arg)) throw localError("duplicate_option", HELP);
      flags.add(arg); continue;
    }
    if (!["--as", "--reply-to", "--request-key"].includes(arg) || values.has(arg)) throw localError("invalid_arguments", HELP);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw localError("invalid_arguments", HELP);
    values.set(arg, value);
  }
  if (!["list", "continuation", "cancel", "serve"].includes(verb ?? "") || (verb === "cancel" ? positionals.length !== 1 : positionals.length !== 0)) throw localError("invalid_arguments", HELP);
  if (verb !== "serve" && flags.size || verb !== "continuation" && (values.has("--reply-to") || values.has("--request-key"))) throw localError("invalid_arguments", HELP);
  if (verb === "serve" && !flags.has("--headless")) throw localError("trigger_headless_required", HELP);
  const reply = values.get("--reply-to"), requestKey = values.get("--request-key") ?? randomUUID();
  if (verb === "continuation" && (!reply || !/^msg_[A-Za-z0-9]{10}$/.test(reply) || !UUID.test(requestKey))) throw localError("invalid_arguments", HELP);
  if (verb === "cancel" && !/^trg_[A-Za-z0-9]{10}$/.test(positionals[0]!)) throw localError("invalid_arguments", HELP);
  const seat = await resolve(values.get("--as"));
  const { client, credential } = seat;
  const path = `/rooms/${encodeURIComponent(credential.room_id)}`;
  if (verb === "list") return client.request("GET", `${path}/triggers`, credential.member_token, undefined, HEADERS);
  if (verb === "cancel") return client.request("POST", `${path}/triggers/${positionals[0]}/cancel`, credential.member_token, {}, HEADERS);
  if (verb === "continuation") return client.request("POST", `${path}/triggers`, credential.member_token, { source: "room.message.posted", recipe: "continuation", reply_message_id: reply, request_key: requestKey }, HEADERS);
  const driver = credential.wake;
  if (!driver) throw localError("trigger_headless_required", "Configure a closed session with sharednet wake set before using trigger serve.");
  assertClosed(driver);
  const checked = await (dependencies.checkWake ?? ((wake: SeatWake) => pluginFor(wake.driver).check(wake, dependencies.env, dependencies.runTurn ?? runTurn)))(driver);
  if (!checked.ok) throw localError("wake_command_unavailable", "The saved headless wake program is unavailable; run sharednet wake check.");
  let processed = 0;
  do {
    if (dependencies.signal?.aborted) break;
    // A different Room/seat of the same session waits here, before enrollment or claim.
    const root = join(getStoragePaths(dependencies.env).stateDir, "trigger-sessions", sessionScope(driver));
    try {
      await withControlLock({ root, read: "", tasks: "", events: "", taskSeen: "" }, "task", async () => {
        const file = join(root, "journal.json");
        const journal = parseJournal(await readSecureFile(file));
        if (journal.blocked || Object.values(journal.executions).some(entry => entry.stage === "starting")) uncertain();
        const save = () => writeSecureJson(file, journal);
        await save();
        const mode = await client.request<{ protocol: string; executor_epoch: number }>("POST", `${path}/wake-mode`, credential.member_token, { protocol: PROTOCOL, executor_id: journal.executor_id }, HEADERS);
        if (mode.protocol !== PROTOCOL || !Number.isSafeInteger(mode.executor_epoch) || mode.executor_epoch < 1) throw localError("invalid_server_response", "Wake enrollment did not return a valid fencing epoch.");
        const request = <T>(method: string, suffix: string, body?: unknown, headers = {}) => client.request<T>(method, `${path}${suffix}`, credential.member_token, body, { ...HEADERS, ...headers });
        const cancelledBeforeStart = async (entry: Execution, error: unknown) => {
          if (!(error instanceof CliError) || error.code !== "wake_cancelled" || error.exitCode !== 4) return false;
          // Only this definitive pre-start refusal ends one delivery. Fencing,
          // revoked auth and unknown starts must still stop the consumer.
          entry.stage = "cancelled"; entry.wake.state = "cancelled";
          await save();
          return true;
        };
        const finish = async (entry: Execution) => {
          const identity = { execution_key: entry.execution_key, executor_id: journal.executor_id, executor_epoch: entry.executor_epoch, receipt: entry.receipt };
          if (entry.stage === "output") {
            if (entry.reply !== null) await request("POST", "/messages", { content: entry.reply, reply_to_message_id: entry.wake.source_message_id, ...(entry.continuation ? { continuation: { request_key: entry.execution_key } } : {}) }, { "idempotency-key": entry.execution_key });
            entry.stage = "published"; await save();
          }
          if (entry.stage === "published") {
            await request("POST", `/wakes/${entry.wake.id}/complete`, { ...identity, outcome: entry.outcome });
            entry.stage = "completed"; await save(); processed++;
          }
        };
        // Completion recovery does not depend on an inbox cursor or a repeated wake listing.
        for (const entry of Object.values(journal.executions)) {
          if (entry.base_url === client.baseUrl && entry.wake.room_id === credential.room_id && entry.wake.target_instance_id === credential.member_id) await finish(entry);
        }
        const cursorKey = `${client.baseUrl}/${credential.room_id}/${credential.member_id}`;
        while (true) {
          const cursor = journal.cursors[cursorKey];
          const page = await request<{ items: unknown[]; next_cursor: string | null }>("GET", `/wakes?limit=50${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
          if (!Array.isArray(page.items) || !page.items.every(validWake) || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw localError("invalid_server_response", "The wake inbox is malformed.");
          for (const item of page.items) {
            const wake = item as Wake;
            if (wake.room_id !== credential.room_id || wake.target_instance_id !== credential.member_id) throw localError("invalid_server_response", "The wake inbox belongs to another seat.");
            if (["completed", "failed", "interrupted", "cancelled"].includes(wake.state)) continue;
            const key = `${client.baseUrl}/${credential.room_id}/${wake.id}`;
            let entry = journal.executions[key];
            if (entry?.stage === "completed" || entry?.stage === "cancelled") continue;
            if (!entry && wake.state === "start_authorized") { journal.blocked = true; await save(); uncertain(); }
            if (!entry) {
              entry = { wake, base_url: client.baseUrl, execution_key: randomUUID(), executor_epoch: mode.executor_epoch, stage: "reserved", continuation: wake.source_is_human && !flags.has("--no-continuation") };
              journal.executions[key] = entry; await save();
            }
            const identity = { execution_key: entry.execution_key, executor_id: journal.executor_id, executor_epoch: entry.executor_epoch };
            if (entry.stage === "reserved") {
              let claimed: { receipt: string; wake: Wake };
              try { claimed = await request("POST", `/wakes/${wake.id}/claim`, identity); }
              catch (error) { if (await cancelledBeforeStart(entry, error)) continue; throw error; }
              if (!validWake(claimed.wake) || claimed.wake.id !== wake.id || claimed.wake.state !== "claimed") { journal.blocked = true; await save(); uncertain(); }
              if (typeof claimed.receipt !== "string" || !claimed.receipt) throw localError("invalid_server_response", "The wake claim has no receipt.");
              entry.receipt = claimed.receipt; entry.stage = "claimed"; await save();
            }
            if (entry.stage === "claimed") {
              const history = await request<{ items: (WakeMessage & { id: string })[] }>("GET", `/messages?before=${wake.source_sequence + 1}&order=desc&limit=50`);
              const message = history.items?.find(message => message.id === wake.source_message_id && message.sequence === wake.source_sequence && typeof message.content === "string");
              if (!message) throw localError("invalid_server_response", "The wake source message is unavailable.");
              assertClosed(driver);
              // Written BEFORE authorization: a lost response or crash must never imply a launch permit.
              entry.stage = "starting"; await save();
              try {
                const started = await request<{ receipt: string; wake: Wake }>("POST", `/wakes/${wake.id}/start`, { ...identity, receipt: entry.receipt });
                if (!validWake(started.wake) || started.wake.id !== wake.id || started.wake.state !== "start_authorized" || started.receipt !== entry.receipt) uncertain();
              }
              catch (error) {
                if (await cancelledBeforeStart(entry, error)) continue;
                // Other definitive refusals preserve the claim and stop for inspection.
                if (error instanceof CliError && error.exitCode !== 5 && error.code !== "needs_reconciliation") { entry.stage = "claimed"; await save(); }
                throw error;
              }
              const input = { roomId: credential.room_id, memberId: credential.member_id, seat: credential.name, from: wake.source_sequence - 1, through: wake.source_sequence, messages: history.items.filter(message => message.sequence <= wake.source_sequence).sort((left, right) => left.sequence - right.sequence) };
              const delivery = await pluginFor(driver.driver).deliver(driver, { ...input, trigger: wake.reasons?.some(reason => reason.kind === "mention") ? "mention" : "continuation", sourceMessageId: wake.source_message_id, wakeId: wake.id, prompt: `This turn answers source message ${wake.source_message_id} (wake ${wake.id}).\n${wakeTurnPrompt(input)}`, livePrompt: "" }, { env: dependencies.env, run: dependencies.runTurn ?? runTurn, chatOpen: processExists, timeoutMs: 20 * 60_000, headlessOnly: true });
              if (delivery.kind === "handed" || delivery.kind === "left" || delivery.kind === "failed" && delivery.timedOut) uncertain();
              entry.reply = delivery.kind === "replied" ? replyFrom(delivery.reply, 32_768) : null;
              entry.outcome = delivery.kind === "replied" ? "completed" : "failed";
              entry.stage = "output"; await save();
            }
            await finish(entry);
          }
          if (page.next_cursor) { journal.cursors[cursorKey] = page.next_cursor; await save(); }
          if (page.items.length < 50 || !page.next_cursor) break;
          if (page.next_cursor === cursor) throw localError("invalid_server_response", "The wake cursor did not advance.");
        }
      });
    } catch (error) {
      if (flags.has("--once") || !(error instanceof CliError) || !(error.exitCode === 5 || error.code === "local_state_busy")) throw error;
      dependencies.stderr?.(`trigger serve: retrying ${error.code} from the durable journal\n`);
    }
    if (flags.has("--once") || dependencies.signal?.aborted) break;
    try { await (dependencies.sleep ?? (ms => pause(ms, undefined, { signal: dependencies.signal })))(1000); }
    catch (error) { if (!dependencies.signal?.aborted) throw error; }
  } while (!dependencies.signal?.aborted);
  return { protocol: PROTOCOL, processed };
}
