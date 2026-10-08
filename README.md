# @hexagen-monaco/gate-lock

A host-wide gate lock. Every project and every git worktree on one host shares a
pool of N slots; at most N expensive gates (test runs) run at once, and never two
in the same worktree. The pool is on disk, in a format other clients can read and
write, so a host that has adopted it counts the slots once between all of its
projects.

It is POSIX `sh` with no runtime dependencies, and it is honest about being a
developer-host mechanism rather than a security boundary: it defeats accidents
and cheap forgeries (planted directories, symlinks, writable parents), not a
hostile local user.

## Install

```sh
npm install --save-dev @hexagen-monaco/gate-lock
```

The binary is `gate-lock`. Nothing else is installed on the host: there is no
daemon and nothing to start.

## The shape of it

```sh
# the host decides once, host-wide, for every session
export GATE_LOCK_DIR=/run/user/$UID/gates      # the pool directory (see "Where the pool lives")
export GATE_HOST_SLOTS=6                      # six gates at a time
export GATE_HOST_WORKERS=4                    # four test workers each: 6 x 4 = 24

# a project runs one of its gates under the lock
gate-lock run unit -- npm test
```

`GATE_HOST_SLOTS` and `GATE_HOST_WORKERS` are one decision: slots times workers
must not exceed the host's processor count, and the tool refuses a combination
that does not (`GATE_HOST_SLOTS=7` with `GATE_HOST_WORKERS=4` on 24 processors is
refused, exit 2). Both are the host's, set host-wide: a seat count belongs to the
machine, not to one project.

`GATE_LOCK_SLOTS` is a project's own view of that count, for a pool-less host or
as a way to assert the host's: beside a pool it must agree with the host's count,
and a disagreement is refused (exit 2) rather than obeyed, because a seat that
believes the host has fewer gates than it does takes one beside a holder it
cannot see. With no `GATE_HOST_WORKERS` a count may still be given, and a host
with no variables at all gets a pool of one slot.

## Usage

```
gate-lock run [--status-file <p>] [--wait <seconds>] <lane> -- <command...>
gate-lock acquire <lane>
gate-lock release <lane>
gate-lock verify <lane>
gate-lock heartbeat
gate-lock status [--json]
gate-lock clean
gate-lock workers
gate-lock --format
gate-lock --version
```

### run

`run` is the wrapper almost every caller wants: it takes one slot for a lane,
keeps it alive with a heartbeat, runs one command, and gives the slot back on
every exit path - success, failure, a signal, or a refused acquire.

```sh
gate-lock run unit -- npm test                       # the command's own exit status
gate-lock run lint:node -- npm run lint              # a lane per job
gate-lock run --wait 300 e2e -- npm run e2e          # retry while the host is busy
gate-lock run --status-file /tmp/gate.status docs -- make docs
```

- The **lane** is free text: the label every other line about this slot shows. It
  is printed as `acquired by <lane> pid <pid> at <slot path>` on stdout, which is
  also where the heartbeat is announced: `heartbeat pid <pid> every <s>s while
<lane> runs`.
- The `--` must come immediately after the lane. A later `--` is an ordinary
  argument of the command, and the command's arguments are passed through exactly
  as given - no re-parsing, no word splitting, no globbing.
- The command inherits the tool's stdout and stderr unchanged, so a failing test
  run is reported live, and its stdin is `/dev/null`. `run` reserves file
  descriptor **9** for itself: it keeps a copy of its own stderr there, so that a
  shell's own notices about its own jobs cannot land on yours, and it closes 9 again
  on the launch of every child. Your command therefore sees the descriptors you gave
  it - 0 to 8, and anything above 9 - with that single exception: **fd 9 is not
  passed through**, so a command that wants it must open its own.
- The holder recorded in the slot is `run`'s own pid, whatever caller pid was
  inherited from the environment; an inherited pin (`GATE_LOCK_SLOT_PATH`) and
  slot-output file (`GATE_LOCK_SLOT_OUT`) are cleared first and are **not** passed
  on to the command, so a wrapped command cannot be diverted by them.
