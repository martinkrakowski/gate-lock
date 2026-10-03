// GL2a: acquire (6.A, 6.E, the creation and reclaim parts of 6.B, F67, the
// forged-slot filters as the slot loop meets them, and D21 output files).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BIN,
  buildEnv,
  listing,
  releaseHook,
  scratchOf,
  testShell,
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
  nowS,
  path,
  readSlot,
  seed,
  startAcquire,
  sub,
  until,
  wtDir,
} from './slots.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];

describe('T1 the script parses as POSIX shell', () => {
  it('T1 a syntax-only check with the selected shell succeeds with empty output', () => {
    const [cmd, ...args] = testShell().split(/\s+/);
    const r = spawnSync(cmd, [...args, '-n', BIN], { encoding: 'utf8', env: buildEnv() });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });
});

describe('T2 acquire takes a free slot', () => {
  it('T2 exits 0, prints the acquired line, and writes the six files with explicit modes (D23)', () => {
    const pool = freshPool();
    const pid = livePid();
    const wt = wtDir(pool, 'proj-x');
    const t0 = nowS();
    const r = acquire(pool, 'lane-a', pid, { cwd: wt });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`gate-lock: acquired by lane-a pid ${pid} at ${pool}/gate.lock\n`);
    const slot = readSlot(pool, 'gate.lock');
    expect(slot.owner).toBe('lane-a');
    expect(slot.pid).toBe(String(pid));
    expect(Number(slot.started)).toBeGreaterThanOrEqual(t0);
    expect(slot.beat).toBe(slot.started);
    expect(slot.worktree).toBe(wt);
    expect(slot.project).toBe('proj-x');
    expect(listing(pool)).toEqual([
      '0600 .format',
      '0700 gate.lock/',
      '0600 gate.lock/beat',
      '0600 gate.lock/owner',
      '0600 gate.lock/pid',
      '0600 gate.lock/project',
      '0600 gate.lock/started',
      '0600 gate.lock/worktree',
    ]);
  });

  it('T2 modes do not depend on the caller umask (D23)', () => {
    const pool = freshPool();
    const wt = wtDir(pool);
    const r = spawnSync('sh', ['-c', `umask 0; exec ${testShell()} ${BIN} acquire lane`], {
      encoding: 'utf8',
      cwd: wt,
      env: buildEnv({ GATE_LOCK_DIR: pool, GATE_LOCK_CALLER_PID: String(livePid()) }),
    });
    expect(r.status).toBe(0);
    expect(listing(pool).filter((l) => l.includes('gate.lock'))).toEqual([
      '0700 gate.lock/',
      '0600 gate.lock/beat',
      '0600 gate.lock/owner',
      '0600 gate.lock/pid',
      '0600 gate.lock/project',
      '0600 gate.lock/started',
      '0600 gate.lock/worktree',
    ]);
  });

  it('T2 the caller pid is recorded without leading zeros', () => {
    const pool = freshPool();
    const pid = livePid();
    const r = acquire(pool, 'lane', `00${pid}`);
    expect(r.status).toBe(0);
    expect(readSlot(pool, 'gate.lock').pid).toBe(String(pid));
  });
});

describe('F28 the worktree identity is the git top-level when there is one', () => {
  it('a subdirectory of a repository records the repository root and its name', () => {
    const pool = freshPool();
    const root = wtDir(pool, 'my-repo');
    const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    if (init.status !== 0) return; // git is optional (L8)
    const sub1 = path.join(root, 'a', 'b');
    fs.mkdirSync(sub1, { recursive: true });
    expect(acquire(pool, 'lane', livePid(), { cwd: sub1 }).status).toBe(0);
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ worktree: root, project: 'my-repo' });
  });

  it('outside a repository it is the physically resolved working directory (a symlinked cwd is resolved)', () => {
    const pool = freshPool();
    const real = wtDir(pool, 'real-dir');
    const link = path.join(scratchOf(pool), 'link-dir');
    fs.symlinkSync(real, link);
    expect(acquire(pool, 'lane', livePid(), { cwd: link }).status).toBe(0);
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ worktree: real, project: 'real-dir' });
  });
});

