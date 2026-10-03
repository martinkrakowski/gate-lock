// GL3: the caller loop and the run status file - `--wait` (the plan's "Waiting",
// R20) and `--status-file` (D18, D21), plus the nested-run shape with the wait.
//
// The retry test does not depend on the jitter: it starts a run whose acquire is
// genuinely busy, watches the busy line arrive, lets the holder go, and asserts
// the waiting run then takes the slot.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listing, releaseHook, scratchOf, waitForFile } from './harness.js';
import { TM, livePid, names, readSlot, seed, until, wtDir } from './slots.js';
import { blocker, freshPool, runOnce, startRun, track, up, watchStderr } from './run.js';

/** A path under the pool's scratch for an output file. */
const out = (pool, name) => path.join(scratchOf(pool), name);

describe('--status-file', () => {
  it('D18 a green run records the command status, and the file keeps the caller inode', () => {
    const pool = freshPool();
    const file = out(pool, 'status');
    fs.writeFileSync(file, 'old content\n');
    const ino = fs.statSync(file).ino;
    const r = runOnce(pool, 'lane', ['sh', '-c', 'exit 3'], { args: ['--status-file', file] });
    expect(r.status).toBe(3);
    expect(fs.readFileSync(file, 'utf8')).toBe('cmd:3\n');
    expect(fs.statSync(file).ino).toBe(ino);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
  });

  it('D18 a zero status is cmd:0, and a new path is written through a temp file (mode 0600, no leftover)', () => {
    const pool = freshPool();
    const file = out(pool, 'fresh-status');
    const r = runOnce(pool, 'lane', ['true'], { args: ['--status-file', file] });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('cmd:0\n');
    expect((fs.statSync(file).mode & 0o7777).toString(8)).toBe('600');
    expect(names(scratchOf(pool)).filter((n) => n.includes('status'))).toEqual(['fresh-status']);
  });

  it('D18 a busy acquire records busy:host and a same-worktree refusal records busy:worktree', async () => {
    // A full host: one slot, held live by somebody else.
    const full = freshPool();
    seed(full, 'gate.lock', { owner: 'holder', pid: livePid() });
    const hostFile = out(full, 'status-host');
    const busy = runOnce(full, 'lane', ['true'], { args: ['--status-file', hostFile] });
    expect(busy.status).toBe(75);
    expect(fs.readFileSync(hostFile, 'utf8')).toBe('busy:host\n');

    // A host with room: the second run wins a slot, finds the first holder in its
    // own worktree, gives the slot back and says so (F56 through run).
    const pool = freshPool();
    const wtFile = out(pool, 'status-wt');
    const holder = blocker(pool, 'holder');
    const gate = startRun(pool, 'holder-lane', holder.cmd, { env: { GATE_LOCK_SLOTS: '2' } });
    await up(holder);
    const same = runOnce(pool, 'lane', ['true'], {
      args: ['--status-file', wtFile],
      env: { GATE_LOCK_SLOTS: '2' },
    });
    expect(same.status).toBe(75);
    expect(same.stderr).toContain('same worktree');
    expect(fs.readFileSync(wtFile, 'utf8')).toBe('busy:worktree\n');
    holder.release();
    expect((await gate.done).status).toBe(0);
  });

  it('D18 a signalled run records tool:143, not the command status', async () => {
    const pool = freshPool();
    const file = out(pool, 'status-signal');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, { args: ['--status-file', file] });
    try {
      await up(block);
      gate.child.kill('SIGTERM');
      const r = await gate.done;
      expect(r.status).toBe(143);
      expect(fs.readFileSync(file, 'utf8')).toBe('tool:143\n');
    } finally {
      block.release();
    }
  });

  it('D18 a lost lock records tool:2, the answer the tool gives', async () => {
    const pool = freshPool();
    const file = out(pool, 'status-lost');
    const victim = blocker(pool, 'victim', {
      pre: 'rm -rf "$2"',
      args: [path.join(pool, 'gate.lock')],
    });
    const gate = startRun(pool, 'lane', victim.cmd, {
      args: ['--status-file', file],
      env: {
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
      },
    });
    try {
      await up(victim);
      track(victim.pid());
      const r = await gate.done;
      expect(r.status).toBe(2);
      expect(fs.readFileSync(file, 'utf8')).toBe('tool:2\n');
    } finally {
      victim.release();
    }
  });

  it('D18 a refused release records tool:2, and the replacement is left alone', () => {
    const pool = freshPool();
    const file = out(pool, 'status-kept');
    const holder = path.join(pool, 'gate.lock');
    const other = livePid();
    const planted = runOnce(
      pool,
      'lane',
      [
        'sh',
        '-c',
        `rm -rf "$1"; mkdir -m 0700 "$1"; printf 'other\\n' >"$1/owner"; printf '%s\\n' "$2" >"$1/pid"; printf '1\\n' >"$1/started"; printf '1\\n' >"$1/beat"; printf '/x\\n' >"$1/worktree"; printf 'x\\n' >"$1/project"`,
        'sh',
        holder,
        other,
      ],
      { args: ['--status-file', file], env: { GATE_LOCK_HEARTBEAT_SECONDS: '3600' } },
    );
    expect(planted.status).not.toBe(0);
    expect(planted.stderr).toContain('FAILED to release the lock');
    expect(planted.stderr).toContain('release refused');
    expect(readSlot(pool, 'gate.lock').owner).toBe('other');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^tool:[12]\n$/);
  });

  it('D21 a status file that cannot be written is refused before the slot loop: exit 2, nothing taken', () => {
    const pool = freshPool();
    const link = out(pool, 'link');
    fs.symlinkSync(out(pool, 'target'), link);
    const r = runOnce(pool, 'lane', ['true'], { args: ['--status-file', link] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--status-file');
    expect(r.stderr).toContain('symlink');
    expect(names(pool)).toEqual(['.format']);
    expect(fs.existsSync(path.join(pool, 'gate.lock'))).toBe(false);
  });

  it('D21 a new status file in a directory others may write is refused, and takes nothing', () => {
    const pool = freshPool();
    const open = out(pool, 'open');
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    const r = runOnce(pool, 'lane', ['true'], {
      args: ['--status-file', path.join(open, 'x')],
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--status-file');
    expect(names(pool)).toEqual(['.format']);
  });

  it('D18 a run without --status-file records nothing anywhere', () => {
    const pool = freshPool();
    // The worktree the run runs in is part of the scratch, so it exists before
    // the comparison: what is asserted is that the run published nothing new.
    wtDir(pool, 'wt0');
    const before = listing(scratchOf(pool));
    expect(runOnce(pool, 'lane', ['true']).status).toBe(0);
    expect(listing(scratchOf(pool))).toEqual(before);
  });
});

describe('--wait', () => {
  it('Waiting a run retries a busy pool and takes the slot when it frees up before the deadline', async () => {
    const pool = freshPool();
    // One slot, held by a real run; the waiting run is in another worktree, so
    // the answer it keeps getting is a busy host.
    const holder = blocker(pool, 'holder');
    const gate = startRun(pool, 'holder-lane', holder.cmd);
    await up(holder);
    const waiter = startRun(pool, 'waiter-lane', ['sh', '-c', 'exit 0'], {
      args: ['--wait', '60'],
      cwd: wtDir(pool, 'wt-wait'),
    });
    // The waiter has been refused at least once: its busy line is on stderr.
    const busy = watchStderr(waiter.child);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !busy().includes('busy')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(busy()).toContain('busy');
    expect(busy()).toContain('holder-lane');
    expect(names(pool).filter((n) => /^gate\.lock(\.\d+)?$/.test(n))).toEqual(['gate.lock']);
    // Let the holder go; the waiter's next attempt takes the freed slot.
    holder.release();
    expect((await gate.done).status).toBe(0);
    const r = await waiter.done;
    expect(r.status).toBe(0);
    // The freed slot is the one it was refused a moment before, and the run has
    // already given it back (its command exits at once).
    expect(r.stdout).toContain('acquired by waiter-lane');
    expect(r.stdout).toContain(`at ${path.join(pool, 'gate.lock')}`);
    expect(r.stdout).toContain('released by waiter-lane');
    expect(names(pool)).toEqual(['.format']);
  });

  it('Waiting a run that is still busy at the deadline exits 75, and holds the lock for the whole wait', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const file = out(pool, 'status-wait');
    const wait = 4;
    // The clock the tool reads is whole seconds, so a run that starts early in a
    // second is the case that catches a deadline computed without the rounding
    // slack. Start it just after a second boundary for that reason.
    while (Date.now() % 1000 > 150) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const started = Date.now();
    const r = runOnce(pool, 'lane', ['true'], {
      args: ['--wait', String(wait), '--status-file', file],
    });
    const elapsed = Date.now() - started;
    expect(r.status).toBe(75);
    // The command never started and no lock was taken.
    expect(r.stdout).not.toContain('acquired');
    expect(r.stderr).toContain('busy');
    // Both bounds: never before the deadline, and at most one backoff step (the
    // longest pause the loop may take) plus the whole second the clock's rounding
    // is allowed to cost.
    expect(elapsed).toBeGreaterThanOrEqual(wait * 1000);
    expect(elapsed).toBeLessThanOrEqual(wait * 1000 + 5000 + 1000);
    expect(fs.readFileSync(file, 'utf8')).toBe('busy:host\n');
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder');
  }, 30_000);

  it('Waiting a signal during the backoff ends the wait without a fallback release', async () => {
    // The other way a signal can end a wait: the acquire has already answered 75
    // and the loop is in its backoff sleep. The busy line is the handshake that
    // the sleep has been entered - the run echoes it before it sleeps.
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const gate = startRun(pool, 'lane', ['true'], { args: ['--wait', '60'] });
    const busy = watchStderr(gate.child);
    await until(() => busy().includes('busy'), 20000);
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    // The wait held no slot, so there is nothing to give back and nothing to say
    // about giving it back.
    expect(r.stderr, JSON.stringify(r.stderr)).not.toContain(
      'the acquire was stopped before it recorded the slot',
    );
    expect(r.stdout).not.toContain('released by');
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder');
  }, 60_000);

  it('Waiting a signal that arrives while the acquire is running is not lost to a busy answer', async () => {
    // The acquire child is parked just before it renames its candidate, which is a
    // window only an acquire has. A signal sent in that window is deferred by the
    // shell until the child exits (L1), so the loop has to look again before it
    // reports 75: the run was asked to stop.
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'create-hook');
    const file = out(pool, 'signalled-acquire');
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const gate = startRun(pool, 'lane', ['true'], {
      args: ['--wait', '0', '--status-file', file],
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook },
    });
    try {
      await waitForFile(hook);
      gate.child.kill('SIGTERM');
      releaseHook(hook);
      const r = await gate.done;
      expect(r.status).toBe(143);
      expect(r.stderr).toContain('busy');
      // A signal that ended the acquire is not an acquire that was stopped: this
      // run holds no slot, so there is nothing to give back and nothing to say
      // about giving it back.
      expect(r.stderr).not.toContain('the acquire was stopped before it recorded the slot');
      expect(fs.readFileSync(file, 'utf8')).toBe('tool:143\n');
      // The holder's slot is untouched: this run never took one.
      expect(readSlot(pool, 'gate.lock').owner).toBe('holder');
    } finally {
      releaseHook(hook);
    }
  }, 60_000);

  it('Waiting a signal ends the wait: the run exits 143 and the holder keeps the lock', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const file = out(pool, 'status-signalled');
    // A deadline far beyond the test: what ends this run is the signal.
    const gate = startRun(pool, 'lane', ['true'], {
      args: ['--wait', '600', '--status-file', file],
    });
    const busy = watchStderr(gate.child);
    const started = Date.now();
    // The first answer is the busy one; the run is now waiting for the next try.
    await until(() => busy().includes('busy'), 20000);
    gate.child.kill('SIGTERM');
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(Date.now() - started).toBeLessThan(30000);
    expect(fs.readFileSync(file, 'utf8')).toBe('tool:143\n');
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder');
  }, 60_000);

  it('Waiting --wait 0 makes exactly one attempt', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const started = Date.now();
    const r = runOnce(pool, 'lane', ['true'], { args: ['--wait', '0'] });
    expect(r.status).toBe(75);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stderr.match(/busy/g)).toHaveLength(1);
  });

  it('Waiting without --wait is one attempt, and a free slot is never waited for', () => {
    const pool = freshPool();
    // Sound but slow: it spawns the tool, and under CPU stress that can take
    // longer than the harness's own spawn timeout, which would signal the run and
    // make this a test of the harness rather than of the wait. The count of busy
    // lines is the assertion that matters: one attempt, so one line.
    const r = runOnce(pool, 'lane', ['true'], { timeout: 120000 });
    expect(r.status).toBe(0);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
  });

  it('Waiting a value that is not a whole number of seconds is a usage error', () => {
    const pool = freshPool();
    for (const v of ['x', '-1', '1.5', '']) {
      const r = runOnce(pool, 'lane', ['true'], { args: ['--wait', v] });
      expect(r.status, v).toBe(2);
      expect(r.stderr, v).toContain('--wait');
      expect(r.stderr, v).toContain('usage');
      expect(names(pool), v).toEqual(['.format']);
    }
  });

  it('Waiting a leading zero is a spelling, not an octal digit, and ten digits are allowed', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    // `--wait 010` used to be read as eight by the arithmetic, and `--wait 08`
    // was an arithmetic error; both are a spelling of 10 and 8. A ten-digit value
    // is within the limit the message states, so it is accepted (and refused as
    // far away as the pool is concerned, by the deadline itself).
    for (const [given, seconds] of [
      ['010', 10],
      ['08', 8],
    ]) {
      const started = Date.now();
      const r = runOnce(pool, 'lane', ['true'], { args: ['--wait', given] });
      const elapsed = Date.now() - started;
      expect(r.status, given).toBe(75);
      expect(r.stderr, given).toContain('busy');
      // It waited the number of seconds it was asked for, not the octal reading of
      // it, and not none at all.
      expect(elapsed, `${given} waited ${elapsed}ms`).toBeGreaterThanOrEqual((seconds - 1) * 1000);
      expect(elapsed, given).toBeLessThan(seconds * 1000 + 6000);
    }
    // A ten-digit value is inside the limit the message states, so it is accepted
    // rather than refused: it is checked by letting the run answer its first busy
    // line, which says nothing about the usage, and then stopping the wait.
    const gate = startRun(pool, 'lane', ['true'], { args: ['--wait', '9999999999'] });
    const busy = watchStderr(gate.child);
    await until(() => busy().includes('busy'), 20000);
    expect(busy()).not.toContain('usage');
    gate.child.kill('SIGTERM');
    const stopped = await gate.done;
    expect(stopped.status).toBe(143);
  }, 90_000);

  it('R20 a nested run with --wait still loses: it retries, then exits 75 without starting its command', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'outer', pid: livePid() });
    const r = runOnce(pool, 'inner', ['sh', '-c', 'exit 0'], { args: ['--wait', '2'] });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(r.stdout).not.toContain('acquired');
    expect(readSlot(pool, 'gate.lock').owner).toBe('outer');
  }, 30_000);
});

describe('the worker cap the command sees', () => {
  it('the effective cap is not exported into the command environment (V27: the config calls the resolver)', () => {
    const pool = freshPool();
    const seen = out(pool, 'env');
    // Four processors with two workers a slot: two slots, so the counts agree.
    const r = runOnce(pool, 'lane', ['sh', '-c', `env | sort >"$1"`, 'sh', seen], {
      env: { ...TM, GATE_LOCK_TEST_NPROC: '4', GATE_LOCK_SLOTS: '2', GATE_HOST_WORKERS: '2' },
    });
    expect(r.status).toBe(0);
    const workers = fs
      .readFileSync(seen, 'utf8')
      .split('\n')
      .filter((l) => l.includes('WORKERS'));
    // The cap is the caller's to apply through resolveMaxWorkers; run neither
    // invents nor exports one.
    expect(workers).toEqual(['GATE_HOST_WORKERS=2']);
  });
});
