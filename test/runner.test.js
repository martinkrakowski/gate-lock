// GL3: spec 6.K, T103-T109 - the caller contract, proved through a runner this
// suite writes. The runner is a caller, not part of the package: it stands in
// for the gate runner a project builds on the lock's interface (C46-C50), and
// these tests say what the lock must permit such a caller to do.
//
// The H9 seams are the runner's own: a pause before each locked step, the
// heartbeat loop's TERM handler (touch a marker saying the handler is running,
// then wait for a named file to appear, so re-entry is harmless), and a flag
// that makes the runner act as if its acquire had recorded no slot. The tool's
// own seams (H2, H7) drive the acquire and release windows.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIN, listing, scratchOf, startBin, waitForFile } from './harness.js';
import { livePid, names, readSlot, seed, wtDir } from './slots.js';
import { freshPool, track, waitForDead } from './run.js';

/** A step that announces itself and then runs until it is stopped. */
const LONG_STEP = (ready) =>
  `printf 'step says hi\\n'
printf '%s\\n' "$$" >"${ready}"
i=0
while [ "$i" -lt 600 ]; do
  i=$((i + 1))
  sleep 1
done`;

/**
 * A gate runner written against the lock's contract (C46-C50), as a POSIX sh
 * script. Everything it does is something the interface has to permit.
 */
const RUNNER = `#!/bin/sh
# A gate runner (spec C46-C50). Not part of the package.
set -u
LC_ALL=C
export LC_ALL
lane=$1
shift
bin=$GATE_LOCK_TEST_RUNNER_BIN
period=\${GATE_LOCK_TEST_RUNNER_PERIOD:-1}
out=$(mktemp "\${GATE_LOCK_TEST_RUNNER_TMP:-\${TMPDIR:-/tmp}}/gate-lock-runner.XXXXXX") || exit 1
pin=
step_pid=
beat_pid=
released=0
sig=
sig_code=0
sig_seen=0
beat_stop=0

stop_beat() {
  if [ -z "$beat_pid" ]; then
    return 0
  fi
  b=$beat_pid
  beat_pid=
  kill -TERM "$b" 2>/dev/null
  before=$sig_seen
  while :; do
    wait "$b"
    st=$?
    if [ "$sig_seen" = "$before" ]; then
      return 0
    fi
    if [ "$st" -le 128 ]; then
      return 0
    fi
  done
}

# The release (C49): at most one, pinned when the pin is known, with the runner's
# own caller pid, and its stdio on the runner's own streams rather than a step's
# redirected ones.
release_lock() {
  if [ "$released" != 0 ]; then
    return 0
  fi
  released=1
  stop_beat
  # H9: with the flag set, the runner acts as if its acquire had recorded no slot
  # at all - the file is not read either, which is the whole point of the flag.
  if [ -n "\${GATE_LOCK_TEST_NO_SLOT:-}" ]; then
    pin=
  elif [ -z "$pin" ] && [ -s "$out" ]; then
    pin=$(cat "$out")
  fi
  if [ -z "$pin" ]; then
    printf 'runner: FAILED to record the slot path; releasing by lane %s and pid %s\\n' "$lane" "$$" >&2
  fi
  if [ -n "$pin" ]; then
    GATE_LOCK_CALLER_PID=$$ GATE_LOCK_SLOT_PATH=$pin "$bin" release "$lane"
  else
    GATE_LOCK_CALLER_PID=$$ "$bin" release "$lane"
  fi
  rel=$?
  rm -f "$out"
  if [ "$rel" -ne 0 ]; then
    printf 'runner: FAILED to release the lock\\n' >&2
    return 1
  fi
  return 0
}

# H9: the loop's TERM handler says it is running, then waits for a named file to
# appear. Waiting for appearance rather than disappearance makes re-entry harmless.
on_beat_term() {
  beat_stop=1
  if [ -n "\${GATE_LOCK_TEST_HANDLER_RUNNING:-}" ]; then
    : >"$GATE_LOCK_TEST_HANDLER_RUNNING" 2>/dev/null
    while [ ! -e "$GATE_LOCK_TEST_HANDLER_GO" ]; do
      sleep 1
    done
  fi
}

beat_loop() {
  trap on_beat_term TERM INT HUP QUIT
  while [ "$beat_stop" = 0 ]; do
    GATE_LOCK_CALLER_PID=$$ GATE_LOCK_SLOT_PATH=$pin "$bin" heartbeat
    if [ $? -ne 0 ]; then
      return 1
    fi
    sleep "$period" &
    sleeper=$!
    wait "$sleeper"
    if [ "$beat_stop" != 0 ]; then
      kill "$sleeper" 2>/dev/null
      wait "$sleeper" 2>/dev/null
      return 0
    fi
  done
  return 0
}

# C40: a second signal of any kind is ignored once the first has been handled,
# because re-entering could skip the release.
on_signal() {
  sig_seen=$((sig_seen + 1))
  if [ -n "$sig" ]; then
    return 0
  fi
  sig=$1
  sig_code=$2
  if [ -n "$step_pid" ]; then
    kill -TERM "$step_pid" 2>/dev/null
  fi
  if [ -n "$beat_pid" ]; then
    kill -TERM "$beat_pid" 2>/dev/null
  fi
  return 0
}
trap 'on_signal TERM 143' TERM
trap 'on_signal INT 130' INT
trap 'on_signal HUP 129' HUP
trap 'on_signal QUIT 131' QUIT

# C50 / H9: a quiet verify at a step boundary. Exit 1 and exit 2 alike mean the
# lock is lost, and the runner stops.
step_check() {
  if [ -n "\${GATE_LOCK_TEST_STEP:-}" ]; then
    : >"$GATE_LOCK_TEST_STEP" 2>/dev/null
    while [ -e "$GATE_LOCK_TEST_STEP" ]; do
      sleep 1
    done
  fi
  if ! GATE_LOCK_CALLER_PID=$$ GATE_LOCK_SLOT_PATH=$pin "$bin" verify "$lane"; then
    printf 'runner: lock lost at step %s\\n' "$1" >&2
    finish 1
  fi
  return 0
}

finish() {
  code=$1
  if [ -n "$step_pid" ]; then
    kill -TERM "$step_pid" 2>/dev/null
    wait "$step_pid" 2>/dev/null
    step_pid=
  fi
  release_lock
  if [ -n "$sig" ]; then
    code=$sig_code
  fi
  exit "$code"
}

# C46: acquire with the runner's own pid and a private slot-out file, and
# propagate a non-zero acquire exit as the runner's own.
GATE_LOCK_CALLER_PID=$$ GATE_LOCK_SLOT_OUT=$out "$bin" acquire "$lane"
acq=$?
if [ "$acq" -ne 0 ]; then
  rm -f "$out"
  exit "$acq"
fi
pin=$(cat "$out")
if [ -z "$pin" ]; then
  printf 'runner: FAILED to record the slot path\\n' >&2
fi
if [ -n "$sig" ]; then
  finish "$sig_code"
fi

# C48: the runner's own heartbeat loop, so it can watch the steps itself.
beat_loop &
beat_pid=$!

step_status=0
if [ -n "\${GATE_LOCK_TEST_STEP_CMD:-}" ]; then
  step_check before
  if [ -n "\${GATE_LOCK_TEST_STEP_OUT:-}" ]; then
    sh -c "$GATE_LOCK_TEST_STEP_CMD" >"$GATE_LOCK_TEST_STEP_OUT" 2>&1 &
  else
    sh -c "$GATE_LOCK_TEST_STEP_CMD" &
  fi
  step_pid=$!
  before=$sig_seen
  while :; do
    wait "$step_pid"
    st=$?
    step_pid=
    if [ "$sig_seen" != "$before" ]; then
      finish "$sig_code"
    fi
    if [ "$st" -le 128 ]; then
      step_status=$st
      step_check after
      break
    fi
  done
fi

finish "$step_status"
`;