describe('T3 a bare acquire is refused', () => {
  const expectRefused = (r) => {
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^gate-lock: [^\n]*GATE_LOCK_CALLER_PID[^\n]*\n$/);
    expect(r.stderr).toContain('run');
  };

  it('T3 on a free host it exits 2 and creates nothing', () => {
    const pool = freshPool();
    expectRefused(sub(pool, ['acquire', 'lane']));
    expect(listing(pool)).toEqual(['0600 .format']);
  });

  it('T3 with a live holder it is not busy and not a reclaim: the holder is untouched', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'live' });
    const before = listing(pool);
    expectRefused(sub(pool, ['acquire', 'lane']));
    expectRefused(sub(pool, ['acquire', 'lane'], '')); // exported but empty
    expect(listing(pool)).toEqual(before);
  });

  it('T3 a malformed caller pid is refused naming the variable (D5)', () => {
    const pool = freshPool();
    for (const v of ['abc', '12x', '-5', '12345678901', ' 7']) {
      const r = acquire(pool, 'lane', v);
      expect(r.status, v).toBe(2);
      expect(r.stderr, v).toContain('GATE_LOCK_CALLER_PID');
    }
    expect(listing(pool)).toEqual(['0600 .format']);
  });
});

describe('T4 the worktree identity is required (F55)', () => {
  it('T4 a working directory removed under the running process exits 2, leaving no slot or candidate', async () => {
    const pool = freshPool();
    const cwd = path.join(scratchOf(pool), 'doomed');
    fs.mkdirSync(cwd);
    const hook = path.join(scratchOf(pool), 'hook-identity');
    const { done } = startAcquire(pool, 'lane', livePid(), {
      cwd,
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_IDENTITY: hook },
    });
    await waitForFile(hook);
    fs.rmdirSync(cwd);
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot determine the caller's worktree");
    expect(listing(pool)).toEqual(['0600 .format']);
  });
});

describe('T5 a live holder makes acquire busy', () => {
  it('T5 exits 75 with the busy line naming the holder; the slot is exactly as found', () => {
    const pool = freshPool();
    const holder = livePid();
    const beat = nowS() - 5;
    seed(pool, 'gate.lock', { owner: 'holder-lane', pid: holder, beat, started: beat });
    const before = listing(pool);
    const r = acquire(pool, 'other', livePid());
    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      `gate-lock: busy: ${pool}/gate.lock is held by holder-lane (pid ${holder}, beat ${beat}); ` +
        'sleep and retry, and never remove the lock by hand\n',
    );
    expect(listing(pool)).toEqual(before);
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder-lane');
  });
});

