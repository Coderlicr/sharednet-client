import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { localError } from "./errors.ts";
import { getStoragePaths } from "./storage.ts";
import { mentions } from "./triggers.ts";

export interface BoardMessage {
  sequence: number;
  content: string;
  sender?: { member_id: string; name?: string | null };
  mentions?: string[];
}
export interface Task {
  key: string;
  title: string;
  owner: string;
  status: "claimed" | "done";
  claim_sequence: number;
  done_sequence?: number;
  owner_name?: string | null;
}
export interface TaskBoard {
  /** Complete, ascending board history; implementations must paginate. */
  list(): Promise<BoardMessage[]>;
  post(content: string): Promise<BoardMessage>;
}
const MARKER = "[sharednet-task:v1] ";
function titleKey(title: string): string {
  const key = title.toLowerCase().replace(/\s/gu, "");
  if (!key) throw localError("invalid_task_title", "A task needs a nonempty title.");
  return key;
}
export function isTaskMessage(content: string): boolean {
  return content.startsWith(MARKER);
}
export function taskMessage(op: "claim" | "done", title: string): string {
  titleKey(title);
  return MARKER + JSON.stringify({ op, title: title.trim() });
}
export function projectTasks(messages: BoardMessage[]): Task[] {
  const tasks = new Map<string, Task>();
  for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
    if (!message.content.startsWith(MARKER) || !message.sender?.member_id) continue;
    try {
      const act = JSON.parse(message.content.slice(MARKER.length));
      if (typeof act.title !== "string" || !["claim", "done"].includes(act.op)) continue;
      const key = titleKey(act.title), task = tasks.get(key);
      if (act.op === "claim" && !task) tasks.set(key, { key, title: act.title.trim(), owner: message.sender.member_id, owner_name: message.sender.name ?? null, status: "claimed", claim_sequence: message.sequence });
      else if (act.op === "done" && task?.owner === message.sender.member_id && task.status === "claimed") {
        task.status = "done"; task.done_sequence = message.sequence;
      }
    } catch { /* Ordinary text or a malformed marker does not change tasks. */ }
  }
  return [...tasks.values()];
}
/** The latest task act by someone else: what a claimant must have looked at before claiming. */
export function latestForeignTaskSequence(messages: BoardMessage[], me: string): number {
  return Math.max(0, ...messages.filter(m => isTaskMessage(m.content) && m.sender?.member_id && m.sender.member_id !== me).map(m => m.sequence));
}
/** The n tasks touched most recently, claimed or done, newest first. */
export function recentTasks(tasks: Task[], n: number): Task[] {
  return [...tasks].sort((a, b) => (b.done_sequence ?? b.claim_sequence) - (a.done_sequence ?? a.claim_sequence)).slice(0, Math.max(0, n));
}
export async function claimTask(board: TaskBoard, who: string, title: string): Promise<Task> {
  const key = titleKey(title);
  if (projectTasks(await board.list()).some(t => t.key === key)) throw localError("task_taken", `Task ${JSON.stringify(title)} already exists. Choose a different task.`);
  const posted = await board.post(taskMessage("claim", title));
  const messages = await board.list();
  if (!messages.some(m => m.sequence === posted.sequence && m.sender?.member_id === who && m.content === posted.content)) {
    throw localError("task_state_incomplete", "Task replay is incomplete; ownership has not been granted. Run sharednet task list before doing work.");
  }
  const task = projectTasks(messages).find(t => t.key === key);
  if (task?.owner !== who || task.claim_sequence !== posted.sequence) throw localError("task_taken", `You did not win task ${JSON.stringify(title)}; an earlier claim owns it.`);
  return task;
}
export function pendingMentions(messages: BoardMessage[], me: { memberId: string; name: string | null }, through: number, readThrough: number): BoardMessage[] {
  const seen = Math.max(through, readThrough);
  return messages.filter(m => m.sequence > seen && m.sender?.member_id !== me.memberId &&
    (m.mentions?.includes(me.memberId) || mentions(m.content, me) || mentions(m.content, { memberId: "", name: "all" })));
}

type Environment = Record<string, string | undefined>;
export function controlPaths(env: Environment, seat: { base_url: string; room_id: string; member_id: string }) {
  const scope = createHash("sha256").update(JSON.stringify([seat.base_url, seat.room_id, seat.member_id])).digest("hex");
  const root = join(getStoragePaths(env).stateDir, "board-controls", scope);
  return { root, read: join(root, "read-through"), tasks: join(root, "held-tasks"), events: join(root, "events.ndjson"), taskSeen: join(root, "tasks-seen-through") };
}
export type ControlPaths = ReturnType<typeof controlPaths>;
export async function readThrough(paths: ControlPaths): Promise<number> {
  return readMark(paths.read);
}
/** A nonnegative sequence kept in one file; a missing file is 0. */
export async function readMark(path: string): Promise<number> {
  try {
    const value = Number(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(value) || value < 0) throw Error("invalid watermark");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw localError("invalid_read_watermark", "A local watermark is invalid; nothing was posted.");
  }
}
async function atomic(path: string, data: string) {
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}
async function ownerRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  // A container without an init/reaper can retain dead children as zombies.
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3))) return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; }
  }
  return true;
}
/** A populated directory is published atomically; removing only an owner's unique file
 * makes concurrent dead-owner recovery safe. Each agent's state lives in its PID namespace. */
export async function withControlLock<T>(paths: Pick<ControlPaths, "root">, kind: "read" | "task" | "handed", work: () => Promise<T>): Promise<T> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const lock = join(paths.root, `${kind}-lock`), deadline = Date.now() + 30_000;
  const candidate = await mkdtemp(join(paths.root, `${kind}-candidate-`));
  const owner = `${process.pid}-${randomUUID()}`;
  await writeFile(join(candidate, owner), "", { mode: 0o600 });
  let acquired = false;
  const empty = async () => {
    try { await rmdir(lock); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  };
  try {
    while (!acquired) {
      try { await rename(candidate, lock); acquired = true; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const owners = await readdir(lock).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        for (const entry of owners) {
          if (!/^\d+-[a-f0-9-]+$/.test(entry)) continue;
          if (!await ownerRunning(Number(entry.split("-")[0]))) await unlink(join(lock, entry)).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
        await empty();
        if (Date.now() >= deadline) throw localError("local_state_busy", `Another ${kind} operation is still running. Retry after it completes.`);
        await pause(10);
      }
    }
    return await work();
  } finally {
    if (acquired) {
      await unlink(join(lock, owner));
      await empty();
    } else await rm(candidate, { recursive: true, force: true });
  }
}
export async function noteRead(paths: ControlPaths, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return;
  await withControlLock(paths, "read", async () => atomic(paths.read, String(Math.max(sequence, await readThrough(paths)))));
}
export async function noteTasksSeen(paths: ControlPaths, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await atomic(paths.taskSeen, String(Math.max(sequence, await readMark(paths.taskSeen))));
}
export async function noteTasks(paths: ControlPaths, tasks: Task[], who: string): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await atomic(paths.tasks, tasks.filter(t => t.owner === who && t.status === "claimed").map(t => JSON.stringify(t.title) + "\n").join(""));
}
export async function controlEvent(paths: ControlPaths, event: Record<string, unknown>): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await appendFile(paths.events, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
}
