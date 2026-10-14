#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";
import { realServiceHost, ServiceControl } from "./serve-service.ts";
import { startWakeService } from "./wake-driver.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Only a real process can leave a wake service behind it; the entry is this file, as run now.
  const entry = process.argv[1] ? resolve(process.argv[1]) : null;
  const program = entry ? { entry, execPath: process.execPath, execArgv: process.execArgv } : null;
  return runCli(argv, {
    ...(program ? { startWakeService: (input) => startWakeService({ ...input, ...program }) } : {}),
    // The launchd agent a person installs with `serve --install`.
    wakeService: (env) => new ServiceControl(env, realServiceHost(), program),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = await main();
}