describe('T6-T10 reclaim of dead, stale and abandoned slots', () => {
  it('T6 a dead pid is reclaimed: reclaiming + not alive on stdout, the new lane holds the slot', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'corpse', pid: deadPid() });
    const pid = livePid();
    const r = acquire(pool, 'fresh', pid);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(
      /^gate-lock: reclaiming .*gate\.lock: holder corpse pid \d+ is not alive\n/,
    );
    expect(r.stdout).toContain(`acquired by fresh pid ${pid}`);
    const slot = readSlot(pool, 'gate.lock');
    expect(slot).toMatchObject({ owner: 'fresh', pid: String(pid) });
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });

  it('T7 a beat older than the threshold with a live pid is reclaimed as stale', () => {
    const pool = freshPool();
    const old = nowS() - 700;
    const holder = livePid();
    seed(pool, 'gate.lock', { owner: 'silent', pid: holder, beat: old, started: old });
    const r = acquire(pool, 'fresh', livePid());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `reclaiming ${pool}/gate.lock: holder silent pid ${holder} heartbeat is stale or missing (beat ${old}, threshold 600s)`,
    );
    expect(readSlot(pool, 'gate.lock').owner).toBe('fresh');
  });

  it('T7 the boundary: a beat exactly at the threshold is stale (F35), one second younger is fresh', () => {
    // 599 s old can age to 600 s during the run, so judge 590 (fresh) and 610 (stale).
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'a', beat: nowS() - 590 });
    expect(acquire(pool, 'x', livePid()).status).toBe(75);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'a', beat: nowS() - 610 });
    expect(acquire(pool, 'x', livePid()).status).toBe(0);
  });

  it('F35 the threshold boundary is exact: age == threshold is stale, one second younger is fresh', () => {
    const beat = 5_000_000;
    for (const [age, expected] of [
      [600, 0],
      [599, 75],
    ]) {
      const pool = freshPool();
      seed(pool, 'gate.lock', { owner: 'a', beat, started: beat });
      const r = acquire(pool, 'x', livePid(), { env: { ...TM, GATE_LOCK_TEST_NOW: beat + age } });
      expect(r.status, `age ${age}`).toBe(expected);
    }
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'a', beat, started: beat });
    const wide = acquire(pool, 'x', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_NOW: beat + 1000, GATE_LOCK_STALE_SECONDS: '1000' },
    });
    expect(wide.status).toBe(0);
  });

  it('T8 a widened threshold makes the same 700-second-old beat fresh; the holder stays', () => {
    const pool = freshPool();
    const old = nowS() - 700;
    seed(pool, 'gate.lock', { owner: 'silent', beat: old, started: old });
    const r = acquire(pool, 'x', livePid(), { env: { GATE_LOCK_STALE_SECONDS: '3600' } });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('silent');
    expect(readSlot(pool, 'gate.lock').owner).toBe('silent');
    // The default threshold calls it stale.
    expect(acquire(pool, 'x', livePid()).status).toBe(0);
  });

  it('T8 the tightened direction is the 600 s floor under a pool (F36, T90): 60 is refused', () => {
    const pool = freshPool();
    const r = acquire(pool, 'x', livePid(), { env: { GATE_LOCK_STALE_SECONDS: '60' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('600s');
  });

  it('T9 a non-numeric stale threshold is reported as itself, not as the bare acquire', () => {
    const pool = freshPool();
    const r = sub(pool, ['acquire', 'lane'], undefined, { env: { GATE_LOCK_STALE_SECONDS: 'x' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GATE_LOCK_STALE_SECONDS');
    expect(r.stderr).not.toContain('GATE_LOCK_CALLER_PID');
  });

  it('T10 / R17 an abandoned slot with only an owner file is reclaimed after bounded patience (pass 3)', () => {
    const pool = freshPool();
    fs.mkdirSync(path.join(pool, 'gate.lock'), { mode: 0o700 });
    writeRaw(pool, 'gate.lock/owner', 'ghost\n');
    const t0 = Date.now();
    const r = acquire(pool, 'fresh', livePid());
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reclaiming');
    expect(readSlot(pool, 'gate.lock').owner).toBe('fresh');
    // F45: two one-second patience sleeps before pass 3 reclaims.
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  });

  it('F45 a live pid with an empty beat gets the same bounded patience, then is reclaimed', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'half', beat: '' });
    const t0 = Date.now();
    const r = acquire(pool, 'fresh', livePid());
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(r.stdout).toMatch(
      /reclaiming .* heartbeat is stale or missing \(beat missing, threshold 600s\)/,
    );
  });

  it('F45 a dead pid with an empty beat needs no patience: only both-empty, or alive plus empty, waits', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'x', pid: deadPid(), beat: '' });
    const t0 = Date.now();
    expect(acquire(pool, 'fresh', livePid()).status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1900);
  });

  it('F37 a beat that is not all digits counts as stale', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'x', beat: '12ab' });
    const r = acquire(pool, 'fresh', livePid());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('stale');
  });

  it('D4 a beat in the future is never stale; D5 neither is one with more than 10 digits', () => {
    for (const beat of [
      nowS() + 100000,
      '99999999999999999999',
      '18446744073709551616',
      '18446744073709551617',
      '36893488147419103232',
    ]) {
      const pool = freshPool();
      seed(pool, 'gate.lock', { owner: 'future', beat });
      const r = acquire(pool, 'x', livePid());
      expect(r.status, String(beat)).toBe(75);
      expect(readSlot(pool, 'gate.lock').owner).toBe('future');
    }
  });

  it('F40 liveness needs both: a live pid with a stale beat, and a dead pid with a fresh beat, are both reclaimed', () => {
    for (const fields of [
      { pid: livePid(), beat: nowS() - 5000 },
      { pid: deadPid(), beat: nowS() },
    ]) {
      const pool = freshPool();
      seed(pool, 'gate.lock', { owner: 'old', ...fields });
      expect(acquire(pool, 'new', livePid()).status).toBe(0);
      expect(readSlot(pool, 'gate.lock').owner).toBe('new');
    }
    // and an answering holder (both) is not
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'old' });
    expect(acquire(pool, 'new', livePid()).status).toBe(75);
  });

  it('F41 an empty, zero or non-numeric recorded pid is not alive', () => {
    for (const pid of ['', '0', '000', 'abc', '12 34', '99999999999999999999']) {
      const pool = freshPool();
      seed(pool, 'gate.lock', { owner: 'odd', pid });
      const r = acquire(pool, 'new', livePid());
      expect(r.status, `pid ${JSON.stringify(pid)}`).toBe(0);
    }
  });
});

describe('T11 usage errors (C2) come after configuration and take no lock', () => {
  it('T11 an unknown subcommand exits 2 and prints usage on stderr', () => {
    const pool = freshPool();
    const r = sub(pool, ['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^usage: gate-lock /m);
    expect(listing(pool)).toEqual(['0600 .format']);
  });

  it('C2 no subcommand, a missing lane and extra arguments are usage errors', () => {
    const pool = freshPool();
    const cases = [
      [],
      ['acquire'],
      ['acquire', 'a', 'b'],
      ['release'],
      ['verify'],
      ['heartbeat', 'x'],
      ['status', 'x'],
      ['status', '--json', 'x'],
      ['acquire', ''],
    ];
    for (const args of cases) {
      const r = sub(pool, args, livePid());
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/^usage: gate-lock /m);
      expect(r.stdout).toBe('');
    }
    expect(listing(pool)).toEqual(['0600 .format']);
  });
});

describe('D20 test seams are inert outside test mode', () => {
  it('a set pause seam without GATE_LOCK_TEST_MODE is warned about and ignored: no parking', () => {
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'hook-ignored');
    const r = acquire(pool, 'lane', livePid(), {
      env: { GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(
      'gate-lock: warning: ignoring GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME (test seams need GATE_LOCK_TEST_MODE=1)\n',
    );
    expect(fs.existsSync(hook)).toBe(false);
  });

  it('an EMPTY pause seam is inert even in test mode', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: '' },
    });
    expect(r.status).toBe(0);
  });
});

