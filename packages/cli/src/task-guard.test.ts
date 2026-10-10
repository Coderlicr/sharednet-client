// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TASK_PROFILE, TASK_HOOK } from "./task-guard.ts";

const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sn-task-guard-")); scratch.push(dir);
  const profile = join(dir, "guard.sh"), held = join(dir, "held");
  await writeFile(profile, TASK_PROFILE);
  const run = (command: string, gate = "1") => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", 'BASH_EXECUTION_STRING="$TEST_COMMAND"; source "$TEST_PROFILE"; printf allowed'], {
    encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, SHAREDNET_TASK_GATE: gate, SHAREDNET_TASK_FILE: held, SHAREDNET_TASK_AUDIT: join(dir, "audit"), TEST_COMMAND: command, TEST_PROFILE: profile },
  });
  return { held, run };
}
it("blocks work without a held task, enables it after claim, and blocks it after done", async () => {
  const f = await fixture();
  expect(f.run("python3 build.py").status).toBe(2);
  expect(f.run("python3 build.py").stderr).toContain("claim");
  await writeFile(f.held, '"Build"\n');
  expect(f.run("python3 build.py").stdout).toBe("allowed");
  await writeFile(f.held, "");
  expect(f.run("python3 build.py").status).toBe(2);
  expect(f.run("python3 build.py", "0").status).toBe(0);
});
it("allows standalone sharednet commands with literal quoted punctuation", async () => {
  const { run } = await fixture();
  for (const command of ['sharednet task claim "Fix Parser"', "sharednet say '@A use x; y && z, $HOME and `code`' --json", 'sharednet read --last 30 --json']) {
    expect(run(command).status, command).toBe(0);
  }
});
it("refuses shell work smuggled through a sharednet prefix", async () => {
  const { run } = await fixture();
  for (const command of ['sharednet task list; touch bad', 'sharednet task list && touch bad', 'sharednet say "$(touch bad)"', 'sharednet read > bad', 'sharednet read\ntouch bad', 'sharednetx task claim a']) {
    expect(run(command).status, command).toBe(2);
  }
});

it("Claude's hook also refuses direct file tools without a task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sn-task-hook-")); scratch.push(dir);
  const profile = join(dir, "profile"), held = join(dir, "held");
  await writeFile(profile, TASK_PROFILE);
  const run = (tool_name: string, command = "") => spawnSync(process.execPath, ["-e", TASK_HOOK], {
    encoding: "utf8", input: JSON.stringify({ tool_name, tool_input: { command } }),
    env: { NODE_ENV: "test", PATH: process.env.PATH, SHAREDNET_TASK_GATE: "1", SHAREDNET_TASK_FILE: held, SHAREDNET_TASK_PROFILE: profile },
  });
  expect(JSON.parse(run("Write").stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(run("Bash", 'sharednet task claim "Write parser"').stdout).toBe("");
  expect(JSON.parse(run("Bash", 'sharednet task list; touch bad').stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  await writeFile(held, '"Write parser"\n');
  expect(run("Write").stdout).toBe("");
});
