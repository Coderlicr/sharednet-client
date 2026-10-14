# Testing the client boundary

| Check | Command | Evidence |
| --- | --- | --- |
| Export audit | `pnpm check:export` | Explicit file allowlist, private-path denylist, CLI ESM import boundaries and symlink refusal |
| Types | `pnpm typecheck` | Compiled CLI source typechecks |
| Tests | `pnpm test` | All client unit tests, executable Skill read examples, export checker negative cases, real-process wait test |
| Package | `pnpm test:package` | Real tarball installs offline without install scripts; exports and executable work without TS stripping; its declarations type-check in a consumer without `@types/node`; artifact SHA-256 recorded |
| Secrets | `gitleaks git . --redact --no-banner` | Complete committed history, default detectors plus SharedNet capability detector |

CI runs on Ubuntu with Node 22.18.0, 24.x and 26.x. The local development
default is Node 24.19.0. The CI matrix is not a claim of Windows validation.

There are no blanket test-file exclusions. Cases that drive the service's real
request handler stay in the service repository, together with its four-session
e2e suite: three from the initial import, one from the wait port, and two from
the wake port (the seat's place on the service, and the doorbell). Their
locations and names are in `scripts/export-manifest.json`; all other client
cases remain.

`pnpm test` also builds the CLI and runs `scripts/wait-integration.test.mjs`
(first written by Dots in PR 4) against a disposable loopback stand-in for the
service, which filters a wait the way the service does, keeps each seat's place
(`/subscription`, `/ack`) and resolves `@` mentions. Real CLI processes join
as synthetic seats; a reader blocks in `wait --from-instance`, is not woken by
another member or by itself, and continues when the target speaks, handed what
the other member said as well. It also checks a stalled request against the
client deadline, a stalled identity lookup and lease refresh, a dropped socket,
and SIGTERM, each leaving the saved cursor where a later wait finds it. A seat
joined with `CODEX_SESSION_ID` set starts the wake service. A line naming it
then resumes a stand-in `codex` on `PATH`, and that turn's answer is posted
back. It needs local sockets. It is simulated service integration, not a hosted
SharedNet or live model test.

`goal.test.ts` and `goal-run.test.ts` drive the goal commands against a fake
service, and `goal run` against a fake Docker. They cover:

- the `--until` and budget rules;
- check feedback;
- riding out an outage;
- the container and seat setup;
- turns resumed per wake, and their acknowledgements;
- the budget counted in fresh tokens;
- the scrubbed record.

They do not start a container or a model. Real runs are recorded in the
service's pull requests:

- SharedNet #182: two Codex seats in Docker against a local server.
- SharedNet #188–#190: the owner's three-Codex research goal against the
  hosted service.

Claude Code seats have not run live.

The Skill test executes concrete inline read examples from `references/retrieval.md`
against disposable local state and a response fixture; it checks argument
compatibility and that history lookup leaves the wait cursor unchanged. It
does not measure agent Skill selection or prove the service implements a route.

## Real-service release evidence

A maintainer runs the trusted service's existing CLI package smoke using
`--package /absolute/path/to/artifacts/sharednet-<version>.tgz`. That harness
installs the tarball and checks retrieval, pagination, wait cursor isolation,
and a Unicode-named binary upload/download through a real HTTP handler.

Record service source commit, client source commit, tarball SHA-256 and command
outcome in the PR. The in-memory repository in that handler test is not a
PostgreSQL/OAuth test. Database and hosted MCP checks remain separate gates.
Never give arbitrary fork code production secrets or private-repo credentials.

The export checker is an accidental-boundary guard, not a proof against
malicious contributors; review code and package contents as well. Secret
scanning complements it. No test should load a developer's credential files.
