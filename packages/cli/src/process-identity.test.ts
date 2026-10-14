// @vitest-environment node

import { describe, expect, it } from "vitest";

import { looksLikeServe, processAlive, statStartTime, systemProcessProbe } from "./process-identity.ts";

const failing = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

describe("is the process that wrote the lock still there", () => {
  it("counts EPERM from signal 0 as alive (someone else's process), and only ESRCH or a bad pid as gone", () => {
    expect(processAlive(4242, () => true)).toBe(true);
    expect(processAlive(4242, failing("EPERM"))).toBe(true);
    expect(processAlive(4242, failing("ESRCH"))).toBe(false);
    expect(processAlive(0, () => true)).toBe(false);
    expect(processAlive(-1, () => true)).toBe(false);
    // For real: this process, and pid 1, which a non-root test cannot signal (EPERM) but which is alive.
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(1)).toBe(true);
    expect(processAlive(2 ** 22 + 17)).toBe(false);
  });

  it("reads /proc/<pid>/stat field 22 after the last ')', whatever the command name holds", () => {
    // Fields 3..52 after the name; field 22 (start time) is the 20th of them.
    const rest = Array.from({ length: 50 }, (_, index) => (index === 19 ? "98765" : String(index + 3)));
    expect(statStartTime(`1234 (sharednet) S ${rest.slice(1).join(" ")}`)).toBe("98765");
    // A name with spaces and ") " in it would shift a naive split by spaces, or a split at the first ") ".
    expect(statStartTime(`1234 (my) odd (name) ${rest.join(" ")}`)).toBe("98765");
    expect(statStartTime("garbage")).toBeNull();
  });

  it("reads a live process's start identity the same way twice, and none for a pid that is gone", () => {
    const first = systemProcessProbe.identity(process.pid);
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe("");
    expect(systemProcessProbe.identity(process.pid)).toBe(first);
    expect(systemProcessProbe.identity(2 ** 22 + 17)).toBeNull();
    expect(systemProcessProbe.argv(process.pid)).toContain(process.execPath.split("/").pop());
    expect(systemProcessProbe.argv(2 ** 22 + 17)).toBeNull();
  });

  it("accepts an old status file's holder only when its argv names sharednet and a serve argument", () => {
    expect(looksLikeServe("/opt/homebrew/bin/node /Users/a/.npm/_npx/0a1b/node_modules/.bin/sharednet serve")).toBe(true);
    expect(looksLikeServe("node /srv/runtime/package/bin/sharednet.js serve --rooms all")).toBe(true);
    expect(looksLikeServe("node /work/serve-service/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(looksLikeServe("node /srv/sharednet/bin/sharednet.js wait")).toBe(false);
    expect(looksLikeServe("python3 /home/a/serve.py")).toBe(false);
    expect(looksLikeServe(null)).toBe(false);
  });
});
