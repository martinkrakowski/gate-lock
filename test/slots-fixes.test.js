// GL2a fix round: review findings on slot safety (pids, forged replacements,
// restore windows, messages). Every race is parked on a test-mode pause seam.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BIN,
  listing,
  releaseHook,
  scratchOf,
  startBin,
  waitForFile,
  writeRaw,
} from './harness.js';
import {
  TM,
  acquire,
  deadPid,
  freshPool,
  livePid,
  names,
  path,
  readSlot,
  seed,
  startAcquire,
  sub,
  wtDir,
} from './slots.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];

/** Start a non-acquire subcommand against `pool` parked on seams. */
function startSub(pool, args, pid, env = {}, extra = {}) {
  return startBin(args, {
    env: { ...TM, GATE_LOCK_DIR: pool, GATE_LOCK_CALLER_PID: String(pid), ...env },
    cwd: wtDir(pool),
    ...extra,
  });
}

const hookIn = (pool, name) => path.join(scratchOf(pool), `hook-${name}`);

/** Make `link` a symlink to a directory holding a copy of `slot`'s files. */
function forgeFrom(pool, slot, link) {
  const target = path.join(scratchOf(pool), 'forged-target');
  fs.mkdirSync(target);
  for (const f of SIX) {
    fs.copyFileSync(path.join(slot, f), path.join(target, f));
  }
  fs.rmSync(slot, { recursive: true });
  fs.symlinkSync(target, link);
  return target;
}

describe('caller pid (qodo Am6, CodeRabbit CML)', () => {
  it('a caller pid of zero, in any spelling, is refused by every subcommand with exit 2', () => {
    for (const pid of ['0', '00', '0000000000']) {
      for (const args of [
        ['acquire', 'lane'],
        ['release', 'lane'],
        ['verify', 'lane'],
        ['heartbeat'],
      ]) {
        const pool = freshPool();
        const r = sub(pool, args, pid);
        expect(r.status, `${args[0]} ${pid}`).toBe(2);
        expect(r.stderr).toContain('GATE_LOCK_CALLER_PID');
        expect(r.stderr).toContain('non-zero');
        expect(names(pool)).toEqual(['.format']);
      }
    }
  });

  it('acquire refuses a caller pid that is not alive: exit 2, nothing taken', () => {
    const pool = freshPool();
    const pid = deadPid();
    const r = acquire(pool, 'lane', pid);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('GATE_LOCK_CALLER_PID');
    expect(r.stderr).toContain('not a live process');
    expect(names(pool)).toEqual(['.format']);
  });

  it('release, verify and heartbeat still accept a dead caller pid (a reclaimed holder asks)', () => {
    const pool = freshPool();
    const pid = deadPid();
    expect(sub(pool, ['release', 'lane'], pid).status).toBe(0);
    expect(sub(pool, ['verify', 'lane'], pid).status).toBe(1);
    expect(sub(pool, ['heartbeat'], pid).status).toBe(1);
  });
});

describe('heartbeat after the rename (qodo Amm)', () => {
  it('a slot taken over between the pid check and the rename is reported as no lock, exit 1', async () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'lane', pid, beat: 1000, started: 1000 });
    const hook = hookIn(pool, 'beat');
    const { done } = startSub(pool, ['heartbeat'], pid, {
      GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook,
    });
    await waitForFile(hook);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    const other = livePid();
    seed(pool, 'gate.lock', { owner: 'intruder', pid: other, beat: 1000, started: 1000 });
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /heartbeat: no lock: .*gate\.lock is now held by another holder \(pid \d+\)/,
    );
    expect(readSlot(pool, 'gate.lock').owner).toBe('intruder');
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });
});

