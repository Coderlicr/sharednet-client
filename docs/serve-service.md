# serve as an installed launchd service

`sharednet serve --install` hands the wake service to launchd on macOS. launchd then starts it at login and starts it again whenever it ends, with an environment written down once, at install time, from an allowlist.

Linux (systemd --user) is planned as a separate change. On Linux and Windows, `--install` and `--uninstall` refuse with a clear message (`service_unsupported`), before any other check, the sandbox check included.

The code is in `packages/cli/src/serve-service.ts`. The `serve` and `join` changes are in `guest.ts`.

## Why

Without this, `serve` is a detached child that `join` leaves behind. A reboot or a logout ends it, and nothing brings it back. It also has only the environment it was started from. On a machine where the model API is reachable only through a proxy, a serve restarted from a shell without that proxy runs turns that fail. An environment without `USER` makes a signed-in `claude` report that it is signed out.

## Commands

| Command | Does |
| --- | --- |
| `sharednet serve --install` | Writes SharedNet's own LaunchAgent for this storage root and bootstraps it. On stderr it prints the storage root, label, file, program, and every variable it wrote with its value. |
| `sharednet serve --uninstall` | Stops the service and removes its plist. It reports success only once both are verified. |
| `sharednet serve --status` | As before. When a service exists, it adds `service`. |
| `sharednet serve --stop` | As before. When the stopped listener was the installed service, launchd starts it again within 30 s; that is how the service restarts onto the newest CLI. To stop it for good, use `--uninstall`. |
| `sharednet serve --service` | What the service runs. It is an ordinary `serve`, except that it waits instead of ending: for another holder's lock, for its first seat, and after its seats stop. |

`--install` and `--uninstall` take no other `serve` option, and `--install` refuses inside a sandbox. Install from a shell with the environment the service should have, for example:

```sh
HTTPS_PROXY=http://127.0.0.1:10080 HTTP_PROXY=http://127.0.0.1:10080 npx -y sharednet@latest serve --install
```

## The install-time contract

`--install` checks only two things, in this order:

1. **SharedNet's own service for this root, by exact label and plist path.** Install refuses with `service_installed` if the plist exists, or if launchd holds the label. Holding includes the case where `launchctl print` fails in a way that is not launchd's "no such service". An unreadable plist also refuses. The message names the root, label and file, and gives the way on: `sharednet serve --uninstall`, then install again. This check runs before the lock check, because an installed service holds the lock itself and launchd would undo a `--stop`.
2. **This root's serve lock.** If a live listener holds it, install refuses with `serve_running`, naming the root and pid, whoever started that listener. "Live" uses the verified-holder rules of the serve lock. A stale lock (its pid is gone, or now belongs to another process) does not block.

Nothing else is interpreted. SharedNet does not read launchd or systemd definitions it did not write. The install report says so and asks the operator to retire any supervisor they run themselves (another LaunchAgent, cron, a login script). If they don't, the service waits for the lock instead of running beside that supervisor's serve.

## What is written

- **File:** `~/Library/LaunchAgents/<label>.plist` in the account's home, mode 0600.
- **Label:** `ai.sharednet.serve` for the account home's standard root, `~/.config/sharednet`. Any other resolved root, whether reached through another `XDG_CONFIG_HOME` or another `HOME`, gets `ai.sharednet.serve.<8 hex>`. Two roots never share a label or a file.
- **Keys:**
  - `RunAtLoad` and `KeepAlive`, with `ThrottleInterval` 30;
  - `Umask` 077;
  - stdout and stderr both go to serve's log, `$XDG_STATE_HOME/sharednet/serve.log`;
  - `WorkingDirectory` is the captured `HOME`.
- **Loading:** `launchctl bootstrap gui/<uid> <plist>`.

### One captured environment

The plist's environment is captured once, and the location, label, lock root and log path all come from that same capture.