- The heartbeat period is `GATE_LOCK_HEARTBEAT_SECONDS` (default 60, minimum 1).
- `--status-file <p>` writes one line: `cmd:<code>` when the lock was held
  throughout and the exit status is the command's own, `tool:<code>` when the
  answer is the tool's - a refusal, a signal (129/130/131/143), a lost lock (2) or
  a lock that could not be given back (1) - and `busy:host` or `busy:worktree`
  when the acquire was refused and nothing has changed the answer since.
- `--wait <seconds>` retries a busy pool with a jittered pause of one to five
  whole seconds until the deadline, and then exits 75. **A signal ends the wait.**
- A busy host is exit 75 and nothing is run. A signal is never swallowed: HUP,
  QUIT and TERM are forwarded to the command as TERM and answer 129, 131 and 143,
  and INT answers 130. A second signal is ignored, because re-entering the handler
  is how a cleanup gets skipped.

`run` stops **the command it started** and waits for that command to be gone; it
does not signal the command's children, because a portable `sh` cannot reach them
(the command is not a process-group leader in a non-interactive shell, and joining
one would put the run in it too). A command that leaves work behind must reap it
itself - `exec` a test runner instead of backgrounding it - or the workers keep
running after the lock has gone back, with nothing refreshing their beat.

`run` supervises its heartbeat rather than trusting it. The supervisor owns the
loop as its own child, restarts it once if it dies with a status that is neither
"stopped" nor "refresh failed", and when the loop is gone for good it sends TERM
to the command and KILL after a ten second grace period. If a refresh fails - the
lock was reclaimed, or the slot was replaced - the run says the lock was lost,
stops the command, and exits 2 without releasing a lock that is not its own.

When the command has ended, `run` asks its supervisor to stop and waits for it
before it releases. That wait is bounded in all: `run` gives up on a supervisor
that will not stop after at most `8 + 2 x (grace + 18)` one-second rounds, where
the grace is the ten seconds above. That is 64 rounds, about a minute. It then
stops the supervisor the hard way, says so on stderr, and decides from the slot
itself whether the lock is still its own. Most waits end far sooner (a supervisor
that is simply gone costs eight rounds). A wait that does run to the bound takes
at least a minute and, since a round is at least a second, longer on a loaded
host. (Before this bound a supervisor that kept reporting progress without
finishing could hold the slot for about thirteen minutes.)

### acquire, release, verify, heartbeat

These are for a caller that wants to hold a slot across several steps, which is
what `run` exists to avoid.

```sh
export GATE_LOCK_CALLER_PID=$$                     # the pid that holds the lock
export GATE_LOCK_SLOT_OUT=$(mktemp)                # a private file, made by mktemp
gate-lock acquire unit                               # prints: acquired by unit pid <pid> at <path>
pin=$(cat "$GATE_LOCK_SLOT_OUT")
gate-lock heartbeat                                  # refresh the beat, pinned
gate-lock verify unit                                # still mine? exit 0, silent
gate-lock release unit                               # gives the slot back
```

**Check the exit status before reading the slot-out file.** The `acquired` line is
printed _before_ the slot path is written, so a caller that reads the file on the
strength of that line can race the write. If the write cannot be done, `acquire`
gives the slot back and exits 2 - so the pin is absent and the lock is gone, and a
caller that trusted the line would keep going without a lock. Read the file, and
treat an empty one as "acquired nothing".

The caller pid is never guessed: `acquire` without `GATE_LOCK_CALLER_PID` is
refused (exit 2) and recommends `run`, because the only pid it could record is its
own, which dies before the caller runs a step and leaves the lock reclaimable at
once. A dead caller pid is accepted - that is how a crashed gate's slot is seeded
for the next caller to reclaim.

`verify` is the quiet probe a runner calls at a step boundary: exit 0 and nothing
on stdout while the slot still names this lane and this pid; exit 1 otherwise. A
caller should treat exit 1 and exit 2 alike as "lock lost".

### status

```sh
gate-lock status            # one line per slot, then a capacity line
gate-lock status --json     # the same, machine-readable
```

```
/run/user/1000/gates/gate.lock held by unit project gate-lock started 1791006798 pid 4242 alive, heartbeat fresh (beat 1791006834)
free: /run/user/1000/gates/gate.lock is not held
slots: 2/6 live, 0 stale, pool /run/user/1000/gates, format 1
```

