# serve as an installed service

`sharednet serve --install` hands the wake service to the system's own service manager: launchd on macOS, systemd --user on Linux. The manager starts it at login, starts it again whenever it ends, and gives it an environment that was written down once, at install, from an allowlist.

Status: implemented in `packages/cli/src/serve-service.ts`, with the `serve` and `join` changes in `guest.ts`.

## Why

Without this, `serve` is a detached child that `join` leaves behind (`startWakeService` in `wake-driver.ts`). Three things go wrong with that, all seen on one Mac on 2026-10-12/13:

- **Nothing brings it back.** A reboot or a logout ends it. Seats then stop being woken, and nothing says so.
- **It has only the environment it started from.** Started from a Claude desktop session, it had `HTTPS_PROXY`, and that proxy was the only way to reach the model API from that network. The direct route got 403 and the proxy got 200. Restarted from a bare terminal, it had no proxy, so every `claude -p --resume` turn it ran failed.
- **It loses identity variables.** `claude auth status` looks up its keychain item by `USER`. In an environment without `USER` or `LOGNAME`, a signed-in Claude reports that it is signed out.

## Commands

| Command | Does |
| --- | --- |
| `sharednet serve --install` | Writes SharedNet's own service definition for this storage root and has the manager load and start it. On stderr it prints the storage root, the label and file it wrote, the program, and every variable it wrote with its value. With `--json`, stdout carries the same report. Before writing anything, it refuses in two cases: SharedNet's own service for this root is already installed or loaded (`service_installed`; uninstall first to reinstall), or this root's serve lock is held by a live listener, whoever started it (`serve_running`). |
| `sharednet serve --uninstall` | Stops the service and removes its definition. It does not touch a `serve` you started by hand. |
| `sharednet serve --status` | Shows the connector, as before. When a service exists, it adds `service: { installed, loaded, running, pid, label, file, program }`. |
| `sharednet serve --stop` | Stops the listener that holds this root's serve lock, only after checking that the pid is still that listener (see "The serve lock"). When it was the installed service, the manager starts it again within 30 s. That is how the service restarts onto the newest CLI. To stop it for good, use `--uninstall`. |
| `sharednet serve --service` | What the service runs. It is an ordinary `serve` except that it does not end when there is nothing to do yet (see below). |

These are options of `serve`, like `--status` and `--stop`, and not a new verb. `--install` and `--uninstall` take no other `serve` option: the service always serves every seat joined from a Codex or Claude Code session, the same seats a plain `serve` drives. There is no handoff flag. A listener already holding the lock is stopped first (`sharednet serve --stop`, or by retiring whatever supervises it), and then the service is installed.

Install from the environment the service should have. On a machine that reaches the model API only through a proxy, that means a shell where the proxy is set:

```sh
HTTPS_PROXY=http://127.0.0.1:10080 HTTP_PROXY=http://127.0.0.1:10080 npx -y sharednet@latest serve --install
```

## What is written

| | macOS | Linux |
| --- | --- | --- |
| File | `~/Library/LaunchAgents/ai.sharednet.serve.plist` in the account's home (mode 0600) | `sharednet-serve.service` in the user manager's own unit directory, normally `~/.config/systemd/user/` (see below) |
| Loaded with | `launchctl bootstrap gui/$UID <file>` (after a `bootout` of any earlier one) | `systemctl --user daemon-reload`, `enable`, `restart` |
| Removed with | `launchctl bootout gui/$UID/ai.sharednet.serve` | `systemctl --user disable --now` |
| Starts | at login (`RunAtLoad`) | at login (`WantedBy=default.target`); kept across logouts and started at boot only with lingering (see below) |
| Restarts | always (`KeepAlive`), at most once per 30 s (`ThrottleInterval`) | `Restart=always`, `RestartSec=30` |
| Log | serve's own log, `$XDG_STATE_HOME/sharednet/serve.log` (default `~/.local/state/sharednet/serve.log`), appended | the same, via `StandardOutput=append:` |
| Files it creates | owner-only (`Umask` 077) | owner-only (`UMask=0077`) |

