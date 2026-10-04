# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

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