describe('never delete through a symlink or a foreign directory (qodo Amo)', () => {
  it('release: a symlink swapped in before the rename-aside is put back, never deleted', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const hook = hookIn(pool, 'aside');
    const { done } = startSub(pool, ['release', 'lane'], pid, {
      GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: hook,
    });
    await waitForFile(hook);
    const target = forgeFrom(pool, path.join(pool, 'gate.lock'), path.join(pool, 'gate.lock'));
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(1);
    expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
    expect(names(target)).toEqual(SIX);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(r.stderr).toContain('release aborted');
    expect(r.stderr).not.toContain('reclaim aborted');
  });

  it('reclaim: a symlink with matching values swapped in is put back, never deleted', async () => {
    const pool = freshPool();
    const dead = deadPid();
    seed(pool, 'gate.lock', { owner: 'o', pid: dead, beat: 4000, started: 4000 });
    const hook = hookIn(pool, 'inspect');
    const { done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: hook },
    });
    await waitForFile(hook);
    const target = forgeFrom(pool, path.join(pool, 'gate.lock'), path.join(pool, 'gate.lock'));
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('reclaim aborted');
    expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
    expect(names(target)).toEqual(SIX);
  });
});

describe('verify re-checks provenance at the final read (qodo Ams)', () => {
  it('a slot replaced by a symlink to a matching directory does not verify', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const hook = hookIn(pool, 'verify');
    const { done } = startSub(pool, ['verify', 'lane'], pid, {
      GATE_LOCK_TEST_PAUSE_BEFORE_VERIFY_READ: hook,
    });
    await waitForFile(hook);
    forgeFrom(pool, path.join(pool, 'gate.lock'), path.join(pool, 'gate.lock'));
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('verify failed');
    expect(r.stderr).toContain('not a valid slot');
  });
});

describe('create_slot cleanup (qodo Amv)', () => {
  it('a symlink at the slot name is never created through: the target stays untouched', () => {
    const pool = freshPool();
    const target = path.join(scratchOf(pool), 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    const r = acquire(pool, 'lane', livePid());
    expect(r.status).toBe(75);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('a symlink that appears in the window leaves the candidate where it is, reports it, and does not win', async () => {
    const pool = freshPool();
    const target = path.join(scratchOf(pool), 'elsewhere');
    fs.mkdirSync(target);
    const hook = hookIn(pool, 'rename');
    const { child, done } = startAcquire(pool, 'lane', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook },
    });
    await waitForFile(hook);
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain(`gate.lock.cand.${child.pid}`);
    expect(r.stderr).toContain('left');
    expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
    // Nothing was deleted through the link: the candidate is still where mv put it.
    expect(fs.readdirSync(target)).toEqual([`gate.lock.cand.${child.pid}`]);
  });
});

describe('a slot with an entry named like itself (qodo Amy)', () => {
  it('is not reclaimable: it is left alone and reported busy', () => {
    const pool = freshPool();
    const dir = seed(pool, 'gate.lock', { owner: 'odd', pid: deadPid() });
    fs.mkdirSync(path.join(dir, 'gate.lock'));
    const before = listing(pool);
    const r = acquire(pool, 'lane', livePid());
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(r.stderr).toContain('is not touched');
    expect(listing(pool)).toEqual(before);
  });

  it('release leaves it alone too: exit 1 release failed, nothing moved', () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    fs.mkdirSync(path.join(pool, 'gate.lock', 'gate.lock'));
    const before = listing(pool);
    const r = sub(pool, ['release', 'lane'], pid);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release failed');
    expect(listing(pool)).toEqual(before);
  });
});

describe('the slot-output temp file (qodo Am2)', () => {
  it('never removes a pre-existing sibling named like the temp file', async () => {
    const pool = freshPool();
    const out = path.join(scratchOf(pool), 'slot-out');
    const hook = hookIn(pool, 'rename');
    const { child, done } = startAcquire(pool, 'lane', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook, GATE_LOCK_SLOT_OUT: out },
    });
    await waitForFile(hook);
    const planted = `${out}.tmp.${child.pid}`;
    fs.writeFileSync(planted, 'precious\n');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(`${pool}/gate.lock\n`);
    expect(fs.readFileSync(planted, 'utf8')).toBe('precious\n');
    expect(names(scratchOf(pool)).filter((n) => n.startsWith('slot-out'))).toEqual([
      'slot-out',
      `slot-out.tmp.${child.pid}`,
    ]);
  });
});