/** A private directory the runner may put its private slot-out file in. */
function runnerTmp(pool) {
  const dir = path.join(scratchOf(pool), 'runner-tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write the runner into the pool's scratch and start it. */
function startRunner(pool, lane, env = {}) {
  const script = path.join(scratchOf(pool), 'runner.sh');
  fs.writeFileSync(script, RUNNER);
  fs.chmodSync(script, 0o700);
  // `bin` is the program the harness runs under the test shell: here the runner
  // itself, not the tool.
  return startBin([lane], {
    bin: script,
    cwd: wtDir(pool, 'wt0'),
    env: {
      GATE_LOCK_DIR: pool,
      // The runner's own seams are GATE_LOCK_TEST_* too, so test mode is on:
      // without it the tool warns about them and ignores them.
      GATE_LOCK_TEST_MODE: '1',
      GATE_LOCK_TEST_RUNNER_BIN: BIN,
      GATE_LOCK_TEST_RUNNER_TMP: runnerTmp(pool),
      ...env,
    },
  });
}

/** No private file of the runner's is left behind. */
const noPrivateFiles = (pool) =>
  expect(listing(runnerTmp(pool)).filter((l) => l.includes('gate-lock-runner'))).toEqual([]);

describe('T108 a green runner', () => {
  it('T108 reports the release once, never a refusal, and exits with its step status', async () => {
    const pool = freshPool();
    const runner = startRunner(pool, 'lane', { GATE_LOCK_TEST_STEP_CMD: 'exit 0' });
    const r = await runner.done;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by lane');
    expect(r.stdout.match(/released by lane/g)).toHaveLength(1);
    expect(r.stderr).not.toContain('refused');
    expect(r.stderr).not.toContain('FAILED');
    expect(names(pool)).toEqual(['.format']);
    noPrivateFiles(pool);
  });

  it('T108 the runner status is its step status, and the lock comes back either way', async () => {
    const pool = freshPool();
    const runner = startRunner(pool, 'lane', { GATE_LOCK_TEST_STEP_CMD: 'exit 7' });
    const r = await runner.done;
    expect(r.status).toBe(7);
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
  });

  it('C50 a step boundary check calls verify, and a lost lock stops the runner non-zero', async () => {
    const pool = freshPool();
    const step = path.join(scratchOf(pool), 'step');
    // The step takes the lock away, so the check after it cannot pass. The seam
    // parks before every check, so the test lets each one go in turn.
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_STEP: step,
      GATE_LOCK_TEST_STEP_CMD: 'rm -rf "$GATE_LOCK_DIR/gate.lock"',
    });
    await waitForFile(step);
    fs.rmSync(step, { force: true });
    await waitForFile(step);
    fs.rmSync(step, { force: true });
    const r = await runner.done;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('lock lost');
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T109 a busy runner', () => {
  it('T109 prints one line and nothing else on a refused acquire, and exits 75', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const runner = startRunner(pool, 'lane');
    const r = await runner.done;
    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr.match(/busy/g)).toHaveLength(1);
    expect(r.stderr).toContain('holder');
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder');
    noPrivateFiles(pool);
  });
});