`status` is read-only: it never lists a transient, never touches one, and never
reclaims a slot whose holder is dead. It lists every existing slot, including
slots beyond the configured count, so a host whose count was lowered under a holder
still shows that holder.

### clean

`clean` runs one janitor pass, which is also run at the start of every acquire. It
removes a transient (`.cand.*`, `.beatnew.*`, `.format.tmp.*`, `.reclaim.*`) only
when the process that created it is gone **and** the transient is older than the
stale threshold, and prints `janitor: removed <name>` for each removal. It never
removes a slot.

### workers

`gate-lock workers` prints the per-run worker cap a test-runner configuration
should use, or nothing when there is no cap. It applies exactly the rules of
`resolveMaxWorkers` below and exits non-zero with a message when a variable is
unusable.

## Exit codes

| Code         | Meaning                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0            | success; with `run`, the command exited 0 and the lock was released                                                                                                                                                                                                                         |
| 1            | `verify` failed or found no lock; `heartbeat` refused, found no lock, or could not write; `release` refused or failed; `run` where the lock was no longer this run's, or could not be given back, and the command had exited 0                                                              |
| 2            | usage error; any configuration refusal; a bare `acquire`; an acquire while the same pid already holds a slot; an empty worktree; a slot-output file that cannot be written (the slot is given back); a bad pin; a bad heartbeat period; with `run`, the lock was lost while the command ran |
| 3, 4, 127, … | with `run`, whatever the wrapped command exited with                                                                                                                                                                                                                                        |
| 75           | busy: every slot answering, or the same worktree; also what `run` exits when its acquire is busy and it is not waiting                                                                                                                                                                      |
| 130          | `run` interrupted by INT                                                                                                                                                                                                                                                                    |
| 143          | `run` terminated by TERM (also a command's own TERM status)                                                                                                                                                                                                                                 |
| 129, 131     | `run` killed by HUP or QUIT                                                                                                                                                                                                                                                                 |

A busy line goes to stderr and nothing else does, which is how a caller tells a
busy lock (75) from a wrapped command that happened to exit 75 (C44).

## On-disk format 1

The pool is a directory of slot directories, and a slot is six one-line files:

```
gate.lock/
  owner      the lane label
  pid        the holder's pid
  started    epoch seconds at acquisition
  beat       epoch seconds of the last heartbeat
  worktree   the caller's worktree identity
  project    the last path component of the worktree (display only)
```

plus one marker file in the pool root, `.format`, holding `1`. Everything is
judged from those files: a holder is answering when its pid is alive **and** its
beat is fresh (default: newer than 600 s), and a slot is free when it does not
exist. There is no lock server and no state anywhere else.

Writers are careful in the ways that matter on a shared filesystem:

- a slot is created by filling a whole candidate directory and renaming it onto the
  name, so a slot is never seen half-written;
- a beat is replaced by renaming a staged file over it, so a reader sees the old
  value or the new one and never an empty or missing file;
- a reclaim renames the slot aside, checks that what moved is the slot that was
  judged dead, and only then deletes it - a slot that was replaced in the window is
  put back or left aside, never deleted;
- a directory is only accepted as a slot if its name is canonical, it is not a
  symlink, it is a directory, and it is owned by the expected uid. Planted names,
  symlinks and foreign directories are invisible to `status`, to an unpinned
  caller, and refused for a pinned one.

This is format 1 as specified in
[docs/requirements.md](https://github.com/martinkrakowski/gate-lock/blob/main/docs/requirements.md);
any other client that speaks it shares the pool and is seen by this one.

## Where the pool lives

In order:

1. `GATE_LOCK_DIR`, if set.
2. `$XDG_RUNTIME_DIR/gate-lock`, if `XDG_RUNTIME_DIR` is an absolute, plain,
   existing, owner-only directory with no symlinked component.
3. `<temp directory>/gate-lock-<uid>/pool`, where the intermediate directory is
   created mode 0700 and verified. This is the only place the tool creates a
   parent: the system temp directory itself is refused, because it is shared and
   writable, and a pool under it can be displaced (see the platform notes).

The pool must be an absolute, plain path: no `//`, no `.`, no `..`. It must not be
the filesystem root. Its parent must be a real directory, not a symlink, owned by
the same uid and not writable by group or others, and no ancestor above it may be a
symlink. **On macOS, `/tmp` and `/var` are symlinks**, so a pool built from the
default temp directory is refused with a message that says how to fix it: name the
pool by its physical path.

```sh
export GATE_LOCK_DIR="$(cd /run/user/$UID && mkdir -p gates && pwd -P)/gates"
```

A local tmpfs is the right home for it (a per-user runtime directory), and to
survive logout it needs the session to linger (`loginctl enable-linger` for
systemd). The pool is lost on reboot, which is fine: holders do not survive one
either. Do not put the pool on a union filesystem, on NFS, or on an overlay: a
cross-branch rename degrades to copy-then-delete, which is the race that
reclaims a live holder.

## The one-uid limit

One pool belongs to one uid. The pool is mode 0700 and every slot is checked
against the expected uid, and liveness is a signal-zero probe - which another
user's process answers with "permission denied", read here as "not alive". **A
second user cannot share a pool**: it would reclaim the first user's live holders.
Give each user their own `GATE_LOCK_DIR`, or run the lanes as one user.

The same rule applies to containers: every participant in one pool must share one
pid namespace, and a container that sees different pids reads live host holders as
dead. A containerised gate must run the tool inside the host's pid namespace, or
not share the pool.

## Test workers

A slot is a budget of workers as well as a seat. The library export is the whole
interface a runner needs:

```js
// vitest.config.js
import { defineConfig } from 'vitest/config';
import { resolveMaxWorkers } from '@hexagen-monaco/gate-lock';

export default defineConfig({
  test: {
    // A project variable wins; the host's value is used when the project sets
    // none; nothing is set when neither is, and the runner keeps its own default.
    maxWorkers: resolveMaxWorkers(),
  },
});
```

`resolveMaxWorkers(env?, cpus?)` returns a positive integer, or `undefined` for
"no cap":

- `GATE_LOCK_WORKERS` wins when it is present, even when it is empty;
- otherwise `GATE_HOST_WORKERS` is used unless it is empty;
- an empty or unusable **project** variable is refused (exit-worthy `Error`)
  rather than answered from the host, because a project variable is somebody's
  deliberate setting;
- a value above the processor count is refused rather than clamped - a cap above
  the thread count is not a cap;
- the two variables are not compared here; the lock tool does that (V9), because it
  is the layer that knows whether a pool is in use.

Two things to know when you wire it in:

- **Do not set a runner-level override beside it.** An override variable
  (`--maxWorkers`, `UV_THREADPOOL_MAX`, …) applied after the setting silently wins
  and leaves the validated number ignored.
- The library and `gate-lock workers` deliberately count processors differently.
  The library uses what the process may really use (libuv honours cgroup quotas
  and affinity); the CLI prefers `nproc` and falls back to
  `getconf _NPROCESSORS_ONLN`, which is the host's online count, because the slot
  derivation must see the host. On a host with a CPU quota the library is the
  stricter of the two, and refuses a cap the CLI would have accepted.

`run` prints a one-line warning when the pool has more than one slot and neither
worker variable is set, because then every gate picks its own default and the
product is whatever the defaults happen to be. The exit status is unchanged.

## Recipes

**A gate runner that waits for a seat.** The recommended shape is `run` with
`--wait`, which needs no state at all:

```sh
gate-lock run --wait "${GATE_LOCK_WAIT:-600}" "$lane" -- npm test
```

**A runner that holds one slot across several steps**, when `run` does not fit:

```sh
#!/bin/sh
set -u
lane=$1; shift

out=$(mktemp "${TMPDIR:-/tmp}/gate.XXXXXX")          # a private file (C46)
export GATE_LOCK_CALLER_PID=$$
export GATE_LOCK_SLOT_OUT=$out

acquired=0
release_lock() {
  [ "$acquired" = 1 ] || return 0
  acquired=0
  if [ -s "$out" ]; then
    GATE_LOCK_SLOT_PATH=$(cat "$out") "$GATE_LOCK" release "$lane"
  else
    # The lock was won but never recorded: give it back by lane and pid (C49).
    "$GATE_LOCK" release "$lane"
  fi
  rm -f "$out"
}
trap 'release_lock; exit 143' TERM INT HUP QUIT

"$GATE_LOCK" acquire "$lane" || exit $?              # 75 reaches the caller
acquired=1
pin=$(cat "$out")

# A heartbeat loop of the runner's own (C48), which it also checks at every
# boundary (C50):
(
  while :; do
    GATE_LOCK_SLOT_PATH=$pin "$GATE_LOCK" heartbeat || exit 1
    sleep 60
  done
) &
beat=$!
trap 'kill "$beat" 2>/dev/null; wait "$beat" 2>/dev/null; release_lock; exit 143' TERM INT HUP QUIT

GATE_LOCK_SLOT_PATH=$pin "$GATE_LOCK" verify "$lane" || { release_lock; exit 1; }
npm run lint
GATE_LOCK_SLOT_PATH=$pin "$GATE_LOCK" verify "$lane" || { release_lock; exit 1; }
npm run build

kill "$beat" 2>/dev/null; wait "$beat" 2>/dev/null
release_lock
```

Points that matter in that shape: the release happens on **every** exit path and
at most once; further signals are ignored until it has run; the release's own
output goes to the caller's stdout, not into a step's redirected capture; and a
signal that arrives while the acquire is still running must not leak the slot the
acquire went on to win - which is why the release reads the slot-out file rather
than trusting the pin.

**A busy answer in a CI pipeline.** `run` exits 75 and its stderr carries one
line naming the holder, so a job can retry without parsing anything else:

```sh
gate-lock run "$lane" -- npm test || case $? in
  75) echo "the host is busy; retrying" >&2; sleep 30; exec "$0" "$@" ;;
  *) exit $? ;;
esac
```

## Platform notes

- **POSIX `sh` only.** No bash features, no `$PPID` as a liveness source, no
  fractional sleeps (BSD and GNU differ, so every wait is a whole second), and
  never `mv -n`: it is not atomic everywhere.
- **Not POSIX, but present on GNU, BSD/macOS and busybox:** `date +%s`,
  `getconf _NPROCESSORS_ONLN`, `find -perm`, `mktemp`. The tool never calls
  `stat` or `realpath`: it canonicalises with `cd … && pwd -P`, and the test
  harness uses Node's `realpathSync`.
- **macOS:** `/tmp` and `/var` are symlinks, and a pool built from the default
  temp directory is refused by the ancestor walk. Name the pool by its physical
  path. Ownership and mode are read through `find` predicates because POSIX `sh`
  has no portable `stat`.
- **Job control and signals:** in a non-interactive shell an asynchronous command
  starts with INT and QUIT ignored and keeps that, so a wrapped command cannot be
  stopped with INT or QUIT - which is why `run` forwards TERM for all of them.
- **Liveness is a signal-zero probe**, and any failure of it - "permission denied"
  included - means not alive. This is correct for one uid per pool and wrong for
  two.
- **The clock is the wall clock.** Time is epoch seconds from `date +%s`; there is
  no monotonic source. A clock step can make a beat appear in the future (never
  stale) or very old (stale).
- **Git is optional.** The worktree identity prefers `git rev-parse
--show-toplevel` and falls back to the physical working directory; a linked
  worktree resolves to its own root.

## API

```js
import { FORMAT, resolveMaxWorkers } from '@hexagen-monaco/gate-lock';
```

`FORMAT` is `1`. `resolveMaxWorkers` is described above. There is no other export
and no lock logic in the library.

## Development

- [Implementation plan](https://github.com/martinkrakowski/gate-lock/blob/main/docs/plan.md)
- [Requirements specification, format 1](https://github.com/martinkrakowski/gate-lock/blob/main/docs/requirements.md)
- [Changelog](CHANGELOG.md)

`npm test` runs the suite; CI runs it under `dash` and `bash --posix` as well as
the system shell, and runs `shellcheck` over the tool.

MIT licensed.
