// GL3: signals and the heartbeat supervisor - spec 6.D (T25-T31, T35, T36),
// R7, R8, D10 and D15. Every window is a pause seam or a handshaked file; no
// test synchronises with a sleep. The two shells that differ in what they defer
// and when (T112) are checked inside T112 itself, and CI runs the whole suite
// under each of them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listing, scratchOf, waitForFile } from './harness.js';
import { TM, livePid, names, readSlot, until } from './slots.js';
import {
  HAS_PGREP,
  beatHook,
  beatPids,
  blocker,
  childrenMatching,
  freshPool,
  runDirOf,
  runOnce,
  script,
  startRun,
  stopped,
  traceText,
  track,
  untilTraced,
  waitHelperGone,
  up,
  waitForDead,
  waitRunGone,
} from './run.js';

/** Is `shell` (e.g. "bash --posix") installed and runnable here? */
function hasShell(shell) {
  const [cmd, ...args] = shell.split(/\s+/).filter(Boolean);
  const r = spawnSync(cmd, [...args, '-c', 'exit 0'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

/** A run waiting on its command, ready to be signalled. */
async function signalledRun(pool, { name = 'victim', env = {}, shell } = {}) {
  const block = blocker(pool, name);
  const gate = startRun(pool, 'lane', block.cmd, {
    shell,
    env: { GATE_LOCK_HEARTBEAT_SECONDS: '1', ...env },
  });
  await up(block);
  return { block, gate, pid: track(block.pid()) };
}

/** Wait until the beat has moved off the start time: the loop is running. */
async function beatMoved(pool, started, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readSlot(pool, 'gate.lock').beat !== started) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the heartbeat never moved the beat');
}

/** Is this pid gone? Used for the heartbeat loop, never for a child of a wait. */
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * A live view of a child's stdout, for text it has printed by now and will print
 * later: the harness has a listener of its own on the same stream from the moment it
 * starts, so a view that attaches later would miss whatever was printed before it -
 * and the heartbeat line is printed before a test's first handshake can be waiting.
 * Attach this as soon as the child is started, and read it whenever.
 */
function liveStdout(child) {
  let text = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    text += d;
  });
  return () => text;
}

/** The staged beats in a pool, by the tool's own name pattern (F39). */
const stagedBeats = (pool) =>
  names(pool).filter((n) => /^gate\.lock(\.\d+)?\.beatnew\.\d+$/.test(n));

/** The trace lines that say a refresh was begun, in order. */
const refreshesIn = (file) =>
  traceText(file)
    .split('\n')
    .filter((line) => line.includes('refreshing ') && line.includes('inflight published'));

/**
 * Is there a run's private directory under `root` that holds `name`? The temp
 * root seam lets a test point a run's scratch somewhere it owns, so what the
 * watchdog publishes there can be read while the run is still tearing down.
 */
function runDirWith(root, name) {
  if (!fs.existsSync(root)) return false;
  return fs
    .readdirSync(root)
    .filter((n) => n.startsWith('gate-lock-run.'))
    .some((n) => fs.existsSync(path.join(root, n, name)));
}

/** A wrapped command that traps TERM and takes two seconds to stop. */
function slowCommand(pool, dir, extra = 'TERM') {
  fs.mkdirSync(dir, { recursive: true });
  return [
    script(
      pool,
      `${path.basename(dir)}.sh`,
      `trap 'sleep 2; printf "stopped\\n" >"${dir}/stopped"; exit 0' ${extra}
printf '%s\\n' "$$" >"${dir}/ready"
i=0
while [ "$i" -lt 600 ]; do
  i=$((i + 1))
  sleep 1
done`,
    ),
  ];
}

describe('T26 / T27 / D15 one signal', () => {
  it('T26 TERM to run exits 143, prints released by, removes the slot, reaps the heartbeat and kills the command', async () => {
    const pool = freshPool();
    const { block, gate, pid } = await signalledRun(pool);
    // The loop is running before the signal, so reaping the heartbeat is about a
    // live loop rather than an idle one.
    await beatMoved(pool, readSlot(pool, 'gate.lock').started);
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
    await waitForDead(pid);
    expect(fs.existsSync(block.done)).toBe(false);
    expect(beatPids(r.stdout).length).toBeGreaterThan(0);
    for (const loop of beatPids(r.stdout)) expect(gone(loop)).toBe(true);
  });

  it('T27 INT to run exits 130 with the same cleanup, and the command is stopped (INT is forwarded as TERM)', async () => {
    const pool = freshPool();
    const { block, gate, pid } = await signalledRun(pool);
    gate.child.kill('SIGINT');
    const r = await gate.done;
    expect(r.status).toBe(130);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
    await waitForDead(pid);
    expect(fs.existsSync(block.done)).toBe(false);
  });

  it('D15 HUP exits 129 and QUIT exits 131: both handled as TERM, TERM is what is forwarded', async () => {
    for (const [signal, code] of [
      ['SIGHUP', 129],
      ['SIGQUIT', 131],
    ]) {
      const pool = freshPool();
      const { gate, pid } = await signalledRun(pool, { name: `victim-${code}` });
      gate.child.kill(signal);
      const r = await gate.done;
      expect(r.status, signal).toBe(code);
      expect(r.stdout, signal).toContain('released by lane');
      expect(r.stderr, signal).toBe('');
      expect(names(pool), signal).toEqual(['.format']);
      await waitForDead(pid);
    }
  });
});

