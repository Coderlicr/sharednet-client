# Wake plugins

When someone writes `@seat` in a Room, `sharednet serve` must wake whatever agent sits in that seat. This document describes how the CLI does that through **wake plugins**: one small module per harness. Each plugin knows how to remember a session at `join` and how to deliver a wake to that session.

Status: implemented in `packages/cli/src/wake-*.ts`. This supersedes the hard-coded Codex/Claude Code branches from #191 and the busy-writer retry in draft #20. It builds on the per-seat health reporting from #18.

## Why

Before this, getting an addressed line to an agent took four separate mechanisms:

| Mechanism | Where | Problem |
| --- | --- | --- |
| `driver: "codex" \| "claude-code"` | `if` branches across `wake-driver.ts` | Adding a harness means editing every branch |
| A seat file's `command` edited by hand (`codex-room-bypass.sh`) | the seat's JSON file | Undocumented, and the CLI cannot set it |
| `serve --run '<adapter>'` (the Mac `codex queue` bridge) | a local script | Serves every seat with one command, and bypasses the drivers |
| The Claude Code open-chat check (#21) | inside serve's loop | Harness logic inside the transport loop |

They also share one hard problem that each solved differently: **the session may be open.** An open session is a chat a person is in right now. Resuming it from outside creates a second writer:
- Codex refuses it (`thread-store conflict: … active writer`).
- Claude Code accepts it, so both processes append to the same transcript, the open chat never sees the extra turn, and the session splits in two.

## The model

A seat's **wake** is a record in its seat file:

```jsonc
{
  "driver": "codex",            // which plugin delivers it
  "session": "019a…",           // the harness's own session id
  "cwd": "/work/project",       // where the session worked when it joined
  "command": "codex",           // the program the plugin calls (a launcher script may stand in)
  "codex_home": "/home/a/.codex",   // plugin-specific fields, each plugin owns its own
  "live_pid": 4321
}
```

A **plugin** answers four questions:

```ts
interface WakePlugin {
  driver: string;     // "codex", "claude-code", "command"
  label: string;      // "Codex", for people
  /** At join: the wake for the session this process runs in, or null if this is not that harness. */
  capture(env, cwd): SeatWake | null;
  /** Reading a seat file: the wake, or undefined if the record is not this plugin's or is damaged. */
  parse(record): SeatWake | undefined;
  /** At join: how the session hears its Room while it is open, if it must do that itself. */
  listen?(wake, memberId): string | null;
  /** In serve: deliver one wake. */
  deliver(wake, wakeInput, context): Promise<Delivery>;
  /** `wake check` and serve start: can a wake be delivered (see "Checking a wake"). Never resumes the session. */
  check(wake, env, run, { call }): Promise<CheckResult>;
}
```

### Deliveries

`deliver` returns one of five outcomes, and **serve alone** decides what each one means for the Room and the seat's place. A plugin never posts and never acknowledges.

| Outcome | Meaning | serve posts | serve acknowledges | then |
| --- | --- | --- | --- | --- |
| `replied` | A turn ran and finished. `reply` is its last words, or null for `(no reply)` | the reply, if any | yes | next wake |
| `handed` | The wake was put into the open session (Codex `queue`), which will answer in the Room itself | nothing | yes, and it is written down as unanswered until the session settles that one hand-over (`sharednet handed settle`) | next wake |
| `left` | The open session listens for itself (Claude Code chat with a background `wait`) | nothing | no. The session acknowledges what it handles, and serve takes that as its place | look again in 10 s |
| `busy` | It could not be delivered now, and nothing was lost | nothing | no | retry in `retryMs` |
| `failed` | It could not be delivered (not signed in, program missing, past the turn limit) | a notice, so whoever addressed the seat knows | yes | next wake |

Every case of "the session is open" becomes `handed` or `left`; neither is an error. The 30-turns-per-hour cap counts only turns that ran (`replied` and `failed`).

## Built-in plugins

### `codex`

- **capture:** `CODEX_SESSION_ID` (the thread id), `CODEX_HOME`, and `codex` on PATH.
- **deliver:**
  1. Run `codex exec resume --json --skip-git-repo-check [sandbox] <thread> -` with the wake prompt on stdin. If it finishes, the outcome is `replied` with its last agent message.
  2. If it fails with *active writer*, the thread is open in a chat. Run `codex queue --thread <thread> --message <live prompt>`, and the outcome is `handed`. The open chat runs the message after its current turn and posts its own answer. The live prompt says so, and gives `sharednet say … --as <seat>`.
  3. If `queue` also fails (an older Codex, or a non-zero exit), the outcome is `busy`, retried in 10 s.
- **Verified on Codex 0.162.0:**
  - `codex queue` stores the message in `~/.codex/queue_1.sqlite` and returns at once. An idle thread does not run it by itself, but the next `exec resume` turn delivers it first ("Other user message received since my last reply: …"). A queued message waits there until the thread takes it, but **once a turn takes it, Codex removes it from the queue**: a session interrupted at that moment (#834, reproduced on 2026-10-13 with Codex 0.162) never runs it again.
  - So serve writes every hand-over to `<rooms>/<room>/<seat>.handed.json` before the cursor moves on. It stays **unanswered** until the session runs `sharednet handed settle <room> <through> --as <seat>` (the queued prompt names it), whether it replied or not. Other words from the seat do not settle it: "still working on it" is not handling it. Adding and settling read and write the file under one lock, and a settle names one Room, seat and through.
  - `sharednet handed --json` lists what is left and only reads, for a person or a monitor to follow up.
  - Not covered: a connector that crashes after writing a hand-over and before moving its cursor queues the same lines again on restart, so a session can see a request twice.
  - **Only an interactive Codex holds the writer lock** (the TUI, or the desktop app through its background server). Two `exec resume` turns on the same thread run side by side without an error. So `handed` happens exactly when a person has the thread open, which is the case it exists for.
  - An open, idle TUI runs a queued wake at once; a busy one runs it after its current turn.

### `claude-code`

- **capture:** `CLAUDE_CODE_SESSION_ID` and `claude` on PATH. In an attended chat (`CLAUDE_CODE_SESSION_ATTENDED=1`) it also records `live_pid` (`CLAUDE_PID`). A headless `claude -p` runs attended `0`, so it never records one.
- **listen:** `sharednet wait --on mention --as <seat> --json`, run by the chat as a background command. Claude Code calls the chat back when the command ends. The chat answers with `sharednet say … --as <seat>` and runs the wait again. Claude Code has no queue, so the open chat pulls its lines itself.
- **deliver:**
  - While `live_pid` runs and is still named `claude` (`ps -o comm=`; a pid can be reused after the chat closes), the outcome is `left`.
  - Otherwise run `claude -p --resume <session> --output-format json`, and the outcome is `replied` or `failed`.

### `command`

This is the extension point: any harness or bot without a built-in plugin (Cursor, OpenHands, Gemini CLI, a team script).

- **set by:** `sharednet wake set command --command <path> [--as <seat>]`. It is never captured by `join`.
- **deliver:** run `<path>` in `cwd`, with the same wake JSON on stdin that `serve --run` hands its command: `{ room_id, member_id, trigger, messages, prompt }`. The environment carries `SHAREDNET_SEAT` and `SHAREDNET_ROOM_ID`.
  - Exit 0: the outcome is `replied`, and stdout is the reply. Empty stdout or `(no reply)` posts nothing.
  - Exit 75 (`EX_TEMPFAIL`): the outcome is `busy`. Use this for "my session is open, try later".
  - Exit 76: the outcome is `handed`. Use this for "I passed it to something that will answer in the Room itself". The Mac `codex queue` bridge would be this exit, if it were not now built in.
  - Any other exit: the outcome is `failed`.

  So an adapter can express everything a built-in plugin can.

The `command` field of a `codex` or `claude-code` wake stays, as before, the program that plugin calls. That is how a launcher script with the owner's chosen permissions (`codex-room-bypass.sh`) stands in for `codex`. `wake set codex --command <script>` now sets it, instead of editing the seat file by hand.

## CLI

| Command | Does |
| --- | --- |
| `sharednet join <invite>` | As before: captures the wake from the first plugin that recognises this process. In an open chat, also prints the listen line. `--no-wake` and `SHAREDNET_WAKE=off` keep a join to the seat |
| `sharednet wake [--as <seat>] [--json]` | Shows the seat's wake: plugin, session, command, live chat |
| `sharednet wake set <driver> [--command <path>] [--resume <session id>] [--as <seat>]` | Sets or changes it. `--resume` defaults to the current process's session when the driver is this harness. (`--session` is already the CLI's global option for choosing an Instance, so it is not reused) |
| `sharednet wake off [--as <seat>]` | Removes it. The seat stays, and serve stops driving it |
| `sharednet wake check [--as <seat>]` | Proves the wake path in this shell's environment: all four steps of "Checking a wake", including one throwaway model call. Prints each step; exits non-zero naming the step that failed. A warning alone does not fail it |
| `sharednet serve --status` | Each seat's driver, as `resumes`, is shown as before; a seat driven despite a doubt carries it in `wake_warnings` |

At start, `serve` checks each driven seat with the steps that cost no model call. Only the `program` step can hold a seat back: the seat is `retrying` (#36), its lines are not read, and it is looked at again with capped backoff. A `signed_in` or `session` problem does not hold it back. It is logged, kept in the seat's `wake_warnings` in `serve --status`, and the seat is driven; a delivery that then fails posts its notice in the Room as before.

## Checking a wake

`--version` alone once passed while every wake would have failed (2026-10-13): `claude --version` answered, but headless `claude -p` said `Not logged in · Please run /login`, because the desktop chat signs in on its own. After signing in, `claude -p` still answered `API Error: 403 Request not allowed` without the machine's HTTPS proxy. So a check now takes these steps, each reported as `ok`, `failed`, `warning` or `skipped` with the program's own words:

| Step | `claude-code` | `codex` | serve start | `wake check` |
| --- | --- | --- | --- | --- |
| `program` | the seat's directory exists; `claude --version` (5 s) | the same with `codex --version` | yes | yes |
| `signed_in` | `claude auth status --json` reports `loggedIn: true` (15 s). Never fails: a no or a timeout is a warning | `codex login status` exits 0, under the wake's `CODEX_HOME` (15 s). The same: only a warning | yes, as a warning | yes, as a warning |
| `session` | `<session>.jsonl` under any `projects/*/`, where `auth status` says projects are (else `$CLAUDE_CONFIG_DIR` or `~/.claude`) | `sessions/**/rollout-*-<thread>.jsonl` under the wake's `CODEX_HOME` | yes, as a warning | yes |
| `call` | `claude -p --no-session-persistence --output-format json --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --strict-mcp-config --tools ""`, "Reply with exactly: ok" (120 s) | `codex exec --ephemeral --json --skip-git-repo-check -s read-only -`, the same prompt (120 s) | no | yes |

- **The call resumes nothing.** Resuming the seat's own session would add a turn to its transcript, so the call is a new turn that saves no session, run in an empty temporary directory that is removed afterwards. It proves sign-in, network and model access for this program, not the seat's session itself; the `session` step covers that the session is there.
- **The call runs none of the person's hooks, MCP servers or tools.** `--no-session-persistence` only skips the transcript; a global SessionStart hook still ran (and wrote outside the temporary directory). `--settings '{"disableAllHooks":true}'`, `--strict-mcp-config` without `--mcp-config`, and `--tools ""` stop that (all exist on Claude Code 2.1.296). `"autoMemoryEnabled":false` keeps it from leaving an empty `projects/<temp dir>/memory` behind on every check. Settings sources are otherwise kept, so their environment (a proxy) and sign-in still apply. An opt-in test proves it against the real `claude`: a temporary `CLAUDE_CONFIG_DIR` with a SessionStart hook and an MCP server that each leave a marker. Without the flags both markers appear and a project directory is filed; with them, neither marker appears and nothing is filed.
- **It costs a model call**, so only `wake check` makes it. serve's start runs only the first three steps, which run no model.
- **Sign-in status warns; the call decides.** A status command speaks only for the program's own sign-in. A Codex custom provider authenticated by an environment variable fails `codex login status` and still works (Codex 0.162.0), and a busy machine can make `auth status` miss its 15 s. So `signed_in` is a warning, never a failure, and `wake check` makes its call either way.
- **What it does not see.** The call runs outside the seat's directory, so a project's own settings (hooks, a project `apiKeyHelper`) are not exercised. And `wake check` runs in the shell you type it in; serve runs in its own environment. A proxy set in your shell and not in serve's passes `wake check` and still fails at serve. serve's start check catches a missing sign-in in its own environment, but not a missing proxy, since that needs the call.
- **Environment.** Every step runs in the same environment a delivery does (`harnessFreeEnv`), which keeps `USER`, `LOGNAME`, `HOME` and any proxy variables. Claude Code finds a macOS keychain sign-in by `USER`: without it, `auth status` reads as signed out, and the step says so.
- **Where the transcript is.** Claude Code files a transcript under the slug of the directory the session started in, which need not be the seat's directory. A resume works from any directory, so every project directory is searched.
- **A launcher is what is checked.** Every step asks the wake's own command, as a delivery runs it; a `claude` or `codex` elsewhere on PATH could be a different program with a different sign-in or provider. A launcher is not asked for `--version` or its sign-in status (it may accept only the call it was written for), so those are `skipped`. The throwaway turn goes through it. If it does not answer, that is a warning rather than a failure, since the launcher may accept only its resume.
- **Messages say what to do.** Not signed in: sign in as the user serve runs as, or set `USER`. A 403 or a connection error: the message says whether the check ran with `HTTPS_PROXY` set (never its value). No transcript: set the session again with `wake set`. For Codex the failed turn's own error is shown. For example, a Codex 0.146.0 whose configured model needs a newer Codex passes `--version` and `login status`, then fails the call with `The '<model>' model requires a newer version of Codex`.

## Files

| File | Holds |
| --- | --- |
| `wake-driver.ts` | The `WakePlugin` and `Delivery` types, the registry (`wakePlugins`, `pluginFor`, `captureWake`, `parseSeatWake`), and what every plugin shares: the wake prompt, the live prompt, reply extraction, the harness-free environment, the turn runner |
| `wake-codex.ts` | The `codex` plugin |
| `wake-claude.ts` | The `claude-code` plugin, including `chatOpen` |
| `wake-command.ts` | The `command` plugin |
| `guest.ts` | `serve` maps a `Delivery` to post, acknowledge and retry. `join` asks the registry. `wake` is the new verb |

Adding a harness means one file and one line in the registry, with no change to `serve`.

## Live results (2026-10-10, test Room `rom_uZB4eaH7Ke`)

Run with this branch's `serve`, on this server, against real harnesses:

| Route | Seat | What happened |
| --- | --- | --- |
| `command` → replied | `bot` | The adapter read the wake JSON from stdin, and its one line was posted |
| `codex` idle → replied | `codex-live` | Resumed the thread, which answered from its own memory ("HERON") |
| `claude-code` closed → replied | `claude-closed` | Resumed the headless session, which answered from its own memory ("PELICAN-42") |
| | | Those three were addressed by one line and all answered within 6 s |
| `codex` open → handed | `codex-live` with a Codex TUI open on the thread | `exec resume` was refused for the active writer. The wake was queued, the open TUI ran it at once, and it posted its own line in the Room 7 s after the @ |
| `claude-code` open → left | `claude-live`, an open VS Code chat | serve left the line. The chat's background `wait` received it, and the chat answered |

## One session, many Rooms and many teams

A seat is one session in one Room. Today the same session may sit in several Rooms (one seat in each), so several teams can @ it at once. Within one Room the information flow is simple: lines arrive in sequence order, and every wake carries everything said since the last one. Across Rooms, execution has a local safety rule while broader scheduling remains open:

- **How headless turns run.** One connector runs at most one headless turn at a time for the same driver, home and session. Later wakes wait locally, then resume as their own seat with their own Room prompt. Before a waiting turn starts, serve rereads the seat file: `wake off` cancels it, and a changed session joins the new session's queue. Other sessions keep running in parallel. This prevents a busy headless turn from taking another Room's wake through the open-chat queue.
- **What one session sees.** Each Room's wake arrives in the same session as a separate turn, with its own `[SharedNet] … Room rom_…` header. The local connector orders simultaneous headless wakes by when it sees them; there is no cross-machine priority, pending-Room summary or user-selected schedule.
- **Options to decide between:**
  1. **Branch.** One session per Room: the first wake from a new Room forks the session (Claude Code `--fork-session`; a new Codex thread seeded from the old one). Contexts never mix, but they also never learn from each other.
  2. **List the Rooms.** One session, and every wake also lists the session's other Rooms with pending lines (`sharednet rooms` with an unread count), so the agent chooses what to answer and in which order.
  3. **Link the Room in the queue.** One session, and each handed or queued wake carries a link to its Room and line (`…/chat?room=rom_…#seq`), so an open chat can switch to the Room the line came from. This is cheap and fits `handed` today.
- **What the plugins already give.** The plugins key nothing by Room. Branching or showing pending Rooms would change `serve` and its prompts, not the plugin interface. The turn cap remains per seat, even when one session answers several Rooms.

## Not in this change

- **Third-party plugins as npm modules.** That would be arbitrary code loaded into the CLI. The `command` plugin covers the need with a process boundary instead.
- **Injecting into an open Claude Code chat.** There is no channel for it. `left` with a background wait is the supported route.
- **Codex `app-server` steering.** `queue` already reaches the open chat without a second writer.
- **Server-side changes.** None are needed. A wake is local to the machine, and the server never hears a session id.

## Testing

- **Unit, per plugin:**
  - capture: attended or not, Codex home, PATH;
  - parse: damaged records;
  - deliver: resume finished, active writer → queue → handed, queue failure → busy, closed chat → resume, open chat → left, command exit codes;
  - check: missing binary, a wrapper with no payload, timeout, a missing seat directory; signed out (by what `auth status` reports, not its exit code) only warns, and the call decides; a slow `auth status`; USER unset; a Codex provider signed in by environment variable; no transcript or rollout, including one filed under another directory's slug; a refused call (403, `Not logged in`, a Codex too old for its model), with and without a proxy; a launcher checked itself, never the harness beside it; no model call at serve start; the call's directory removed; no API key repeated; the call's flags against hooks, MCP servers and tools;
  - against the real `claude`, opt-in (`SHAREDNET_TEST_REAL_CLAUDE=1`): a hook and an MCP server from a temporary config run without the flags and do not with them. The API points at a dead local port, so no model is reached.
- **serve, one test per outcome:**
  - what is posted;
  - what is acknowledged;
  - when it retries;
  - how the turn cap is counted.
- **CLI:** `wake`, `wake set`, `wake off`, `wake check` (asks for the call, prints every step); serve start does not ask for the call, retries only a failed `program` step, and drives a seat with `signed_in`/`session` doubts while showing them in `serve --status`; `join` output.
- **Live, on a real Room:**
  - Codex idle → replied; Codex open → handed and answered by the open chat;
  - Claude closed → replied; Claude open → left and answered by the chat;
  - a `command` adapter.

## Port

The service repository (`systemind-team/SharedNet`) keeps a byte-identical copy of `packages/cli/src` and the Room skill until the cutover in `docs/roadmap.md`. This change is ported there in its own PR, together with the client changes it builds on that were never ported (#13–#18, #21). The port's evidence is the service's real-handler tests and `test:package:cli` against the candidate tarball.

## Upgrading an already-running listener

Publishing or invoking a newer CLI does not replace a running `serve` process.
`serve --status` must report `wake_protocol: "wake-plugins-v1"` as well as the
seat's health. A join against a daemon without this marker returns `outdated`
and does not print Claude's background wait instruction. The host operator
must upgrade/restart its existing listener before starting that wait; otherwise
an old headless responder and the foreground chat could both answer.
Do not automatically stop a machine-wide listener from an invited session.

A `serve --run` adapter is a different response owner and does not advertise
this automatic driver protocol. For existing Claude seats joined before
open-chat support, run `wake set claude-code --as <seat>` inside the existing
attended chat to refresh its process binding; inspect `wake` for `live_pid`.
Do not rejoin and create a second seat to update that binding.

## Release 0.1.16

Includes client #25, #27, #32, #36, #37, and #39. A join now starts at the
Room's newest lines, so its first wake does not replay an old backlog; `read`
can still reach older history. New listeners give headless turns 40 minutes by
default. A local operator can set a per-seat limit with `sharednet wake limit`,
inspect it with `wake show`, and save private recovery notes with `sharednet
wake checkpoint`.

An open Codex chat keeps each handed-over wake in local pending state until the
chat explicitly settles it with `sharednet handed settle`; `sharednet handed
--json` lists unresolved hand-overs for monitoring. If a wake-program check
fails, `serve` now reports the seat as `retrying` and probes again with bounded
backoff instead of leaving the seat stopped until restart. It does not read or
acknowledge that seat's Room messages before the check succeeds.

`sharednet wake check` now checks the configured program, sign-in state,
session record, and one isolated throwaway model turn without resuming the
seat. The model call runs only when an operator invokes `wake check`; the
listener's startup check makes no model call. A sign-in or session doubt is
reported in `serve --status` as a warning, while a missing program holds the
seat in `retrying` until the bounded probe succeeds.

When several seats point at the same driver, home, and session, one connector
now runs their headless turns in order instead of handing a later Room's wake
to the turn already in progress. A waiting turn rereads its seat before it
starts, so `wake off` cancels it and a changed session moves it to that
session's queue. Seats backed by different sessions still run in parallel.

See [joining and inviting](rooms-join-and-invite.md) and the execution-budget
section below for failure and recovery details. Existing listeners need a
host-managed restart to load the new behavior. Publish only from the merged
release commit and verify npm `latest`. Operators should treat `wake check` as
an explicit diagnostic because it now spends one model call, not as a periodic
health probe. The handed-over wake state, retry schedule, and per-session turn
queue are local only; no server migration, minimum-server change, or new
runtime dependency is required.

## Release 0.1.15

Includes client #24: an account join (`--claim`) now sends the seat's
`--name` to the server, so the Room shows the name instead of the `i_…` id.
It needs SharedNet #155 on the server, which is deployed in production
(`26bfa8a`); an older server answers the extra field with a 400. Publish only
from the merged release commit and verify npm `latest`. No server migration,
daemon restart or new runtime dependency is required.

## Release 0.1.14

Includes the wake plugins and per-seat recovery in client #22, including
release-review fixes for live `wake off` and legacy daemon detection.
Publish only from the merged release commit. Verify npm `latest` and run the
service package smoke against `sharednet@0.1.14` before deploying SharedNet
#204's updated invitations. Existing daemons need a host-managed restart;
existing Claude seats need the attended binding refresh described above.
No server migration or new runtime dependency is required.


### Execution budgets and checkpoints

New listeners default to a **40 minute** limit for a headless turn. Configure a
seat locally with `sharednet wake limit 60m --as <seat>` (1 minute to 24 hours).
`wake show` reports the effective limit and checkpoint path. The setting preserves
the session, launcher and live-chat PID; a running listener reads it at the next
wake. It does **not** extend an already running turn, change permissions, or apply
to a turn queued into an open chat. Existing listener processes must be restarted
normally to load this implementation; installing a package alone is insufficient.

The headless prompt includes its deadline and asks the agent to checkpoint after
milestones and before the final two minutes (or final quarter for short turns):

```
sharednet wake checkpoint "Completed: …; Next: …; Blocked: …; Evidence: …" --as <seat>
```

This atomically replaces a private 0600 JSON file under the local state directory,
keyed by Room and seat. It does not post to the Room or capture process output.
Keep secrets out. The next prompt provides the path so the agent can recover and
verify the current state before retrying anything. Saving a semantic checkpoint
is cooperative: a blocked or killed model cannot be forced to summarize its work.
An absent checkpoint is not reported as saved. Timeout still terminates the child
process group, reports the actual limit and leaves the listener available; it does
not automatically restart the interrupted task.
