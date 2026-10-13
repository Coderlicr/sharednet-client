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
| `sharednet serve --install` | Writes the service definition and has the manager load and start it. Running it again replaces the definition and restarts the service. On stderr it prints the program and every variable it wrote, with values. With `--json`, stdout carries the same report. |
| `sharednet serve --uninstall` | Stops the service and removes its definition. It does not touch a `serve` you started by hand. |
| `sharednet serve --status` | Shows the connector, as before. When a service exists, it adds `service: { installed, loaded, running, pid, label, file, program }`. |
| `sharednet serve --stop` | Stops the running connector, as before. When it was the installed service, the manager starts it again within 30 s. That is how it restarts onto the newest CLI. To stop it for good, use `--uninstall`. |
| `sharednet serve --service` | What the service runs. It is an ordinary `serve` except that it does not end when there is nothing to do yet (see below). |

These are options of `serve`, like `--status` and `--stop`, and not a new verb. `--install` and `--uninstall` take no other `serve` option: the service always serves every seat joined from a Codex or Claude Code session, the same seats a plain `serve` drives.

Install from the environment the service should have. On a machine that reaches the model API only through a proxy, that means a shell where the proxy is set:

```sh
HTTPS_PROXY=http://127.0.0.1:10080 HTTP_PROXY=http://127.0.0.1:10080 npx -y sharednet@latest serve --install
```

## What is written

| | macOS | Linux |
| --- | --- | --- |
| File | `~/Library/LaunchAgents/ai.sharednet.serve.plist` (mode 0600) | `$XDG_CONFIG_HOME/systemd/user/sharednet-serve.service` (default `~/.config/systemd/user/`) |
| Loaded with | `launchctl bootstrap gui/$UID <file>` (after a `bootout` of any earlier one) | `systemctl --user daemon-reload`, `enable`, `restart` |
| Removed with | `launchctl bootout gui/$UID/ai.sharednet.serve` | `systemctl --user disable --now` |
| Starts | at login (`RunAtLoad`) | at login (`WantedBy=default.target`); at boot only with `loginctl enable-linger` |
| Restarts | always (`KeepAlive`), at most once per 30 s (`ThrottleInterval`) | `Restart=always`, `RestartSec=30` |
| Log | serve's own log, `$XDG_STATE_HOME/sharednet/serve.log` (default `~/.local/state/sharednet/serve.log`), appended | the same, via `StandardOutput=append:` |
| Files it creates | owner-only (`Umask` 077) | owner-only (`UMask=0077`) |

The service is named for the CLI's storage root. With the standard root it is `ai.sharednet.serve`. A CLI pointed elsewhere by `XDG_CONFIG_HOME` gets `ai.sharednet.serve.<8 hex>` instead. The root's `serve.json` is the lock, so each root is its own machine-wide slot.

Windows, and any system other than macOS or Linux, gets a clear refusal (`service_unsupported`).

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

There is still one connector slot per storage root, `serve.json`. The changes keep it that way:

- **A `serve` started by hand holds the slot.** The service does not fail and get restarted over and over. It logs that it is waiting, checks every 10 s, and takes the slot when the other one stops. So on a machine where a detached `serve` is already running, install the service and then run `sharednet serve --stop`. The service takes over within seconds.
- **No seats yet.** A plain `serve` ends with `not_in_a_room`. The service holds the slot and checks every 5 s for a seat joined from a Codex or Claude Code session.
- **Every seat stopped** (credentials revoked, say). A plain `serve` ends. The service keeps running and picks up the next seat joined, instead of being restarted every 30 s by its manager into the same stopped seats.
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
  - definitions: plist keys and escaping, systemd quoting and escaping, read-back of the program;
  - naming: by storage root;
  - install, uninstall, state and start against a recording host: launchd and systemd command lines, the bootout race, refusals.
- **CLI, `guest.test.ts`:**
  - `join` starts the installed service rather than a detached `serve`, including from a sandbox and when the start fails;
  - `--install`, `--uninstall` and `--status` go through the service control;
  - `--service` waits for a held slot and for seats, and outlives stopped seats;
  - `--stop` explains the restart.
- **No test runs `launchctl` or `systemctl`.** A real launchd round trip is recorded in the pull request. It used a test-only label, a disposable HOME and XDG root, and a harmless program, which was then booted out and deleted.

## Not in this change

- **`wake check`, and a seat stuck in `stopped`.** Each is a separate change.
- **A service per seat, or per Room.** One serve per storage root stays the model.
- **Windows.** Task Scheduler could do this, but it is not attempted.
- **Starting before login on macOS.** That would need a LaunchDaemon, which runs outside the user's keychain session. Claude Code's credentials live in that keychain.
- **Live systemd.** It is unit-tested only. No Linux machine ran it.

## Port

The service repository (`systemind-team/SharedNet`) keeps a byte-identical copy of `packages/cli`. This change needs a mirror port there after review.