describe('C40 a command that will not stop', () => {
  it('D15 a command that ignores TERM is KILLed after the grace, so a signalled run always ends', async () => {
    const pool = freshPool();
    // The command deafens itself to TERM. Only the KILL the run escalates to can
    // stop it, and without that escalation this run waits for ever - which is
    // what a review probe of this shape caught.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_HEARTBEAT_SECONDS: '1', GATE_LOCK_TEST_KILL_GRACE: '2' },
    });
    await up(block);
    const victim = track(block.pid());
    gate.child.kill('SIGTERM');
    const started = Date.now();
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(Date.now() - started).toBeLessThan(30000);
    // The command is stopped, and the lock comes back.
    await waitForDead(victim, 10000);
    expect(fs.existsSync(block.done)).toBe(false);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
  }, 60_000);

  it('D15 a signal into a run that is waiting still leaves the tool own lines on the caller stderr', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    // The command deafens itself to TERM and takes its own slot away, so the loop's
    // next refresh fails *while* the run sits in the wait for that command: the
    // refusal is a line of the tool's own, written by the heartbeat through the
    // stderr it inherited. The signal then ends the run through the very same wait,
    // whose stderr is turned away so the shell cannot put a job notice there. Both
    // halves are the property: what the tool says still arrives, what the shell says
    // about itself does not.
    const trace = path.join(scratchOf(pool), 'trace.log');
    const block = blocker(pool, 'deaf', { ignoreTerm: true, pre: 'rm -rf "$2"', args: [slot] });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    await up(block);
    const victim = track(block.pid());
    await until(() => !fs.existsSync(slot));
    // The failed refresh is waited for, not assumed: the slot being gone only says it
    // *can* fail, and a run that is asked to stop first takes its stop file on its next
    // tick and ends without ever refreshing - so the line this test is about would be
    // missing whenever the signal arrived inside that second. The trace says the refresh
    // has failed, which is what puts the refusal on the run's stderr.
    await untilTraced(() => /refresh status 1/.test(traceText(trace)), trace, 20000);
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status, traceText(trace)).toBe(143);
    expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toContain(
      'heartbeat: no lock',
    );
    expect(r.stderr).not.toContain('Killed');
    await waitForDead(victim, 10000);
  }, 60_000);

  it('D15 a line the signal handler writes while the run waits reaches the caller stderr', async () => {
    const pool = freshPool();
    // The handler runs while this run is inside the wait for a command that is not
    // going to end, and that wait has the shell's own stderr turned away so the
    // shell's notices cannot land there. The line the handler writes has to arrive
    // all the same, and the only way that is true is the descriptor the run kept its
    // own stderr on: a message written to the plain fd 2 from inside that wait goes
    // nowhere. Round 12 shipped this test without the wiring and it passed anyway,
    // because the line it watched was the heartbeat's - written by another process
    // through the descriptor that process opened for itself, which no redirection
    // in this one can touch. This line is written by this process, in the handler.
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_SIGNAL_LINE: 'the handler is here',
      },
    });
    await up(block);
    const victim = track(block.pid());
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stderr, JSON.stringify(r.stderr)).toContain('gate-lock: the handler is here');
    await waitForDead(victim, 10000);
  }, 60_000);

  it('D15 a second signal of any kind after the first is ignored: 143, the lock released, nothing killed', async () => {
    // The watchdog this run arms when it forwards the TERM must not take the
    // run's own signal handling with it: a run whose traps were replaced would
    // stop being able to answer a signal at all, which is not what D15 says.
    for (const second of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
      const pool = freshPool();
      // The command records that the forwarded TERM arrived and then keeps
      // unwinding for a moment. That is the handshake: without it the second
      // signal can be pending before the shell has run the first handler, and
      // shells run pending handlers in signal-number order, so "the first signal"
      // from this test's side would not be the first one the run handled.
      const dir = path.join(scratchOf(pool), `second-${second}`);
      fs.mkdirSync(dir, { recursive: true });
      const cmd = [
        script(
          pool,
          `mark-term-${second}.sh`,
          `trap 'printf got >"${dir}/got"; sleep 1; exit 0' TERM
printf '%s\\n' "$$" >"${dir}/ready"
i=0
while [ "$i" -lt 600 ]; do
  i=$((i + 1))
  sleep 1
done`,
        ),
      ];
      const gate = startRun(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
      await waitForFile(path.join(dir, 'ready'));
      const victim = track(Number(fs.readFileSync(path.join(dir, 'ready'), 'utf8')));
      gate.child.kill('SIGTERM');
      // The first signal has been forwarded and taken effect; only now is the
      // second one a *second* signal.
      //
      // Thirty seconds, not the harness's ten. This handshake is the whole chain of
      // the signal path on a loaded runner: the run's shell runs its handler between
      // two commands, the handler signals the command, and the command's own shell
      // runs *its* handler when the `sleep` it is inside ends or is interrupted, and
      // then writes this file. macOS CI timed the ten-second default out here on the
      // SIGHUP leg of this loop, with nothing skipped and nothing deferred: no path
      // in the forward can lose the TERM (it is sent from the handler, retried after
      // the command is forked if the signal arrived first, and the command is still
      // this run's child), so what was left was the budget for four runs on a
      // two-core runner. The loop runs four signals, so the whole test has its own
      // budget below as well.
      await waitForFile(path.join(dir, 'got'), 30000);
      gate.child.kill(second);
      const r = await gate.done;
      expect(r.status, second).toBe(143);
      expect(r.signal, second).toBe(null);
      expect(r.stdout, second).toContain('released by lane');
      expect(r.stderr, second).toBe('');
      expect(names(pool), second).toEqual(['.format']);
      await waitForDead(victim);
    }
  }, 90_000);

  it('D10 the watchdog is gone once a signalled run ends', async () => {
    const pool = freshPool();
    // The private directory is named from the temp root, which a test can point
    // somewhere it owns, so the watchdog's published pids can be read while the
    // run is still tearing down.
    const tmpRoot = path.join(scratchOf(pool), 'tmp-root');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    const env = {
      ...TM,
      GATE_LOCK_HEARTBEAT_SECONDS: '1',
      GATE_LOCK_TEST_KILL_GRACE: '3',
      GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
    };

    // (a) The watchdog fires: it ignored TERM itself, so it has slept the whole
    // grace and killed the command, and its own second is long gone.
    {
      const deaf = blocker(pool, 'deaf', { ignoreTerm: true });
      const gate = startRun(pool, 'lane', deaf.cmd, { env });
      await up(deaf);
      track(deaf.pid());
      gate.child.kill('SIGTERM');
      await until(() => runDirWith(tmpRoot, 'escalator.pid'), 15000);
      const [name] = fs.readdirSync(tmpRoot).filter((n) => n.startsWith('gate-lock-run.'));
      const dir = path.join(tmpRoot, name);
      const watchPid = Number(fs.readFileSync(path.join(dir, 'escalator.pid'), 'utf8'));
      expect(Number.isInteger(watchPid)).toBe(true);
      const r = await gate.done;
      // The run was signalled, so the signal's own code is what it answers with -
      // the lock was lost as well, and a signal outranks that.
      expect(r.status).toBe(143);
      expect(r.stdout).toContain('released by lane');
      expect(stopped(watchPid), 'the watchdog outlived the run').toBe(true);
      expect(fs.existsSync(dir)).toBe(false);
    }

    // (b) The watchdog is cancelled, because the command stopped on its own. It
    // has to go with the run: nothing of ours may outlive it. The command takes
    // two seconds to stop, so the watchdog is still armed while the test reads
    // the pid it published.
    {
      const dir = path.join(scratchOf(pool), 'slow-cancel');
      // A long grace, so the watchdog is still sleeping when the cancel runs:
      // the cancel happens after the supervisor has stopped, so it comes later
      // than the signal does.
      const gate = startRun(pool, 'lane', slowCommand(pool, dir), {
        env: { ...env, GATE_LOCK_TEST_KILL_GRACE: '10' },
      });
      await waitForFile(path.join(dir, 'ready'));
      const victim = track(Number(fs.readFileSync(path.join(dir, 'ready'), 'utf8')));
      gate.child.kill('SIGTERM');
      await until(() => runDirWith(tmpRoot, 'escalator.pid'), 15000);
      const [name] = fs.readdirSync(tmpRoot).filter((n) => n.startsWith('gate-lock-run.'));
      const runDir2 = path.join(tmpRoot, name);
      const watchPid = Number(fs.readFileSync(path.join(runDir2, 'escalator.pid'), 'utf8'));
      const r = await gate.done;
      expect(r.status).toBe(143);
      await waitForDead(victim);
      expect(stopped(watchPid), 'the watchdog outlived the run').toBe(true);
      expect(fs.existsSync(runDir2)).toBe(false);
      expect(names(pool)).toEqual(['.format']);
    }
  }, 90_000);

  it('D10 a watchdog whose run is gone leaves the command alone and is gone itself', async () => {
    const pool = freshPool();
    const tmpRoot = path.join(scratchOf(pool), 'tmp-root');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
      },
    });
    await up(block);
    const victim = track(block.pid());
    const dir = path.join(tmpRoot, `gate-lock-run.${gate.child.pid}`);
    gate.child.kill('SIGTERM');
    await waitForFile(path.join(dir, 'escalator.pid'), 15000);
    const watchPid = Number(fs.readFileSync(path.join(dir, 'escalator.pid'), 'utf8'));
    // KILL the run itself: the lock is now nobody's, and the command's pid may be
    // reused at any moment. The watchdog must notice that its run is gone and leave
    // the command alone rather than aim a KILL at a stranger - and it must go, rather
    // than sit on an armed KILL for a run that is not coming back.
    gate.child.kill('SIGKILL');
    // The watchdog's own word that it is gone, with a generous bound - not a poll of
    // process absence, which is a poll of a guess: this watchdog is nobody's child
    // after the KILL above, so whether its pid is still a process is a question about
    // who reaps an orphan rather than about the watchdog.
    await waitHelperGone(dir, 'escalator.gone', watchPid, { timeoutMs: 60000 });
    expect(stopped(watchPid), 'the watchdog outlived its run').toBe(true);
    // The command is stopped all the same, and by the supervisor: a run that is gone
    // is a run whose lock is about to be lost, which is D10's case, and nothing else
    // would stop the command or escalate to a KILL. Before round 13 the watchdog was
    // the only thing that could, and this test used the command's survival to watch
    // it not fire; the supervisor is what fires now, and the watchdog's own rule is
    // what the two assertions above say.
    // The supervisor is still inside that grace when the command ends, and it writes
    // into this run's private directory on the way out - so the test waits for it to
    // leave, and for the directory it removes to go with it. Removing it earlier is
    // what macOS CI saw: ENOTEMPTY, a helper writing into a directory being removed.
    await waitRunGone(gate, { tmpRoot });
    expect(fs.existsSync(dir), 'the private directory outlived its run').toBe(false);
    await waitForDead(victim, 20000);
    expect(stopped(victim), 'the command outlived the run and its lock').toBe(true);
  }, 90_000);
  it('D15 a run signalled while its helpers are still starting still answers with the signal code', async () => {
    // The macOS regression: a run that was signalled came to answer 0, because a
    // TERM into a helper subshell that was still building itself reached bash 3.2's
    // `run_pending_traps` defect. Nothing here signals a helper any more, and this
    // says the part that matters whatever the shell: the exit status is the
    // signal's own, the lock comes back, and nothing of the run is left behind.
    const pool = freshPool();
    const { gate, pid } = await signalledRun(pool, { name: 'starting' });
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.signal).toBe(null);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
    await waitForDead(pid);
    expect(beatPids(r.stdout).every((loop) => gone(loop))).toBe(true);
  }, 60_000);
});

