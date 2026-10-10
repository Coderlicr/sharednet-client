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
  /** `wake check` and serve start: can the program start at all (#20's launch probe). */
  check(wake, env): Promise<CheckResult>;
}
```

### Deliveries

`deliver` returns one of five outcomes, and **serve alone** decides what each one means for the Room and the seat's place. A plugin never posts and never acknowledges.

| Outcome | Meaning | serve posts | serve acknowledges | then |
| --- | --- | --- | --- | --- |
| `replied` | A turn ran and finished. `reply` is its last words, or null for `(no reply)` | the reply, if any | yes | next wake |
| `handed` | The wake was put into the open session (Codex `queue`), which will answer in the Room itself | nothing | yes. The harness's queue is durable, and a session that closes first drains it at its next resume | next wake |
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
  - `codex queue` stores the message in `~/.codex/queue_1.sqlite` and returns at once. An idle thread does not run it by itself, but the next `exec resume` turn delivers it first ("Other user message received since my last reply: …"). So a handed wake is never lost.
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
| `sharednet wake check [--as <seat>]` | Runs the plugin's launch probe (`--version` under the wake's environment, five-second deadline) |
| `sharednet serve --status` | Each seat's driver, as `resumes`, is shown as before |

At start, `serve` probes each driven seat once, as #20 did. A seat whose program does not start is reported as `stopped` with the probe's message, and its lines are not consumed.

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

## Open question: one session, many Rooms and many teams

A seat is one session in one Room. Today the same session may sit in several Rooms (one seat in each), so several teams can @ it at once. Within one Room the information flow is simple: lines arrive in sequence order, and every wake carries everything said since the last one. Across Rooms it is not decided:

- **What one session sees.** Each Room's wake arrives in the same session as a separate turn, with its own `[SharedNet] … Room rom_…` header. Nothing yet tells the session which other Rooms are waiting on it, or orders them.
- **Options to decide between:**
  1. **Branch.** One session per Room: the first wake from a new Room forks the session (Claude Code `--fork-session`; a new Codex thread seeded from the old one). Contexts never mix, but they also never learn from each other.
  2. **List the Rooms.** One session, and every wake also lists the session's other Rooms with pending lines (`sharednet rooms` with an unread count), so the agent chooses what to answer and in which order.
  3. **Link the Room in the queue.** One session, and each handed or queued wake carries a link to its Room and line (`…/chat?room=rom_…#seq`), so an open chat can switch to the Room the line came from. This is cheap and fits `handed` today.
- **What the plugins already give.** The plugins key nothing by Room, so any of the three is a change to the prompt and to `serve`'s per-session ordering, not to the plugin interface. The turn cap is per seat today. It would become per session if one session answers several Rooms.

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
  - check: missing binary, a wrapper with no payload, timeout.
- **serve, one test per outcome:**
  - what is posted;
  - what is acknowledged;
  - when it retries;
  - how the turn cap is counted.
- **CLI:** `wake`, `wake set`, `wake off`, `wake check`; `join` output.
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
