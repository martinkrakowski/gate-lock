# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The conformance suite in `test/conformance/`, a black-box suite that never
writes fixtures through the CLI. Spec-exact helpers create 4-file and 6-file
slots, `.format`, transients and planted forgeries byte for byte from section 2
of the specification; the suite asserts the CLI's effects as golden directory
listings and exact file bytes for `acquire`, `release`, `verify`, `heartbeat`,
`status --json` and `clean`.

### Fixed

- `gate-lock run`: a command that ignores TERM and is KILLed by the run's watchdog no
  longer leaks the shell's own job notice onto the caller's stderr.
- `gate-lock run`: the teardown's wait for its supervisor is bounded in all, at
  `8 + 2 x (grace + 18)` one-second rounds (64, about a minute, at the default
  grace). A supervisor that kept reporting progress without finishing could hold
  the slot for about thirteen minutes before.
- `gate-lock run`: a run that has to KILL its supervisor now KILLs the
  supervisor's heartbeat loop and any refresh in flight with it, before it
  releases, and removes the beat that refresh had staged. Each pid is read from
  the run's own directory and checked against its parent first; one that cannot
  be checked is left alone and named on stderr. Before this a refresh could
  outlive the run that started it.
- `gate-lock run`: the parent check before that KILL no longer accepts an empty
  answer from `ps`, and the line about a heartbeat that had not gone says "still
  listed", since a KILLed process can simply be waiting to be reaped.

## [0.1.0] - 2026-10-04

The first release: a host-wide gate lock with a shared pool of slots, on-disk
format 1, and a wrapper that holds a slot around one command.

### Added

- `gate-lock run [--status-file <p>] [--wait <seconds>] <lane> -- <command...>`:
  takes a slot for a lane with its own pid as the holder, keeps it alive with a
  heartbeat, runs one command with stdout and stderr untouched, and gives the
  slot back on every exit path - success, failure, a signal or a refused acquire.
  `--status-file` records `cmd:<code>`, `tool:<code>`, `busy:host` or
  `busy:worktree`; `--wait` retries a busy pool with a jittered one-to-five second
  pause until the deadline and then exits 75, and a signal ends the wait.
- A heartbeat supervisor around the loop: it owns the loop as its own child,
  restarts it once if it dies abnormally, and when the loop is gone for good it
  sends TERM to the command and KILL after a ten second grace period. A refresh
  that fails - the lock was reclaimed, or the slot was replaced - is reported as
  `lock lost` and the run exits 2 without releasing a lock that is not its own.
- Signals: HUP, QUIT and TERM are forwarded to the command as TERM and answer
  129, 131 and 143, INT answers 130, and a second signal is ignored rather than
  allowed to cut the release short. The lock is released only after the command
  has actually stopped, and no refresh of this run's own is in flight when it is.
- `acquire`, `release`, `verify` and `heartbeat` for a caller that holds a slot
  across several steps, including a quiet `verify` for step boundaries and a
  refusal that treats a stranger's pid as "not mine".
- `status` and `status --json`: one line per slot with the holder, the project,
  the start time, liveness and heartbeat freshness, then a capacity line; JSON
  with a stable schema and `version: 1`. Read-only, and it never reclaims.
- `clean`, a janitor pass that removes a transient only when the process that
  created it is gone and the transient is older than the stale threshold. It also
  runs at the start of every acquire.
- `workers`, which prints the per-run worker cap by the same rules as
  `resolveMaxWorkers`, so a runner that is not written in JavaScript can use them.
- `resolveMaxWorkers(env?, cpus?)` and `FORMAT` as the library's whole interface:
  the per-run worker cap a test-runner configuration should use, with no lock
  logic in JavaScript.
- Pool resolution with no daemon: `GATE_LOCK_DIR`, then `XDG_RUNTIME_DIR`, then a
  private per-uid directory under the temp directory; absolute, plain paths only,
  with the parent and every ancestor checked for symlinks, ownership and mode.
- Configuration that is resolved once per invocation, for every subcommand and
  before the usage check, in the order the specification gives: pool directory,
  marker, stale threshold, heartbeat period, worker agreement, slot count, budget,
  and any disagreement between a project's count and the host's.
- A one-line warning when the pool has more than one slot and no worker cap is
  set anywhere, because then every gate picks its own default.
- Lane labels validated as one line of printable ASCII at most 128 bytes wide, so
  the `owner` file can be compared byte for byte.
- `GATE_LOCK_DIR`-relative directory rules that defeat planted directories,
  symlinks and foreign-owned directories, so a slot that somebody else made is
  invisible rather than trusted.

### Notes

- The pool is on disk in a format other clients share; nothing is cached in
  memory, and a run is a holder, not a server.
- One pool belongs to one uid, and every participant must share one pid
  namespace. Both limits are documented in the README rather than worked around.
- The on-disk format 1 is specified in docs/requirements.md, whose section 2 is
  frozen: what another client observes on disk does not change without a format
  bump.
- CI runs the suite under dash, `bash --posix` and the system shell on Linux and
  macOS, with eslint, shellcheck, a formatting check and an assertion of the
  published file list on every leg.
- 0.1.0 was checked against an independent format-1 client on one shared pool,
  in both directions: each side saw the other's held slots as busy (exit 75),
  refused to reclaim the other's live holder and reclaimed its dead one, the
  same worktree blocked with byte-equal identity, each side's `status` listed
  the other's slot with the project, and a 4-client storm into 2 slots never
  held more than two complete slots - every scenario passed. The same run
  found a §2.4 defect on the other client's side: it removes a slot in place
  rather than renaming it aside first, so a watcher can briefly see an
  incomplete slot at a canonical name. This client behaved correctly
  throughout, and the defect was reported to that client's maintainers.

[Unreleased]: https://github.com/martinkrakowski/gate-lock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/martinkrakowski/gate-lock/releases/tag/v0.1.0