The service is named for the storage root it serves, resolved the way the CLI resolves it from `HOME` and `XDG_CONFIG_HOME`. Only the account home's standard root, `~/.config/sharednet`, gets the plain name `ai.sharednet.serve` / `sharednet-serve.service`. Every other resolved root, whether reached through another `XDG_CONFIG_HOME` or another `HOME`, gets `ai.sharednet.serve.<8 hex>` / `sharednet-serve-<8 hex>.service`. So two roots never share a name or a file, and one root spelled two ways gets the same name. A relative `HOME` or `XDG_CONFIG_HOME` is refused, because its root would depend on a working directory. The root's `serve.json` is the lock, so each root is its own slot.

Windows, and any system other than macOS or Linux, gets a clear refusal (`service_unsupported`).

### Linux: where the unit goes, how it is written, and lingering

- **Where.** systemd.unit(5) puts user units in `$XDG_CONFIG_HOME/systemd/user` (and `$XDG_DATA_HOME/systemd/user`), but those are the variables of the user manager (`user@.service`), not of the shell running the install. A CLI run with its own `XDG_CONFIG_HOME` would otherwise write a unit that nothing loads. So install asks the manager for its search path (`systemctl --user show --property=UnitPath --value`) and writes to the first persistent directory under the account's home: `~/.config/systemd/user` when that is listed, as it is by default. It never writes to `.control` (owned by `systemctl set-property`), `transient`, generator or `/run` directories. When the manager cannot be asked, it falls back to `~/.config/systemd/user`.
- **How.** systemd parses each directive its own way, so each has its own formatter:
  - `ExecStart=`: each word double-quoted with C escapes, `%` written `%%` (specifiers) and `$` written `$$`, because ExecStart= is the only directive here that expands `$VAR` (systemd.service, "Command lines").
  - `Environment=`: one quoted `NAME=value` with C escapes and `%%`. `$` is left alone: systemd.exec says Environment= does no variable expansion, so `$$` would reach PATH or a proxy URL literally.
  - `WorkingDirectory=` and `StandardOutput=append:`/`StandardError=append:` are path settings. They are never quoted (`WorkingDirectory="/tmp"` is "not absolute", a fatal error that stops the unit loading) and only `%` is escaped. A relative path is refused.
  - A value with a line break cannot be written in any of them. A captured variable with one is left out with a note, and a path with one refuses the install.
- **Lingering.** Without it, logind stops a user's manager, and this service with it, when the user's last session ends (an SSH disconnect included), and starts it only at the next login. Install reads `loginctl show-user <user> --property=Linger`. When it is not `yes`, install prints the command for an administrator, `sudo loginctl enable-linger <user>`. The CLI never runs sudo.

### The environment

Only these variables are ever written, and only when they are set:

- **Who and where:** `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`.
- **Reaching an API:** `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` (each in both cases), `NODE_USE_ENV_PROXY`, `NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`.
- **SharedNet and the harnesses:** `SHAREDNET_BASE_URL`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`.
- **Storage:** `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`.

Several rules apply on top of the list:

- **No harness session variables.** The environment first passes through `harnessFreeEnv`, the same filter a wake delivery uses (`HARNESS_SESSION_KEYS` and the host's `CLAUDE_CODE_*`). Nothing from the installing session (`CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, `CLAUDE_PID`, …) can be written.
- **No secrets.** Tokens and keys are not on the list: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SHAREDNET_API_KEY`, invite tokens. Neither are a desktop app's local `ANTHROPIC_BASE_URL` or `SHAREDNET_SEAT`. A value from the list that carries a user name or password (`http://user:pass@proxy`) is skipped too, with a note saying so. A harness signed in only through an environment token must therefore be signed in the ordinary way (the keychain, `~/.codex`) before the service can resume it.
- **PATH is cleaned.** Entries that belong to the installing process are dropped: npx's cache (`…/_npx/…`), an npm script's `node_modules/.bin`, npm's `node-gyp-bin`, and relative entries. Each dropped entry is printed.
- **Identity is filled in.** A missing `HOME`, `USER` or `LOGNAME` comes from the OS account.
- **A missing proxy is flagged.** When no proxy variable is set, the install says so, because that is the failure this change exists for.

Everything written is printed with its value. Since nothing secret can pass these rules, that is safe to show.

### The program, and how it survives upgrades