describe('T12-T16 creation and reclaim races', () => {
  it('T12 / R1 a creator paused before its rename leaves no slot at the name and a complete candidate; on resume it wins with no candidate left', async () => {
    const pool = freshPool();
    const pid = livePid();
    const hook = path.join(scratchOf(pool), 'hook-rename');
    const { child, done } = startAcquire(pool, 'lane', pid, {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook },
    });
    await waitForFile(hook);
    expect(names(pool)).toEqual(['.format', `gate.lock.cand.${child.pid}`]);
    const cand = readSlotAt(path.join(pool, `gate.lock.cand.${child.pid}`));
    expect(cand).toMatchObject({ owner: 'lane', pid: String(pid) });
    expect(Number(cand.beat)).toBeGreaterThan(0);
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by lane');
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'lane', pid: String(pid) });
  });

  it('T13 / R2 a creator paused before its rename loses the name to a contender: 75 naming the contender, no candidate leaks, nothing nested', async () => {
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'hook-rename');
    const { done } = startAcquire(pool, 'slow', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_CREATE_RENAME: hook },
    });
    await waitForFile(hook);
    const contenderPid = livePid();
    const c = acquire(pool, 'quick', contenderPid, { cwd: wtDir(pool, 'wt1') });
    expect(c.status).toBe(0);
    const held = listing(pool).filter((l) => l.includes('gate.lock/'));
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(r.stderr).toContain('quick');
    expect(readSlot(pool, 'gate.lock')).toMatchObject({
      owner: 'quick',
      pid: String(contenderPid),
    });
    // Exactly the contender's six files: no nested candidate, no leaked candidate.
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(listing(pool).filter((l) => l.includes('gate.lock/'))).toEqual(held);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });

  it('T14 / R4 reclaim restore: a replacement that appeared in the window is renamed back; 75, reclaim aborted, no aside', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const hook = path.join(scratchOf(pool), 'hook-inspect');
    const { done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: hook },
    });
    await waitForFile(hook);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    const replacementPid = livePid();
    const now = nowS();
    seed(pool, 'gate.lock', { owner: 'replacement', pid: replacementPid, beat: now, started: now });
    const before = listing(pool);
    const written = readSlot(pool, 'gate.lock');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(r.stderr).toContain('reclaim aborted');
    expect(r.stderr).toContain('restored');
    expect(listing(pool)).toEqual(before);
    expect(readSlot(pool, 'gate.lock')).toEqual(written);
    expect(names(pool).filter((n) => n.includes('reclaim'))).toEqual([]);
  });

  it.each([
    ['only the beat differs', { owner: 'o', beat: 4000 }, { owner: 'o', beat: 4001 }],
    ['only the pid differs', { owner: 'o', beat: 4000 }, { owner: 'o', beat: 4000, other: true }],
    ['only the owner differs', { owner: 'o', beat: 4000 }, { owner: 'p', beat: 4000 }],
  ])(
    'R4 the three judged values are each compared: a replacement where %s is not deleted',
    async (_title, judged, replacement) => {
      const pool = freshPool();
      const dead = deadPid();
      const dead2 = deadPid() === dead ? dead + 1 : deadPid();
      seed(pool, 'gate.lock', { owner: judged.owner, pid: dead, beat: judged.beat });
      const hook = path.join(scratchOf(pool), 'hook-inspect');
      const { done } = startAcquire(pool, 'reclaimer', livePid(), {
        env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: hook },
      });
      await waitForFile(hook);
      fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
      seed(pool, 'gate.lock', {
        owner: replacement.owner,
        pid: replacement.other ? dead2 : dead,
        beat: replacement.beat,
      });
      releaseHook(hook);
      // Later passes park at the same hook; keep releasing it.
      const timer = setInterval(() => releaseHook(hook), 50);
      const r = await done;
      clearInterval(timer);
      // The mismatch is noticed (aborted and restored); the replacement is then
      // judged dead in its own right on the next pass and reclaimed.
      expect(r.stderr).toContain('reclaim aborted');
      expect(r.stderr).toContain('restored');
      expect(r.status).toBe(0);
    },
  );

  it('T15 / R4 reclaim leave-aside: a third party takes the name before the restore; 75, never deleted, one aside holds the replacement', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const inspect = path.join(scratchOf(pool), 'hook-inspect');
    const restore = path.join(scratchOf(pool), 'hook-restore');
    const { child, done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: inspect,
        GATE_LOCK_TEST_PAUSE_BEFORE_RESTORE: restore,
      },
    });
    await waitForFile(inspect);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'replacement', pid: livePid() });
    const replacementBytes = readSlot(pool, 'gate.lock');
    releaseHook(inspect);
    await waitForFile(restore);
    // The reclaimer has moved the replacement aside and is parked before the restore.
    expect(names(pool)).toEqual(['.format', `gate.lock.reclaim.${child.pid}.1`]);
    const thirdPid = livePid();
    seed(pool, 'gate.lock', { owner: 'third', pid: thirdPid });
    const third = readSlot(pool, 'gate.lock');
    releaseHook(restore);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('never deleted');
    expect(readSlot(pool, 'gate.lock')).toEqual(third);
    const asides = names(pool).filter((n) => n.includes('.reclaim.'));
    expect(asides).toEqual([`gate.lock.reclaim.${child.pid}.1`]);
    expect(readSlot(pool, asides[0])).toEqual(replacementBytes);
  });

  it('D12 a pre-existing aside name is never reused: the next free suffix is picked, nothing is aborted', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const inspect = path.join(scratchOf(pool), 'hook-inspect');
    const { child, done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: inspect },
    });
    await waitForFile(inspect);
    const planted = path.join(pool, `gate.lock.reclaim.${child.pid}.1`);
    fs.mkdirSync(planted, { mode: 0o700 });
    writeRaw(pool, `gate.lock.reclaim.${child.pid}.1/owner`, 'planted\n');
    releaseHook(inspect);
    const r = await done;
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(names(pool)).toEqual(['.format', 'gate.lock', `gate.lock.reclaim.${child.pid}.1`]);
    expect(names(planted)).toEqual(['owner']);
    expect(readSlot(pool, 'gate.lock').owner).toBe('reclaimer');
  });

  it('D12 an aside name taken between the pick and the rename is detected as nesting: the slot is restored, the planted dir untouched', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const beforeAside = path.join(scratchOf(pool), 'hook-aside');
    const { child, done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: beforeAside },
    });
    await waitForFile(beforeAside);
    const planted = path.join(pool, `gate.lock.reclaim.${child.pid}.1`);
    fs.mkdirSync(planted, { mode: 0o700 });
    writeRaw(pool, `gate.lock.reclaim.${child.pid}.1/marker`, 'planted\n');
    releaseHook(beforeAside);
    // The pause is reached again on the next pass (a fresh aside name); release it too.
    const again = until(() => fs.existsSync(beforeAside), 3000).then(
      () => releaseHook(beforeAside),
      () => {},
    );
    const r = await done;
    await again;
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('reclaim aborted');
    expect(names(planted)).toEqual(['marker']);
    expect(names(pool)).toEqual(['.format', 'gate.lock', `gate.lock.reclaim.${child.pid}.1`]);
    expect(readSlot(pool, 'gate.lock').owner).toBe('reclaimer');
  });

  it('F47 / R19 five passes without winning the name make the slot unavailable: busy, naming the last holder', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 's0', pid: deadPid() });
    const inspect = path.join(scratchOf(pool), 'hook-inspect');
    const { done } = startAcquire(pool, 'reclaimer', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: inspect },
    });
    // Four passes, each ended by a different stale holder replacing the one judged.
    for (let i = 1; i <= 4; i++) {
      await waitForFile(inspect);
      fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
      seed(pool, 'gate.lock', { owner: `s${i}`, pid: deadPid() });
      releaseHook(inspect);
    }
    const outcome = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve('parked'), 8000)),
    ]);
    if (outcome === 'parked') releaseHook(inspect);
    expect(outcome).not.toBe('parked');
    expect(outcome.status).toBe(75);
    expect(outcome.stderr).toMatch(/busy: .*gate\.lock is held by s4 \(pid \d+, beat \d+\)/);
    expect(readSlot(pool, 'gate.lock').owner).toBe('s4');
  }, 30000);

  it('T16 / R2 a busy acquire against two held slots, repeated, leaves each holder with exactly its four files', () => {
    const pool = freshPool();
    const now = nowS();
    const hold = (name, owner) =>
      seed(pool, name, { owner, beat: now, started: now }, { files: 4 });
    hold('gate.lock', 'first-holder');
    hold('gate.lock.1', 'second-holder');
    const before = listing(pool);
    for (let i = 0; i < 3; i++) {
      const r = acquire(pool, `lane${i}`, livePid(), {
        env: { GATE_LOCK_SLOTS: '2' },
        cwd: wtDir(pool, `wt${i}`),
      });
      expect(r.status).toBe(75);
      // F54: the first holder found is named, not the last.
      expect(r.stderr).toContain('first-holder');
      expect(r.stderr).toContain(`${pool}/gate.lock `);
      expect(r.stderr).not.toContain('second-holder');
    }
    for (const n of ['gate.lock', 'gate.lock.1']) {
      expect(names(path.join(pool, n))).toEqual(['beat', 'owner', 'pid', 'started']);
    }
    expect(listing(pool)).toEqual(before);
  });
});