describe('C49 a signal aimed at a child of run', () => {
  // A terminal sends INT (or TERM) to the whole foreground process group, so a
  // second Ctrl-C can reach the acquire or the release of a run that is ignoring
  // signals itself. The acquire and the release have to survive it: one that dies
  // mid-flight leaves the lock to be reclaimed rather than released.
  const aimed = it.skipIf(!HAS_PGREP);

  aimed(
    'C49 INT to the release child cannot lose the lock: the release finishes and the pool is clean',
    async () => {
      const pool = freshPool();
      const hook = path.join(scratchOf(pool), 'release-hook');
      const gate = startRun(pool, 'lane', ['sh', '-c', 'exit 0'], {
        env: {
          ...TM,
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_PAUSE_BEFORE_RELEASE: hook,
        },
      });
      try {
        // The release is parked just before it removes what it moved aside (H7).
        await waitForFile(hook);
        const release = childrenMatching(gate.child.pid, ' release ');
        expect(release).toHaveLength(1);
        process.kill(Number(release[0]), 'SIGINT');
        fs.rmSync(hook, { force: true });
        const r = await gate.done;
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('released by lane');
        expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
        expect(names(pool)).toEqual(['.format']);
      } finally {
        fs.rmSync(hook, { force: true });
      }
    },
    60_000,
  );

  aimed(
    'C49 INT to the acquire child cannot lose the lock: the acquire finishes and the slot is released',
    async () => {
      const pool = freshPool();
      const hook = path.join(scratchOf(pool), 'create-hook');
      const gate = startRun(pool, 'lane', ['sh', '-c', 'exit 0'], {
        env: {
          ...TM,
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook,
        },
      });
      try {
        // The acquire is parked just before it renames its candidate onto the
        // slot name (H2).
        await waitForFile(hook);
        const acquire = childrenMatching(gate.child.pid, ' acquire ');
        expect(acquire).toHaveLength(1);
        process.kill(Number(acquire[0]), 'SIGINT');
        fs.rmSync(hook, { force: true });
        const r = await gate.done;
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('acquired by lane');
        expect(r.stdout).toContain('released by lane');
        expect(names(pool)).toEqual(['.format']);
      } finally {
        fs.rmSync(hook, { force: true });
      }
    },
    60_000,
  );
  aimed(
    'C49 a KILL to the acquire child cannot leak the lock either: the run gives it back by lane and pid (C49)',
    async () => {
      const pool = freshPool();
      const hook = path.join(scratchOf(pool), 'kill-hook');
      const status = path.join(scratchOf(pool), 'kill-status');
      const gate = startRun(pool, 'lane', ['sh', '-c', 'exit 0'], {
        args: ['--status-file', status],
        env: {
          ...TM,
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook,
        },
      });
      try {
        await waitForFile(hook);
        const acquire = childrenMatching(gate.child.pid, ' acquire ');
        expect(acquire).toHaveLength(1);
        // KILL is the one signal the shield cannot stop, and the one a caller
        // reaches for. The acquire dies without recording anything, so the run
        // has to give the slot back from the only names it has.
        process.kill(Number(acquire[0]), 'SIGKILL');
        fs.rmSync(hook, { force: true });
        const r = await gate.done;
        expect(r.status).toBe(137);
        expect(r.stderr).toContain('the acquire was stopped before it recorded the slot');
        expect(r.stdout).toContain('nothing to release');
        expect(fs.readFileSync(status, 'utf8')).toBe('tool:137\n');
        // No slot is left held. A candidate the killed acquire had already made is
        // a transient, and the janitor owns those (D16).
        expect(names(pool).filter((n) => /^gate\.lock(\.\d+)?$/.test(n))).toEqual([]);
      } finally {
        fs.rmSync(hook, { force: true });
      }
    },
    60_000,
  );
});