- **Root-defining variables** (`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`) must be absolute, and must be writable into the plist unchanged (no line break). Otherwise install refuses. This prevents a service that serves a different root from the one it reported.
- **They are always written.** launchd starts an agent with its user domain's environment (`launchctl setenv`) beneath the plist's. So `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are written even when the installing shell has none, with the XDG defaults (`$HOME/.config`, `$HOME/.local/state`), which mean the same to every program that reads them. Nothing in launchd's domain can then move the service to another root.
- **The lock checked is this root's.**

### The environment

Apart from `HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME` (always written, above), these variables are written only when they are set:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`;
- the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, each in both cases), `NODE_USE_ENV_PROXY`, `NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`;
- `SHAREDNET_BASE_URL`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`;
- `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`.

Several rules apply on top of the list:

- **No harness session variables.** The environment first passes through `harnessFreeEnv`, the same filter a wake delivery uses.
- **No credentials of any kind.** Tokens and keys are not on the list. If any persisted address variable (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, each in both cases, or `SHAREDNET_BASE_URL`) contains a literal `@`, `--install` refuses with `install_refused`. The error names the variable and never prints its value, and nothing is written. Use a proxy that needs no credentials, or give the proxy its credentials another way, outside the service definition. The value is not parsed: every userinfo form (`http://user:pass@host`, `//user:pass@host`, `user:pass@host:port`, `DOMAIN\user:pass@host`, percent-encoded) needs a literal `@`. The variable is never silently dropped either, since a service without its proxy would install cleanly and then reach nothing.
- **PATH is cleaned.** Entries that belong only to the installing process are dropped: the npx cache, an npm script's `node_modules/.bin`, and relative entries.
- **Identity is filled in.** A missing `USER` or `LOGNAME` is taken from the account, which `claude auth status` needs.
- **A missing proxy is flagged.** If no proxy variable is set, the install says so.

The allowlist governs what SharedNet writes. Variables someone set in launchd's own user domain with `launchctl setenv` still reach the service from launchd, as they reach every app launched at login; SharedNet does not read or clear them.

### The program, and upgrades

- **Run through npx:** `<absolute npx on PATH> -y sharednet@latest serve --service`.
  - It never points into npx's cache, which an upgrade replaces.
  - Each start takes the newest published CLI.
  - If no `npx` is on PATH, install refuses.
- **Any other install** (global, pinned, a checkout): `<node on PATH> <entry file> serve --service`. The `node` comes from the captured PATH, never from this process's own executable, which may be a versioned path or npx's cache (`npx node@24 …`). If no `node` is on that PATH, install refuses.

## Uninstall

`--uninstall` runs `launchctl bootout`, then `launchctl print`. launchd can return from a successful bootout before the job is gone (seen on this macOS: `print` still answered right after), so while it still answers, `print` is repeated every 250 ms for up to 10 s. Only launchd's own "no such service" answer (exit 113, "Could not find service") proves the job is gone. Any other answer is treated as not gone: still loaded, a timeout, a permission or IPC error, or a launchctl that did not run. In that case the plist is kept and `service_not_uninstalled` names the retry: `sharednet serve --uninstall` again, or `launchctl bootout …` by hand and then remove the file. Once the job is gone, the plist is removed and read back. An unlink or read error also fails with `service_not_uninstalled`.

## join

If a service is installed but not running, `join` starts it: `launchctl bootstrap` if launchd does not have it, `kickstart` (never `-k`) if it does. In that case `join` never spawns a second, detached serve. Without an installed service, `join` behaves as on main.

## Testing

- **`serve-service.test.ts`** covers, with launchctl and the disk scripted and nothing real run:
  - the allowlist and harness variables;
  - the `@` refusal: every address variable against a corpus (`DOMAIN\user:pass@host`, `//user:pass@host`, `user:pass@host:port`, `http://user:pass@…` and more), each refused with nothing written and the secret in no error, raw or JSON-escaped, and values without `@` still installing;
  - PATH cleaning;
  - the program forms;
  - the plist keys and escaping;
  - per-root labels;
  - launchd's answers;
  - install refusals (own plist, label held or unknown, unreadable plist, relative or uncarriable root variables);
  - the root-defining variables always written;
  - start;
  - uninstall verification (still loaded, unknown, unlink and read failures), and the bounded wait for launchd's teardown after a bootout;
  - no `node` on the captured PATH refusing, rather than falling back to this process's executable;
  - Linux and Windows refusals.
- **`guest.test.ts`** covers:
  - the install report;
  - the check order (own service first);
  - the live-lock refusal naming root and pid, with a stale lock not blocking;
  - `join` starting an installed service;
  - `--status` and `--stop` with a service;
  - `serve --service` waiting for a lock and for seats, and outliving stopped seats;
  - the `@` refusal through the CLI, with no output carrying the value;
  - Linux and Windows refusing `--install` and `--uninstall` through the real `ServiceControl`, even while a connector holds the lock and from inside a sandbox.

## Port

The service repository (`systemind-team/SharedNet`) keeps a byte-identical copy of `packages/cli`. This change needs a mirror port there after review.