describe('put_back and the recovery rename (Fable S1, CodeRabbit CMP)', () => {
  it('S1 a name taken between the free-name test and the restore rename: the moved slot is moved back out, never nested', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const inspect = hookIn(pool, 'inspect');
    const restoreMv = hookIn(pool, 'restore-mv');
    const { child, done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: inspect,
        GATE_LOCK_TEST_PAUSE_BEFORE_RESTORE_MV: restoreMv,
      },
    });
    await waitForFile(inspect);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'replacement', pid: livePid() });
    const replacement = readSlot(pool, 'gate.lock');
    releaseHook(inspect);
    await waitForFile(restoreMv);
    // The name is free at the test and gets taken before the mv.
    seed(pool, 'gate.lock', { owner: 'third', pid: livePid() });
    const third = readSlot(pool, 'gate.lock');
    releaseHook(restoreMv);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('never deleted');
    expect(r.stderr).not.toContain('was restored');
    expect(readSlot(pool, 'gate.lock')).toEqual(third);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    const aside = `gate.lock.reclaim.${child.pid}.1`;
    expect(names(pool)).toEqual(['.format', 'gate.lock', aside]);
    expect(readSlot(pool, aside)).toEqual(replacement);
  });

  it('S1 the recovery rename after nesting has the same guard', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const judged = readSlot(pool, 'gate.lock');
    const beforeAside = hookIn(pool, 'aside');
    const restoreMv = hookIn(pool, 'restore-mv');
    const { child, done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: beforeAside,
        GATE_LOCK_TEST_PAUSE_BEFORE_RESTORE_MV: restoreMv,
      },
    });
    await waitForFile(beforeAside);
    const planted = path.join(pool, `gate.lock.reclaim.${child.pid}.1`);
    fs.mkdirSync(planted, { mode: 0o700 });
    writeRaw(pool, `gate.lock.reclaim.${child.pid}.1/marker`, 'planted\n');
    releaseHook(beforeAside);
    await waitForFile(restoreMv);
    // The nested slot is about to be moved back to the free name: a third party takes it.
    seed(pool, 'gate.lock', { owner: 'third', pid: livePid() });
    const third = readSlot(pool, 'gate.lock');
    releaseHook(restoreMv);
    const keep = setInterval(() => {
      releaseHook(beforeAside);
      releaseHook(restoreMv);
    }, 50);
    const r = await done;
    clearInterval(keep);
    expect(r.stderr).toContain('never deleted');
    expect(readSlot(pool, 'gate.lock')).toEqual(third);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    expect(readSlot(pool, `gate.lock.reclaim.${child.pid}.1/gate.lock`)).toEqual(judged);
  });

  it('messages name the operation: a release that put a different slot back says release', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const hook = hookIn(pool, 'aside');
    const { done } = startSub(pool, ['release', 'lane'], pid, {
      GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: hook,
    });
    await waitForFile(hook);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'intruder', pid: livePid() });
    releaseHook(hook);
    const r = await done;
    expect(r.stderr).toContain('release aborted: ');
    expect(r.stderr).toContain('different slot than the one checked');
    expect(r.stderr).not.toContain('reclaim');
  });

  it('a removal that fails half way says so and says what remains', () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const inner = path.join(pool, 'gate.lock', 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'f'), 'x');
    fs.chmodSync(inner, 0o500);
    try {
      const r = sub(pool, ['release', 'lane'], pid);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('release aborted: ');
      expect(r.stderr).toContain('could not be removed');
      expect(r.stderr).toContain('put back');
      expect(r.stderr).not.toContain('different slot');
      expect(r.stderr).toMatch(/release failed: .*now holds: [^\n]*inner/);
      expect(names(pool)).toEqual(['.format', 'gate.lock']);
      expect(fs.readdirSync(path.join(pool, 'gate.lock'))).toContain('inner');
      expect(fs.readFileSync(path.join(inner, 'f'), 'utf8')).toBe('x');
    } finally {
      fs.chmodSync(inner, 0o700);
    }
  });
});