describe('T28 / T29 a second signal', () => {
  it('T28 two TERMs 500ms apart still release, reap and exit 143', async () => {
    const pool = freshPool();
    const { gate, pid } = await signalledRun(pool);
    gate.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
    await waitForDead(pid);
  });

  it('T29 two INTs likewise exit 130', async () => {
    const pool = freshPool();
    const { gate, pid } = await signalledRun(pool);
    gate.child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    gate.child.kill('SIGINT');
    const r = await gate.done;
    expect(r.status).toBe(130);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
    await waitForDead(pid);
  });
});

describe('T30 / T31 / R8c the lock is held until the command has stopped', () => {
  it('T30 a command that traps TERM and takes two seconds to stop writes its marker before the slot disappears (TERM 143, INT 130)', async () => {
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ]) {
      const pool = freshPool();
      const dir = path.join(scratchOf(pool), `slow-${code}`);
      const cmd = slowCommand(pool, dir);
      const gate = startRun(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
      await waitForFile(path.join(dir, 'ready'));
      const victim = track(Number(fs.readFileSync(path.join(dir, 'ready'), 'utf8')));
      gate.child.kill(signal);
      // Sample through the teardown: whenever the slot is gone, the command's
      // marker must already be there. The lock is not handed on while the
      // command can still be writing.
      const race = { samples: 0, bad: 0 };
      const sampler = setInterval(() => {
        race.samples += 1;
        if (
          !fs.existsSync(path.join(pool, 'gate.lock')) &&
          !fs.existsSync(path.join(dir, 'stopped'))
        ) {
          race.bad += 1;
        }
      }, 20);
      const r = await gate.done;
      clearInterval(sampler);
      expect(r.status, signal).toBe(code);
      expect(fs.existsSync(path.join(dir, 'stopped')), signal).toBe(true);
      expect(names(pool), signal).toEqual(['.format']);
      expect(race.samples).toBeGreaterThan(0);
      expect(race.bad, signal).toBe(0);
      await waitForDead(victim);
    }
  });

  it('T31 a second signal during that teardown still releases and reaps', async () => {
    for (const [signal, code, trap] of [
      ['SIGTERM', 143, 'TERM'],
      ['SIGINT', 130, 'TERM INT'],
    ]) {
      const pool = freshPool();
      const dir = path.join(scratchOf(pool), `slow2-${code}`);
      const cmd = slowCommand(pool, dir, trap);
      const gate = startRun(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
      await waitForFile(path.join(dir, 'ready'));
      const victim = track(Number(fs.readFileSync(path.join(dir, 'ready'), 'utf8')));
      gate.child.kill(signal);
      await new Promise((r) => setTimeout(r, 500));
      gate.child.kill(signal);
      const r = await gate.done;
      expect(r.status, signal).toBe(code);
      expect(r.stdout, signal).toContain('released by lane');
      expect(fs.existsSync(path.join(dir, 'stopped')), signal).toBe(true);
      expect(names(pool), signal).toEqual(['.format']);
      await waitForDead(victim);
    }
  });
});

