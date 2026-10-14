import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Whether the process that wrote a serve lock is the one alive under its pid now. A pid alone is
 * not an identity: after a crash or a reboot the recorded number can belong to any process, and
 * `serve --stop` must never signal one that is not the listener. So the lock records the holder's
 * start identity, read from the OS source the later check reads too, and the two are compared as
 * exact strings (Room #137–#142):
 *
 * - Linux: field 22 of /proc/<pid>/stat (start time in clock ticks since boot), taken after the
 *   last `)` because the command name in field 2 may itself contain spaces and `)`.
 * - macOS and other systems: `ps -o lstart= -p <pid>`.
 *
 * A status file written before this existed has no identity; its pid counts only if that process's
 * full argv names both sharednet and serve.
 */
export interface ProcessProbe {
  /** Whether a process with this pid exists: signal 0, where EPERM (someone else's process) is alive. */
  alive(pid: number): boolean;
  /** Its start identity, or null when it cannot be read (gone, or no such source here). */
  identity(pid: number): string | null;
  /** Its full argv as one string, or null when it cannot be read. */
  argv(pid: number): string | null;
}

/** Signal 0 probes without signalling; EPERM means the process exists but belongs to someone else. */
export function processAlive(pid: number, kill: (pid: number, signal: 0) => unknown = (target, signal) => process.kill(target, signal)): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Field 22 of a /proc/<pid>/stat line: field 20 of what follows the last `)`. */
export function statStartTime(line: string): string | null {
  const close = line.lastIndexOf(")");
  if (close < 0) return null;
  return line.slice(close + 2).split(" ")[19] ?? null;
}

function ps(field: string, pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export const systemProcessProbe: ProcessProbe = {
  alive: (pid) => processAlive(pid),
  identity: (pid) => {
    if (process.platform === "linux") {
      try {
        return statStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return null;
      }
    }
    return ps("lstart", pid);
  },
  argv: (pid) => {
    if (process.platform === "linux") {
      try {
        const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        return raw === "" ? null : raw.replace(/\0+$/, "").split("\0").join(" ");
      } catch {
        return null;
      }
    }
    return ps("args", pid);
  },
};

/** An old status file's holder counts only if it is visibly a sharednet serve. */
export function looksLikeServe(argv: string | null): boolean {
  return argv !== null && /sharednet/i.test(argv) && /(^|\s)serve(\s|$)/.test(argv);
}