`npx -y sharednet@latest` runs the CLI from npx's cache (`~/.npm/_npx/<hash>/node_modules/sharednet`), which an upgrade replaces. A service that pointed into the cache would start nothing after the next upgrade. So the program depends on how the CLI that installs it is running:

- **From npx:** `<absolute npx on PATH> -y sharednet@latest serve --service`.
  - Each start (login, a crash, a `serve --stop`) takes the newest published CLI. A service never stays on a version that `join` calls outdated (`wake_protocol`).
  - The cost: every start needs the npm registry, and runs whatever `latest` is at that moment, which is the same trust the invitations' `npx -y sharednet@latest` already asks for.
  - When the registry cannot be reached, npx fails and the manager retries every 30 s.
  - With no `npx` on PATH, the install refuses rather than write a definition that will rot.
- **From any other install** (`npm install -g sharednet`, a checkout): `<node on PATH> <the entry file> serve --service`.
  - The entry file stays where it is until that install changes, so this is how to pin a version: install it globally at that version and run `serve --install` from it.
  - It uses the `node` found on PATH, not this process's own path. Under Homebrew, `process.execPath` is the versioned Cellar path, which an upgrade removes.

`npx` and `node` are both found on the captured PATH, so the PATH written is the PATH they are looked up on.

## Never two serves