describe('T25 / R6 the beat is never empty or missing', () => {
  it('T25 a reader hammering the beat under a run sees neither an empty nor a missing value, and the run then exits 143', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    const { gate, pid } = await signalledRun(pool);
    const reads = { total: 0, empty: 0, missing: 0 };
    let stopping = false;
    const hammer = (async () => {
      while (!stopping) {
        for (let k = 0; k < 200; k += 1) {
          try {
            const value = fs.readFileSync(path.join(slot, 'beat'), 'utf8');
            reads.total += 1;
            if (value.replace(/\n/g, '') === '') reads.empty += 1;
          } catch {
            reads.missing += 1;
          }
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await beatMoved(pool, readSlot(pool, 'gate.lock').started);
    // The reader stops while the slot is still there: the release at the end of
    // the run removes the file, and a missing beat after that is the run's exit,
    // not a reader that saw a hole (R6).
    stopping = true;
    await hammer;
    expect(reads.total).toBeGreaterThan(500);
    expect(reads.empty).toBe(0);
    expect(reads.missing).toBe(0);
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    await waitForDead(pid);
  });
});

describe('T35 / R7 / T36 release waits for an in-flight refresh', () => {
  it('T35 a refresh parked before its rename holds the slot until it completes: still there 1.5s after the signal, then 143 with an empty stderr', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const parked = blocker(pool, 'parked');
    const gate = startRun(pool, 'lane', parked.cmd, {
      env: {
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
      },
    });
    await waitForFile(hook.seam);
    gate.child.kill('SIGTERM');
    // The parked refresh has not landed, so the slot is still on disk and the
    // release cannot have happened (C41, R7).
    await new Promise((r) => setTimeout(r, 1500));
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane');
    hook.release();
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    expect(hook.reparked(), 'a later refresh parked on the released seam').toBe(false);
    expect(gone(beatPids(r.stdout)[0])).toBe(true);
  });

  it('R7 a refresh parked at the seam is the only one: one refresh, and the loop ends clean', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const parked = blocker(pool, 'parked');
    const trace = path.join(scratchOf(pool), 'trace.log');
    const gate = startRun(pool, 'lane', parked.cmd, {
      env: {
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    // The one refresh this test parks, waiting at the rename.
    await waitForFile(hook.seam);
    gate.child.kill('SIGTERM');
    // The ask is the handshake: the supervisor traces every ask, and it makes one only
    // once the teardown has got as far as stopping the heartbeat. Waiting for that line
    // rather than for a second is what makes the rest of this test a fact about the tool
    // and not about how fast this host is.
    await until(() => /asks loop \d+ \(1\)/.test(traceText(trace)), 20000);
    // Only now is the parked refresh let go, with the loop already asked to stop. It may
    // finish it - a refresh in flight is never cut short (C41, R7) - and then it is
    // done: a stop is asked for and never unasked, so no refresh may begin after it.
    // This is the shape macOS CI reported, where a second refresh was begun against a
    // slot that was on its way out and left a staged beat behind.
    hook.release();
    const r = await gate.done;
    expect(refreshesIn(trace), traceText(trace)).toHaveLength(1);
    expect(traceText(trace), traceText(trace)).toContain('exiting 0');
    expect(hook.reparked(), 'a second refresh parked on the released seam').toBe(false);
    expect(r.status, traceText(trace)).toBe(143);
    expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toBe('');
    expect(r.stdout, traceText(trace)).toContain('released by lane');
    expect(names(pool), traceText(trace)).toEqual(['.format']);
  }, 60_000);

  it('R7 a loop asked to stop on its way into a refresh starts no refresh at all', async () => {
    const pool = freshPool();
    const block = blocker(pool, 'parked');
    const trace = path.join(scratchOf(pool), 'trace.log');
    const tmpRoot = scratchOf(pool);
    // The wedge seam parks the loop in the one place where it has already read its
    // stop file for this pass and has not yet begun the refresh - which is the whole
    // window a stop has to be read in twice for. The seam sits between them on
    // purpose: parked there, the loop's second reading of the stop file is the only
    // thing between it and a refresh nobody asked for.
    const wedge = path.join(tmpRoot, 'loop-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_LOOP_WEDGE: wedge,
        GATE_LOCK_TEST_TRACE: trace,
        GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
      },
    });
    const printed = liveStdout(gate.child);
    await up(block);
    // The run announces its loop before the loop can do anything, and the command
    // coming up says nothing about the heartbeat - so the announcement is waited for,
    // not assumed to have been printed already.
    await until(() => beatPids(printed()).length > 0, 10000);
    const loop = beatPids(printed())[0];
    expect(loop, printed()).toBeGreaterThan(0);
    const beatAlive = path.join(runDirOf(gate.child.pid, tmpRoot), 'beat-alive');
    // The loop is parked: it has ticked, and its tick file has stopped moving while it
    // is still alive. That is the same quiet the supervisor reads, polled here rather
    // than waited out, so the stop file below is written while the loop is inside the
    // wedge and not before it.
    let mark = null;
    await until(() => {
      const now = fs.existsSync(beatAlive) ? fs.readFileSync(beatAlive, 'utf8') : '';
      if (mark !== null && now === mark) return true;
      mark = now;
      return false;
    }, 10000);
    // Asked, not signalled: this is the file `run` writes when it stops the heartbeat,
    // written here so that the ask is in the past by the time the loop goes on.
    fs.writeFileSync(path.join(runDirOf(gate.child.pid, tmpRoot), 'loop.stop'), '');
    // The wedge is a poll now, so taking the file away is what releases it - and it
    // releases the loop itself, one second later, instead of a KILL that could not
    // reach the sleep the loop was in the foreground of.
    fs.rmSync(wedge);
    // It can act in exactly one of two ways: end, or refresh a slot whose run has
    // already been told the beat is not wanted.
    await until(() => refreshesIn(trace).length > 0 || /exiting 0/.test(traceText(trace)), 15000);
    expect(refreshesIn(trace), traceText(trace)).toEqual([]);
    block.release();
    const r = await gate.done;
    expect(r.status, traceText(trace)).toBe(0);
    // Nothing of the run's own is on stderr: it has nothing to report, and the sleep
    // this test used to kill is no longer there to be announced.
    expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toBe('');
    expect(r.stdout, traceText(trace)).toContain('released by lane');
    expect(names(pool), traceText(trace)).toEqual(['.format']);
    expect(gone(loop), traceText(trace)).toBe(true);
  }, 60_000);

  it('T36 a refresh held longer than the teardown bound is waited for, not cut off', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const parked = blocker(pool, 'parked');
    // The trace is the tool's own account of every decision it made: each loop exit
    // status, each heartbeat child's status and message, each ask, each KILL, the
    // restart, the verdict and the reason. This test has only ever failed on one
    // machine under load, so the trace goes into every assertion below - when it goes
    // red again, the reason is in there rather than in a guess.
    const trace = path.join(scratchOf(pool), 'trace.log');
    const gate = startRun(pool, 'lane', parked.cmd, {
      env: {
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    // The refresh is parked at the rename, which is where a teardown finds it if the
    // run is signalled now. The teardown's own bound is eight seconds, and this holds
    // the refresh for longer than that on purpose: the loop is not wedged, it is busy,
    // and a refresh in flight is never cut short (C41, R7). KILLing it there is what
    // made macOS CI report a lost lock for a run that held its lock throughout - the
    // loop died, the supervisor called it a lock this run could not account for, and
    // the run said so with the slot still its own. Holding the refresh is what makes
    // that race deterministic, so no CPU stress is needed to see it.
    await waitForFile(hook.seam);
    gate.child.kill('SIGTERM');
    const held = Date.now();
    // Ten seconds: past the teardown's own eight-second bound and past the three
    // asks the supervisor gives a loop that will not stop, with room to spare for a
    // loaded runner afterwards.
    await new Promise((r) => setTimeout(r, 10000));
    expect(gate.child.exitCode, `the run gave up on a refresh in flight\n${traceText(trace)}`).toBe(
      null,
    );
    hook.release();
    const r = await gate.done;
    expect(Date.now() - held).toBeLessThan(30000);
    expect(r.status, traceText(trace)).toBe(143);
    expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toBe('');
    expect(r.stdout, traceText(trace)).toContain('released by lane');
    expect(names(pool), traceText(trace)).toEqual(['.format']);
    // One parked refresh, which is what this test means: a seam that re-parked would
    // have taken a second refresh and the trace would say so.
    expect(refreshesIn(trace), traceText(trace)).toHaveLength(1);
    expect(hook.reparked(), 'a second refresh parked on the released seam').toBe(false);
    expect(gone(beatPids(r.stdout)[0])).toBe(true);
  }, 90_000);

  const aimed = it.skipIf(!HAS_PGREP);

  aimed(
    'D23 a heartbeat KILLed with its staged beat on disk leaves the pool clean, and says why',
    async () => {
      const pool = freshPool();
      const hook = beatHook(pool);
      // Deaf to TERM, and a grace long enough to matter: this run is still waiting for
      // its command for ten seconds after the refresh dies, so nothing of the run's own
      // cleanup can be what clears the pool in the seconds below. What has to clear it
      // is the loop that started the refresh.
      const block = blocker(pool, 'parked', { ignoreTerm: true });
      const gate = startRun(pool, 'lane', block.cmd, {
        env: {
          GATE_LOCK_TEST_MODE: '1',
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_KILL_GRACE: '10',
          GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        },
      });
      const printed = liveStdout(gate.child);
      await up(block);
      // The refresh is parked at the rename with its staged beat written beside the
      // slot, which is the window C23 is about: a heartbeat that dies there runs no
      // trap, so nothing of its own removes the file and the pool keeps a transient
      // that belongs to nobody. The child is found by what it is - the loop's own child
      // running `heartbeat` - and KILLed, which is the only way to end a process in the
      // middle of that window.
      await waitForFile(hook.seam);
      const loop = beatPids(printed())[0] ?? 0;
      expect(loop).toBeGreaterThan(0);
      await until(() => childrenMatching(loop, 'heartbeat').length > 0, 10000);
      const [child] = childrenMatching(loop, 'heartbeat');
      expect(stagedBeats(pool), 'the refresh is parked with its stage').toHaveLength(1);
      process.kill(Number(child), 'SIGKILL');
      // The stage goes at once, and while the run is still demonstrably busy with its
      // command: the loop that started the heartbeat sweeps the stages beside its own
      // slot once that heartbeat is gone, and `run` sweeps them again after the
      // release. The test below is what tells the two sweeps apart.
      await until(() => stagedBeats(pool).length === 0, 5000);
      expect(stagedBeats(pool), 'the stage outlived the heartbeat that wrote it').toEqual([]);
      hook.release();
      const r = await gate.done;
      // A refresh that died is a refresh that failed, so the run says the lock is lost
      // and answers 2 - that is the verdict, and it is right: nothing is beating the
      // slot any more. What it must not do is leave the stage behind.
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('lock lost');
      // C23: the child was KILLed, so it said nothing about why it failed, and a
      // non-zero heartbeat that says nothing is a failure nobody can act on. The loop
      // says it in its own words, with the status the child ended with - and what it
      // does not hand on is the line the child's own shell wrote about its bookkeeping,
      // which would otherwise be the only word the caller ever saw.
      expect(r.stderr).toMatch(/heartbeat: the refresh of .* failed with status 137/);
      expect(r.stderr, JSON.stringify(r.stderr)).not.toMatch(/^Killed$/m);
      expect(names(pool), 'the pool holds the marker and nothing else').toEqual(['.format']);
      await waitForDead(block.pid(), 10000);
    },
    60_000,
  );

  aimed(
    'D23 a loop KILLed with its staged beat on disk leaves the pool clean too',
    async () => {
      const pool = freshPool();
      const hook = beatHook(pool);
      const block = blocker(pool, 'parked');
      const gate = startRun(pool, 'lane', block.cmd, {
        env: {
          GATE_LOCK_TEST_MODE: '1',
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_KILL_GRACE: '2',
          GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        },
      });
      const printed = liveStdout(gate.child);
      await up(block);
      await waitForFile(hook.seam);
      const loop = beatPids(printed())[0] ?? 0;
      expect(loop).toBeGreaterThan(0);
      await until(() => childrenMatching(loop, 'heartbeat').length > 0, 10000);
      expect(stagedBeats(pool), 'the refresh is parked with its stage').toHaveLength(1);
      // Both ends of this refresh are KILLed, so nothing that wrote the file is left to
      // remove it: the heartbeat's own trap cannot run, the loop's sweep is an EXIT trap
      // and cannot run either, and there is no orphan left to fail its rename and clean
      // up after itself. The only thing that can clear the pool is `run`, sweeping the
      // stages beside the slot it is about to give back - which is what makes this the
      // test that tells the two sweeps apart.
      const [child] = childrenMatching(loop, 'heartbeat');
      process.kill(Number(child), 'SIGKILL');
      process.kill(loop, 'SIGKILL');
      expect(stagedBeats(pool), 'both ends of the refresh are gone, the stage is not').toHaveLength(
        1,
      );
      hook.release();
      block.release();
      const r = await gate.done;
      // The verdict is the one a hard stop now gets: unproven, and the slot is still
      // this run's, so the command's own status stands with the warning saying the
      // supervisor was stopped the hard way. The orphan of the KILLed loop may also
      // have said that it could not replace a beat in a slot that had gone, which is
      // its own news and not this run's to hide.
      expect(r.status, JSON.stringify(r.stderr)).toBe(0);
      expect(r.stderr).toContain('stopped the hard way');
      expect(names(pool), 'the pool holds the marker and nothing else').toEqual(['.format']);
    },
    60_000,
  );

  it('T36 a second TERM while the release is waiting leaves run alive and still holding, then released: 143, empty stderr', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const parked = blocker(pool, 'parked');
    const trace = path.join(scratchOf(pool), 'trace.log');
    const gate = startRun(pool, 'lane', parked.cmd, {
      env: {
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    await waitForFile(hook.seam);
    gate.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    // Still alive and still holding: the second signal did not cut the cleanup.
    expect(gate.child.exitCode, traceText(trace)).toBe(null);
    expect(gate.child.signalCode, traceText(trace)).toBe(null);
    expect(readSlot(pool, 'gate.lock').owner, traceText(trace)).toBe('lane');
    gate.child.kill('SIGTERM');
    hook.release();
    const r = await gate.done;
    expect(r.status, traceText(trace)).toBe(143);
    expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toBe('');
    expect(r.stdout, traceText(trace)).toContain('released by lane');
    expect(names(pool), traceText(trace)).toEqual(['.format']);
    expect(gone(beatPids(r.stdout)[0])).toBe(true);
  });
});

describe('T112 the signal path under every installed shell', () => {
  it('T112 TERM to run releases the slot and exits 143 under sh, dash and bash --posix', async () => {
    const shells = ['sh', 'dash', 'bash --posix'].filter(hasShell);
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      const pool = freshPool();
      const { gate, pid } = await signalledRun(pool, {
        name: `victim-${shell.replace(/\W/g, '')}`,
        shell,
      });
      gate.child.kill('SIGTERM');
      const r = await gate.done;
      expect(r.status, shell).toBe(143);
      expect(r.stdout, shell).toContain('released by lane');
      expect(r.stderr, shell).toBe('');
      expect(names(pool), shell).toEqual(['.format']);
      await waitForDead(pid);
      for (const loop of beatPids(r.stdout)) expect(gone(loop), `${shell} ${loop}`).toBe(true);
    }
  });
});

describe('what a signal leaves behind', () => {
  it('a signalled run leaves the pool with the marker and nothing else, and the slot files untouched', async () => {
    const pool = freshPool();
    const { block, gate } = await signalledRun(pool);
    const before = listing(path.join(pool, 'gate.lock'));
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(names(pool)).toEqual(['.format']);
    // The holder's six files were never touched while it held the lock.
    expect(before).toEqual([
      '0600 beat',
      '0600 owner',
      '0600 pid',
      '0600 project',
      '0600 started',
      '0600 worktree',
    ]);
    block.release();
  });
});

describe('C44 a command that exits 75 by itself', () => {
  it('is not a busy lock: 75 passes through, the tool busy line is absent, and the slot is released', () => {
    const pool = freshPool();
    const seen = path.join(scratchOf(pool), 'err');
    const cmd = [
      script(
        pool,
        'exit75.sh',
        `printf 'my own busy-ish failure\\n' >&2
printf 'my own stderr\\n' >>"$1"
exit 75`,
      ),
      seen,
    ];
    const r = runOnce(pool, 'lane', cmd);
    expect(r.status).toBe(75);
    expect(r.stderr).not.toContain('sleep and retry');
    expect(r.stderr).toContain('my own busy-ish failure');
    expect(fs.readFileSync(seen, 'utf8')).toBe('my own stderr\n');
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('a command that signals itself', () => {
  it('its own signal status is the run status, and the lock is still released', async () => {
    const pool = freshPool();
    const block = blocker(pool, 'victim', { pre: 'kill -TERM $$' });
    const gate = startRun(pool, 'lane', block.cmd);
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('the recorded holder pid', () => {
  it('is the pid the caller started, not a child of it', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd);
    await up(block);
    expect(readSlot(pool, 'gate.lock').pid).toBe(String(gate.child.pid));
    block.release();
    expect((await gate.done).status).toBe(0);
  });

  it('a run takes a slot whose holder is dead without reporting busy', () => {
    const pool = freshPool();
    const r = runOnce(pool, 'lane', ['true'], { env: { GATE_LOCK_CALLER_PID: String(livePid()) } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by lane');
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('the default heartbeat period', () => {
  it('is 60 seconds and is reported on the heartbeat line', () => {
    const pool = freshPool();
    const r = runOnce(pool, 'lane', ['true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('every 60s while lane runs');
  });
});