describe('T107 a lock the runner could not name', () => {
  it('T107 is still released, with a failure message, and nothing is left behind', async () => {
    const pool = freshPool();
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_NO_SLOT: '1',
      GATE_LOCK_TEST_STEP_CMD: 'exit 0',
    });
    const r = await runner.done;
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('FAILED');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    noPrivateFiles(pool);
  });
});

describe('T103 a runner signalled while its release is parked', () => {
  it('T103 still releases and says so, and exits 143', async () => {
    const pool = freshPool();
    const parked = path.join(scratchOf(pool), 'release-hook');
    const ready = path.join(scratchOf(pool), 'step-ready');
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_MODE: '1',
      GATE_LOCK_TEST_STEP_CMD: LONG_STEP(ready),
      GATE_LOCK_TEST_PAUSE_BEFORE_RELEASE: parked,
    });
    await waitForFile(ready);
    runner.child.kill('SIGTERM');
    // The release is parked just before it removes what it moved aside (H7), so
    // the slot name is free and the lock is not yet given back: the runner is
    // still holding it, in the copy it has not deleted.
    await waitForFile(parked);
    const asides = names(pool).filter((n) => n.startsWith('gate.lock.reclaim'));
    expect(asides).toHaveLength(1);
    expect(readSlot(pool, asides[0]).owner).toBe('lane');
    // A second signal must not cut the cleanup (C40, C49).
    runner.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    expect(names(pool).filter((n) => n.startsWith('gate.lock.reclaim'))).toHaveLength(1);
    expect(runner.child.exitCode).toBe(null);
    fs.rmSync(parked, { force: true });
    const r = await runner.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    noPrivateFiles(pool);
  });
});

describe('T104 a runner signalled while its acquire child runs', () => {
  it('T104 still releases the slot the child went on to win, and the pin file is removed', async () => {
    const pool = freshPool();
    const parked = path.join(scratchOf(pool), 'create-hook');
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_MODE: '1',
      GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: parked,
    });
    // The acquirer is parked just before the rename, so it has won nothing yet.
    await waitForFile(parked);
    runner.child.kill('SIGTERM');
    // Let the acquire finish: it wins the name and records it.
    fs.rmSync(parked, { force: true });
    const r = await runner.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('acquired by lane');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    noPrivateFiles(pool);
  });
});

describe('T105 a runner signalled while stopping its heartbeat', () => {
  it('T105 still gives the lock back', async () => {
    const pool = freshPool();
    const running = path.join(scratchOf(pool), 'handler-running');
    const go = path.join(scratchOf(pool), 'handler-go');
    const ready = path.join(scratchOf(pool), 'step-ready');
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_HANDLER_RUNNING: running,
      GATE_LOCK_TEST_HANDLER_GO: go,
      GATE_LOCK_TEST_STEP_CMD: LONG_STEP(ready),
    });
    // Wait for the step, so the heartbeat loop is certainly running.
    await waitForFile(ready);
    runner.child.kill('SIGTERM');
    // The loop's TERM handler is parked: the runner must still be holding.
    await waitForFile(running);
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane');
    fs.writeFileSync(go, 'go\n');
    const r = await runner.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T106 a runner signalled during a captured step', () => {
  it('T106 reports the release on its original stdout, not in the step capture', async () => {
    const pool = freshPool();
    const capture = path.join(scratchOf(pool), 'capture');
    const ready = path.join(scratchOf(pool), 'step-ready');
    const runner = startRunner(pool, 'lane', {
      GATE_LOCK_TEST_STEP_OUT: capture,
      GATE_LOCK_TEST_STEP_CMD: LONG_STEP(ready),
    });
    await waitForFile(ready);
    const step = track(Number(fs.readFileSync(ready, 'utf8')));
    runner.child.kill('SIGTERM');
    const r = await runner.done;
    expect(r.status).toBe(143);
    // The release is on the runner's own stdout...
    expect(r.stdout).toContain('released by lane');
    // ...and the step's output stayed in the step's own capture.
    expect(fs.readFileSync(capture, 'utf8')).toBe('step says hi\n');
    await waitForDead(step);
  });
});
