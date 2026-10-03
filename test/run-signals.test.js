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
  alive,
  beatPids,
  blocker,
  childrenMatching,
  freshPool,
  runOnce,
  script,
  startRun,
  stopped,
  track,
  up,
  waitForDead,
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
 * A hook directory holding the H8 seam of one heartbeat refresh. Releasing it by
 * removing the whole directory releases the parked refresh and, because the path
 * can no longer be created, lets every later refresh through: `pause_at` creates
 * the file it waits on, and a path it cannot create is a pause it does not take.
 */
function beatHook(pool, name = 'beat-hook') {
  const dir = path.join(scratchOf(pool), name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    seam: path.join(dir, 'beat-rename'),
    release: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

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
      await waitForFile(path.join(dir, 'got'));
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

  it('D10 a watchdog whose run is gone does not kill the command: it only escalates while run wants it', async () => {
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
    // KILL the run itself: the lock is now nobody's, and the command's pid may
    // be reused at any moment. The watchdog must notice that its parent is gone
    // and leave the command alone rather than aim a KILL at a stranger.
    gate.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 5000));
    expect(alive(victim), 'the watchdog killed the command after run was gone').toBe(true);
  }, 90_000);
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
    expect(gone(beatPids(r.stdout)[0])).toBe(true);
  });

  it('T36 a second TERM while the release is waiting leaves run alive and still holding, then released: 143, empty stderr', async () => {
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
    await new Promise((r) => setTimeout(r, 500));
    // Still alive and still holding: the second signal did not cut the cleanup.
    expect(gate.child.exitCode).toBe(null);
    expect(gate.child.signalCode).toBe(null);
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane');
    gate.child.kill('SIGTERM');
    hook.release();
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
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