There is one connector slot per storage root, its `serve.json`. The install-time contract was agreed in Cloud Dev (Room #134–#144), and it is deliberately narrow:

- **SharedNet's own service, exactly.** Install checks only its own label and file for the resolved storage root: whether the file exists, and whether launchd or systemd holds that exact label. If either is true, install refuses (`service_installed`) and names the root, the label, the file and any running pid. Its own label is never excluded from that check.
- **This root's serve lock, whoever holds it.** If a live listener holds the lock (checked as described under "The serve lock" below), install refuses (`serve_running`) and names the root and the pid. No flag bypasses it. If the holder is gone, or its pid now belongs to another process, the lock is stale and does not block.
- **Nothing else.** SharedNet does not interpret launchd or systemd definitions it did not write: other labels, timers, drop-ins, overrides, other search directories. Install says so in its report, and asks the operator to retire any supervisor they run themselves.

The guarantee itself is at runtime. A second `serve` for a root whose lock is held by a live listener exits with `serve_running`, naming the root and the pid. A supervisor nobody told SharedNet about therefore cannot start a second listener beside the service. Its serve exits, and the service, if it is the one waiting, waits for the lock instead of running beside the other.

### The serve lock

The lock is `serve.json`, created with an exclusive-create flag, so two starters cannot both win. Its pid is trusted only after checking that the pid is still the listener that wrote it (`process-identity.ts`, Room #137–#142):

- **Recording.** At lock time, the listener records its own start identity, read from the same OS source a later check reads:
  - Linux: field 22 of `/proc/self/stat`, taken after the last `)` because the command name in field 2 may contain spaces and `)`;
  - macOS: `ps -o lstart= -p <pid>`.
- **Checking.** A holder is live only if signal 0 finds its pid alive, and its start identity read the same way is exactly the recorded string. `EPERM` (someone else's process) counts as alive. A pid that is gone, or that now belongs to another process after a crash or reboot, is a stale lock: `serve` and `--install` take it over.
- **Old status files.** A status file written before identities were recorded has none. Its pid counts as live only if that process's full argv (`/proc/<pid>/cmdline`, or `ps -o args=`) names `sharednet` and has a `serve` argument.
- **Stopping.** `serve --stop` signals only a holder that passes this check. Otherwise it reports why and signals nothing, so a stale `serve.json` can never make it kill an unrelated process.

The runtime behaviour around the lock:

- **No seats yet.** A plain `serve` ends with `not_in_a_room`. The service holds the slot and checks every 5 s for a seat joined from a Codex or Claude Code session.
- **Every seat stopped** (credentials revoked, say). A plain `serve` ends. The service keeps running, instead of being restarted every 30 s by its manager into the same stopped seats.
- **A stopped seat comes back without a restart.** Each seat's loop is begun with a fingerprint of its seat file (base URL, token, join time, Room type, wake) and, for an account seat, its session's token. A seat whose loop ended (refused for good, wake off, its Room gone) is left alone while that fingerprint is unchanged, so a refusal is not retried every 5 s. The next look (every 5 s) sits in it again once the fingerprint changes: after a rejoin, a new account token, or `wake set`. This also applies to a plain `serve` that still has other live seats. Before this change, such a seat stayed stopped until serve restarted. That was already true on the base whenever another seat kept serve running, and the service would have made it permanent.
- **`join` with a service installed.**
  - If the connector is running, nothing changes.
  - If it is not running, `join` asks the manager to start it: `launchctl bootstrap` when launchd does not have it loaded, `launchctl kickstart` (never `-k`) when it is loaded but not running, `systemctl --user start` on Linux. It never spawns a detached `serve` beside an installed service.
  - The service is started by launchd or systemd, not by the joining session, so it does not inherit that session or its sandbox. A join from a Codex sandbox can still start it.
  - If the start fails, the join says so and names `serve --install`.

A wake delivery from the service still runs through `deliveryEnv`, so the turn gets the service's environment minus harness markers, plus `SHAREDNET_SEAT`.

## Testing

- **Unit, `serve-service.test.ts`:**
  - environment capture: allowlist, harness and secret variables, PATH cleaning, credentialed proxies, filled-in identity;
  - program choice: npx, global install or checkout, no npx;
  - definitions: plist keys and escaping; each systemd directive by its own rules (ExecStart, Environment, path settings), line breaks refused; read-back of the program;
  - naming: by storage root; the plist in the account's home; the systemd unit in the manager's own `UnitPath` directory (Ubuntu 24.04's real list included);
  - install, uninstall, state and start against a recording host: launchd and systemd command lines, refusal when SharedNet's own service for the root is installed or loaded (and not for another root), lingering read and reported (never sudo), the warning about supervisors the operator runs.
- **systemd's own parser.** Where `systemd-analyze` exists, `serve-service.test.ts` writes a generated unit with spaces, `%`, `$`, quotes and backslashes in every directive and runs `systemd-analyze --user verify` on it, falling back to the system-mode parser when no user manager can start. It also runs a negative control: the quoted `WorkingDirectory=` the first version wrote must fail. CI runs these on Ubuntu as their own step, with systemd-analyze required (`SHAREDNET_REQUIRE_SYSTEMD_ANALYZE=1`, and whenever `CI` is set on Linux), so a missing parser fails rather than skips.
- **The serve lock, `process-identity.test.ts` and `guest.test.ts`:**
  - EPERM is alive, ESRCH is gone;
  - `/proc/<pid>/stat` is parsed after the last `)`;
  - a real process's identity reads the same twice;
  - the old-status argv rule;
  - a live holder refuses a second `serve`, naming the root;
  - a dead pid, and a reused pid with a different identity, are taken over;
  - EPERM counts as alive;
  - an old status file whose live argv is a sharednet serve counts as alive, and one whose argv is not, does not;
  - `--stop` signals nothing when the identity does not match (the process this test started lives on), and stops a verified holder;
  - a second, real `serve` process on the same root exits non-zero naming the locked root while the first holds it.
- **CLI, `guest.test.ts`:**
  - `join` starts the installed service rather than a detached `serve`, including from a sandbox and when the start fails;
  - `--install`, `--uninstall` and `--status` go through the service control; install refuses while this root's lock has a live holder (no bypass) and goes ahead past a stale one;
  - `--service` waits for a held slot and for seats, and outlives stopped seats;
  - `--stop` explains the restart.
- **No test runs `launchctl` or `systemctl`.** A real launchd round trip is recorded in the pull request. It used a test-only label, a disposable HOME and XDG root, and a harmless program, which was then booted out and deleted.

## Not in this change

- **`wake check`, and a seat stuck in `stopped`.** Each is a separate change.
- **A service per seat, or per Room.** One serve per storage root stays the model.
- **Windows.** Task Scheduler could do this, but it is not attempted.
- **Starting before login on macOS.** That would need a LaunchDaemon, which runs outside the user's keychain session. Claude Code's credentials live in that keychain.
- **A live systemd service.** The generated unit passes systemd 255's parser (`systemd-analyze --user verify`), but no Linux machine has loaded and run it.

## Port

The service repository (`systemind-team/SharedNet`) keeps a byte-identical copy of `packages/cli`. This change needs a mirror port there after review.