describe('give-back result (CodeRabbit CMR)', () => {
  const unwritableOut = (pool) => {
    const out = path.join(scratchOf(pool), 'slot-out');
    writeRaw(scratchOf(pool), 'slot-out', 'x\n', 0o400);
    return out;
  };

  it('given back is reported only when it happened', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), {
      env: { GATE_LOCK_SLOT_OUT: unwritableOut(pool) },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('the lock was given back');
    expect(names(pool)).toEqual(['.format']);
  });

  it('a slot that could not be removed remains: the message says so and tells the caller to release', async () => {
    const pool = freshPool();
    const hook = hookIn(pool, 'aside');
    const { child, done } = startAcquire(pool, 'lane', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_SLOT_OUT: unwritableOut(pool),
        GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: hook,
      },
    });
    await waitForFile(hook);
    const planted = path.join(pool, `gate.lock.reclaim.${child.pid}.rel`);
    fs.mkdirSync(planted, { mode: 0o700 });
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('the lock was given back');
    expect(r.stderr).toContain('still holds');
    expect(r.stderr).toContain("run 'gate-lock release lane'");
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });

  it('a slot that changed hands is reported as such and left alone', async () => {
    const pool = freshPool();
    const hook = hookIn(pool, 'aside');
    const { done } = startAcquire(pool, 'lane', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_SLOT_OUT: unwritableOut(pool),
        GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: hook,
      },
    });
    await waitForFile(hook);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'intruder', pid: livePid() });
    const intruder = readSlot(pool, 'gate.lock');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('the lock was given back');
    expect(r.stderr).toContain('changed hands');
    expect(readSlot(pool, 'gate.lock')).toEqual(intruder);
  });
});

describe('N1 an unwritable pool is a refusal, not busy', () => {
  it('a candidate that cannot be written with nothing at the name is exit 2', () => {
    const pool = freshPool();
    fs.chmodSync(pool, 0o500);
    try {
      const r = acquire(pool, 'lane', livePid());
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/cannot create a candidate slot in .*not writable/);
      expect(r.stdout).toBe('');
    } finally {
      fs.chmodSync(pool, 0o700);
    }
    expect(names(pool)).toEqual(['.format']);
  });

  it('an unwritable pool with a live holder is still busy (the holder is real)', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'holder' });
    fs.chmodSync(pool, 0o500);
    try {
      expect(acquire(pool, 'lane', livePid()).status).toBe(75);
    } finally {
      fs.chmodSync(pool, 0o700);
    }
  });
});

describe('N2 the busy line prefers a real holder to a forged placeholder', () => {
  it('a symlink at slot 0 and a live holder at slot 1: the holder is named', () => {
    const pool = freshPool();
    const target = path.join(scratchOf(pool), 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    seed(pool, 'gate.lock.1', { owner: 'real-holder' });
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('real-holder');
    expect(r.stderr).toContain(`${pool}/gate.lock.1 `);
    expect(r.stderr).not.toContain('unknown');
  });

  it('only forged names occupied: the busy line names the first of them', () => {
    const pool = freshPool();
    writeRaw(pool, 'gate.lock', 'file\n');
    writeRaw(pool, 'gate.lock.1', 'file\n');
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain(`${pool}/gate.lock `);
  });
});

describe('S2 patience is observed through a marker, not the clock', () => {
  const PATIENCE = (pool) => hookIn(pool, 'patience');

  it('a dead pid with an empty beat never waits', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'x', pid: deadPid(), beat: '' });
    const marker = PATIENCE(pool);
    const r = acquire(pool, 'fresh', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_MARK_PATIENCE: marker },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('an alive pid with an empty beat waits (the marker proves the sleep was reached)', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'half', beat: '' });
    const marker = PATIENCE(pool);
    const r = acquire(pool, 'fresh', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_MARK_PATIENCE: marker },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('SC2015: no `A && B || C` chain in a test command', () => {
  it('the script has no line that chains && and || outside a group or substitution', () => {
    const text = fs.readFileSync(BIN, 'utf8').split('\n');
    const bad = text
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^\s*(\[ |is_digits |pid_eq |slot_valid |owned_by ).*&&.*\|\|/.test(l));
    expect(bad).toEqual([]);
  });
});