describe('T44-T50 slot counts and slot order', () => {
  it('T44 a count that is not a number, or zero, exits 2 before any lock', () => {
    for (const [v, needle] of [
      ['x', 'must be a number of slots'],
      ['0', 'at least one slot'],
    ]) {
      const pool = freshPool();
      const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: v } });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('GATE_LOCK_SLOTS');
      expect(r.stderr).toContain(needle);
      expect(listing(pool)).toEqual(['0600 .format']);
    }
  });

  it('T45 over-ceiling counts are one exact stderr line and no lock; 064 is 64', () => {
    for (const v of ['65', '065', '99999999999999999999', '123456789012345678901234567890']) {
      const pool = freshPool();
      const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: v } });
      expect(r.status, v).toBe(2);
      expect(r.stderr).toBe(`gate-lock: GATE_LOCK_SLOTS must be at most 64 slots: ${v}\n`);
      expect(listing(pool)).toEqual(['0600 .format']);
    }
    for (const v of ['0', '00']) {
      const pool = freshPool();
      const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: v } });
      expect(r.stderr).toBe(`gate-lock: GATE_LOCK_SLOTS must be at least one slot: ${v}\n`);
    }
    const pool = freshPool();
    expect(acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: '64' } }).status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    // 064 is 64: with slot 0 held live, the acquirer is pushed to slot 1.
    const pool2 = freshPool();
    seed(pool2, 'gate.lock', { owner: 'holder' });
    const r = acquire(pool2, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: '064' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`at ${pool2}/gate.lock.1`);
  });

  it('T46 (acquire form) three worktrees at count 3 hold slots 0, 1, 2; a fourth is busy naming the first holder; each releases only its own', () => {
    const pool = freshPool();
    const env = { GATE_LOCK_SLOTS: '3' };
    const pids = [livePid(), livePid(), livePid()];
    const wts = ['a', 'b', 'c', 'd'].map((n) => wtDir(pool, `wt-${n}`));
    pids.forEach((pid, i) => {
      const r = acquire(pool, `lane${i}`, pid, { env, cwd: wts[i] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`at ${pool}/gate.lock${i === 0 ? '' : `.${i}`}\n`);
    });
    const four = acquire(pool, 'lane3', livePid(), { env, cwd: wts[3] });
    expect(four.status).toBe(75);
    expect(four.stderr).toContain('lane0');
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1', 'gate.lock.2']);
    pids.forEach((pid, i) => {
      const name = i === 0 ? 'gate.lock' : `gate.lock.${i}`;
      expect(readSlot(pool, name)).toMatchObject({
        owner: `lane${i}`,
        pid: String(pid),
        worktree: wts[i],
      });
    });
    // Each releases only its own slot.
    const rel = sub(pool, ['release', 'lane1'], pids[1], { env });
    expect(rel.status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.2']);
  });

  it('T47 slots are tried in order, judged one by one: slot 1 (dead) is reclaimed, slot 0 (live) and slot 2 are untouched', () => {
    const pool = freshPool();
    const live = livePid();
    seed(pool, 'gate.lock', { owner: 'live-zero', pid: live });
    seed(pool, 'gate.lock.1', { owner: 'dead-one', pid: deadPid() });
    const zero = readSlot(pool, 'gate.lock');
    const r = acquire(pool, 'newcomer', livePid(), { env: { GATE_LOCK_SLOTS: '3' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`reclaiming ${pool}/gate.lock.1:`);
    expect(r.stdout).toContain(`at ${pool}/gate.lock.1`);
    expect(readSlot(pool, 'gate.lock')).toEqual(zero);
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('newcomer');
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
  });

  it('T50 a one-slot caller takes a free slot 0 though slot 1 is held, and its release drops slot 0 only', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock.1', { owner: 'elsewhere' });
    const pid = livePid();
    const r = acquire(pool, 'mine', pid);
    expect(r.status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    const rel = sub(pool, ['release', 'mine'], pid);
    expect(rel.status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock.1']);
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('elsewhere');
  });

  it('F19 a slot count of 64 reaches slot 63 and no slot name above it is ever used', () => {
    const pool = freshPool();
    const now = nowS();
    const holder = livePid();
    for (let n = 0; n < 63; n++) {
      seed(pool, n === 0 ? 'gate.lock' : `gate.lock.${n}`, {
        owner: `h${n}`,
        pid: holder,
        beat: now,
      });
    }
    const r = acquire(pool, 'last', livePid(), { env: { GATE_LOCK_SLOTS: '64' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`at ${pool}/gate.lock.63\n`);
    // all 64 held: busy, and no slot 64 appears
    const r2 = acquire(pool, 'extra', livePid(), {
      env: { GATE_LOCK_SLOTS: '64' },
      cwd: wtDir(pool, 'other'),
    });
    expect(r2.status).toBe(75);
    expect(fs.existsSync(path.join(pool, 'gate.lock.64'))).toBe(false);
  }, 120000);
});

describe('T67-T68 one pid, one slot (F67)', () => {
  it('T67 a pid that already holds an answering slot is refused with exit 2, before the slot loop', () => {
    const pool = freshPool();
    const pid = livePid();
    const env = { GATE_LOCK_SLOTS: '3' };
    expect(acquire(pool, 'first', pid, { env }).status).toBe(0);
    const before = listing(pool);
    const r = acquire(pool, 'second', pid, { env, cwd: wtDir(pool, 'wt1') });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('already holds');
    expect(r.stderr).toContain(`${pool}/gate.lock`);
    expect(listing(pool)).toEqual(before);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('F67 the scan covers slots beyond the configured count too', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock.5', { owner: 'beyond', pid });
    const r = acquire(pool, 'second', pid);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${pool}/gate.lock.5`);
  });

  it('T68 the same pid with a stale beat is a recycled pid: reclaimed, not refused', () => {
    const pool = freshPool();
    const pid = livePid();
    const old = nowS() - 5000;
    seed(pool, 'gate.lock', { owner: 'old-life', pid, beat: old, started: old });
    const r = acquire(pool, 'new-life', pid);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reclaiming');
    expect(r.stdout).toContain('stale');
    expect(Number(readSlot(pool, 'gate.lock').beat)).toBeGreaterThan(old);
    expect(readSlot(pool, 'gate.lock').owner).toBe('new-life');
  });

  it('F67 a planted forgery carrying the caller pid does not trip the refusal', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock.007', { owner: 'forged', pid });
    expect(acquire(pool, 'real', pid).status).toBe(0);
  });
});

describe('forged slots as the slot loop meets them (F57-F59a, F61)', () => {
  it('a symlink at the slot name is not a slot: never reclaimed, never replaced; busy', () => {
    const pool = freshPool();
    const target = path.join(scratchOf(pool), 'elsewhere');
    fs.mkdirSync(target);
    const now = nowS();
    for (const [f, v] of Object.entries({
      owner: 'ghost',
      pid: deadPid(),
      started: now,
      beat: now,
    })) {
      writeRaw(scratchOf(pool), `elsewhere/${f}`, `${v}\n`);
    }
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    const before = listing(pool);
    const targetBefore = listing(target);
    const r = acquire(pool, 'lane', livePid());
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(listing(pool)).toEqual(before);
    expect(listing(target)).toEqual(targetBefore);
  });

  it('a symlink at a slot name is skipped: the next slot is taken', () => {
    const pool = freshPool();
    const target = path.join(scratchOf(pool), 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`at ${pool}/gate.lock.1`);
    expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('a regular file at the slot name is never removed; busy', () => {
    const pool = freshPool();
    writeRaw(pool, 'gate.lock', 'not a slot\n');
    const r = acquire(pool, 'lane', livePid());
    expect(r.status).toBe(75);
    expect(fs.readFileSync(path.join(pool, 'gate.lock'), 'utf8')).toBe('not a slot\n');
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('a slot not owned by the expected uid is not a slot: never reclaimed, busy (slot-uid seam, T61/T65)', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'ours-really', pid: deadPid() });
    const before = listing(pool);
    const r = acquire(pool, 'lane', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_SLOT_UID: '65534' },
    });
    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(listing(pool)).toEqual(before);
    // Without the seam, or with it empty (inert), the same slot is a real, dead one.
    const r2 = acquire(pool, 'lane', livePid(), { env: { ...TM, GATE_LOCK_TEST_SLOT_UID: '' } });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('not alive');
  });
});

describe('D21 the slot-output file', () => {
  const out = (pool, name = 'slot-out') => path.join(scratchOf(pool), name);

  it('an existing regular file is written in place, keeping the caller inode', () => {
    const pool = freshPool();
    const file = out(pool);
    writeRaw(scratchOf(pool), 'slot-out', 'old content that is longer than the path\n');
    const ino = fs.statSync(file).ino;
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: file } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${pool}/gate.lock\n`);
    expect(fs.statSync(file).ino).toBe(ino);
  });

  it('a path that does not exist is written through a temp file beside it and renamed; mode 0600, no leftover', () => {
    const pool = freshPool();
    const file = out(pool);
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: file } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${pool}/gate.lock\n`);
    expect((fs.statSync(file).mode & 0o7777).toString(8)).toBe('600');
    expect(names(scratchOf(pool)).filter((n) => n.startsWith('slot-out'))).toEqual(['slot-out']);
  });

  it('an empty GATE_LOCK_SLOT_OUT is inert', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: '' } });
    expect(r.status).toBe(0);
    expect(names(scratchOf(pool))).toEqual(['pool', 'wt0']);
  });

  it('a symlink is refused before the slot loop: exit 2, nothing taken, the target untouched', () => {
    const pool = freshPool();
    const target = out(pool, 'target');
    writeRaw(scratchOf(pool), 'target', 'precious\n');
    const link = out(pool, 'link');
    fs.symlinkSync(target, link);
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: link } });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('GATE_LOCK_SLOT_OUT');
    expect(fs.readFileSync(target, 'utf8')).toBe('precious\n');
    expect(names(pool)).toEqual(['.format']);
  });

  it('a dangling symlink is refused too', () => {
    const pool = freshPool();
    const link = out(pool, 'dangling');
    fs.symlinkSync(out(pool, 'nowhere'), link);
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: link } });
    expect(r.status).toBe(2);
    expect(fs.existsSync(out(pool, 'nowhere'))).toBe(false);
    expect(names(pool)).toEqual(['.format']);
  });

  it('an existing file that is not ours is refused (never written)', () => {
    const foreign = ['/etc/passwd', '/etc/hosts', '/bin/sh'].find((p) => {
      try {
        const st = fs.lstatSync(p);
        return st.isFile() && st.uid !== process.getuid();
      } catch {
        return false;
      }
    });
    if (foreign === undefined) return;
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: foreign } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is not a regular file owned by');
    expect(r.stderr).not.toContain('given back');
    expect(names(pool)).toEqual(['.format']);
  });

  it('a directory is refused', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: scratchOf(pool) } });
    expect(r.status).toBe(2);
    expect(names(pool)).toEqual(['.format']);
  });

  it('a new path whose parent is writable by group or others is refused', () => {
    const pool = freshPool();
    const dir = path.join(scratchOf(pool), 'open');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    const r = acquire(pool, 'lane', livePid(), {
      env: { GATE_LOCK_SLOT_OUT: path.join(dir, 'x') },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GATE_LOCK_SLOT_OUT');
    expect(names(dir)).toEqual([]);
    expect(names(pool)).toEqual(['.format']);
  });

  it('a new path whose parent does not exist is refused', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), {
      env: { GATE_LOCK_SLOT_OUT: path.join(scratchOf(pool), 'no', 'such', 'x') },
    });
    expect(r.status).toBe(2);
    expect(names(pool)).toEqual(['.format']);
  });

  it('a path with a trailing slash is refused', () => {
    const pool = freshPool();
    const r = acquire(pool, 'lane', livePid(), {
      env: { GATE_LOCK_SLOT_OUT: `${out(pool)}/` },
    });
    expect(r.status).toBe(2);
    expect(names(pool)).toEqual(['.format']);
  });

  it('a refusal takes nothing even when a slot is free and no refusal is due otherwise (checked before the loop)', () => {
    const pool = freshPool();
    const link = out(pool, 'l');
    fs.symlinkSync(out(pool, 'x'), link);
    expect(acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: link } }).status).toBe(2);
    expect(fs.existsSync(path.join(pool, 'gate.lock'))).toBe(false);
  });

  it('C9 / F60 a slot path that cannot be written gives the slot back: exit 2, "cannot be recorded", the slot gone', () => {
    const pool = freshPool();
    const file = out(pool);
    writeRaw(scratchOf(pool), 'slot-out', 'x\n', 0o400);
    const r = acquire(pool, 'lane', livePid(), { env: { GATE_LOCK_SLOT_OUT: file } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot be recorded');
    expect(r.stderr).toContain('given back');
    expect(names(pool)).toEqual(['.format']);
    expect(fs.readFileSync(file, 'utf8')).toBe('x\n');
  });
});

function readSlotAt(dir) {
  const out = {};
  for (const f of ['owner', 'pid', 'started', 'beat', 'worktree', 'project']) {
    try {
      out[f] = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\n$/, '');
    } catch {
      out[f] = undefined;
    }
  }
  return out;
}
