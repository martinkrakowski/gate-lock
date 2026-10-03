// GL2a: heartbeat, verify, release, status, pins and forged slots (6.C, 6.G,
// the slot parts of 6.H and 6.I). Other clients' slots are planted with the
// harness's spec-exact writers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BIN,
  buildEnv,
  listing,
  releaseHook,
  scratchOf,
  startBin,
  testShell,
  waitForFile,
  writeRaw,
  writeTransient,
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
  sub,
  wtDir,
} from './slots.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];
const FOREIGN = { ...TM, GATE_LOCK_TEST_SLOT_UID: '65534' };

/** Seed a holder whose beat is a fixed, very old value, so a refresh is visible. */
const seedOld = (pool, name, fields = {}, opts) =>
  seed(pool, name, { beat: 1000, started: 1000, ...fields }, opts);

describe('T17-T18 heartbeat', () => {
  it('T17 moves the beat past the seeded value with the caller pid, silently, exit 0', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    const t0 = nowS();
    const r = sub(pool, ['heartbeat'], pid);
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    const beat = Number(readSlot(pool, 'gate.lock').beat);
    expect(beat).toBeGreaterThanOrEqual(t0);
    expect(beat).toBeLessThanOrEqual(nowS());
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    expect(listing(pool).find((l) => l.endsWith('gate.lock/beat'))).toBe('0600 gate.lock/beat');
  });

  it('T17 against an empty host it fails with "no lock" and "nothing to refresh"', () => {
    const pool = freshPool();
    const r = sub(pool, ['heartbeat'], livePid());
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^gate-lock: heartbeat: no lock\b.*nothing to refresh\n$/);
  });

  it('T18 from a pid that is not the slot holder is refused and the beat is unchanged', () => {
    const pool = freshPool();
    seedOld(pool, 'gate.lock', { owner: 'lane' });
    const r = sub(pool, ['heartbeat'], livePid());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('heartbeat refused');
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
  });

  it('C23 the staged beat is removed and the exit is 1 when the slot vanished before the rename (H8)', async () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    const hook = path.join(scratchOf(pool), 'hook-beat');
    const { child, done } = startBin(['heartbeat'], {
      env: {
        ...TM,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook,
      },
      cwd: wtDir(pool),
    });
    await waitForFile(hook);
    expect(names(pool)).toContain(`gate.lock.beatnew.${child.pid}`);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/heartbeat.*cannot replace the beat/);
    expect(names(pool)).toEqual(['.format']);
  });

  it('C23 a beat that is a directory cannot be replaced: exit 1, nothing staged is left, nothing nested', () => {
    const pool = freshPool();
    const pid = livePid();
    const dir = seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    fs.rmSync(path.join(dir, 'beat'));
    fs.mkdirSync(path.join(dir, 'beat'));
    const r = sub(pool, ['heartbeat'], pid);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('heartbeat');
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(path.join(dir, 'beat'))).toEqual([]);
  });

  it('D23 the replaced beat is mode 0600 whatever the caller umask', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    const r = spawnSync('sh', ['-c', `umask 0; exec ${testShell()} ${BIN} heartbeat`], {
      encoding: 'utf8',
      cwd: wtDir(pool),
      env: buildEnv({ GATE_LOCK_DIR: pool, GATE_LOCK_CALLER_PID: String(pid) }),
    });
    expect(r.status).toBe(0);
    expect(listing(pool).find((l) => l.endsWith('gate.lock/beat'))).toBe('0600 gate.lock/beat');
  });

  it('T92 / F39 the staged beat is a sibling of the slot inside the pool, never in the temp directory', async () => {
    const pool = freshPool();
    const tmp = path.join(scratchOf(pool), 'tmp-elsewhere');
    fs.mkdirSync(tmp);
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    const hook = path.join(scratchOf(pool), 'hook-beat');
    const { child, done } = startBin(['heartbeat'], {
      env: {
        ...TM,
        TMPDIR: tmp,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook,
      },
      cwd: wtDir(pool),
    });
    await waitForFile(hook);
    expect(names(pool)).toEqual(['.format', 'gate.lock', `gate.lock.beatnew.${child.pid}`]);
    expect(fs.readdirSync(tmp)).toEqual([]);
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(Number(readSlot(pool, 'gate.lock').beat)).toBeGreaterThan(1000);
  });
});

describe('T19 status and C25-C27, D19', () => {
  it('T19 an empty host says free, then the capacity line', () => {
    const pool = freshPool();
    const r = sub(pool, ['status'], undefined);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      `free: ${pool}/gate.lock is not held\nslots: 0/1 live, 0 stale, pool ${pool}, format 1\n`,
    );
  });

  it('T19 a live holder shows its lane and alive, with every field C25 names', () => {
    const pool = freshPool();
    const pid = livePid();
    const beat = nowS() - 3;
    seed(pool, 'gate.lock', {
      owner: 'lane-a',
      pid,
      started: 1234567,
      beat,
      project: 'proj',
    });
    const r = sub(pool, ['status'], undefined);
    expect(r.stdout).toBe(
      `${pool}/gate.lock held by lane-a project proj started 1234567 pid ${pid} alive, heartbeat fresh (beat ${beat})\n` +
        `slots: 1/1 live, 0 stale, pool ${pool}, format 1\n`,
    );
  });

  it('T19 a dead holder says not alive; it is listed, not reclaimed (C27)', () => {
    const pool = freshPool();
    const pid = deadPid();
    const beat = nowS();
    seed(pool, 'gate.lock', { owner: 'gone', pid, beat, started: beat, project: 'p' });
    const before = listing(pool);
    const r = sub(pool, ['status'], undefined);
    expect(r.stdout).toContain(
      `${pool}/gate.lock held by gone project p started ${beat} pid ${pid} not alive, heartbeat fresh (beat ${beat})`,
    );
    expect(r.stdout).toContain('slots: 0/1 live, 1 stale');
    expect(listing(pool)).toEqual(before);
  });

  it('C25 a stale beat and a missing beat print the threshold; an unreadable owner/project/start print unknown/?', () => {
    const pool = freshPool();
    const old = nowS() - 700;
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'silent', pid, beat: old, started: old });
    const dir = seed(pool, 'gate.lock.1', { owner: 'x', pid });
    for (const f of ['beat', 'started', 'project', 'owner']) fs.rmSync(path.join(dir, f));
    const r = sub(pool, ['status'], undefined);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toContain(
      `held by silent project else started ${old} pid ${pid} alive, heartbeat stale (beat ${old}, threshold 600s)`,
    );
    expect(lines[1]).toBe(
      `${pool}/gate.lock.1 held by unknown project unknown started ? pid ${pid} alive, heartbeat missing (threshold 600s)`,
    );
    expect(lines[2]).toBe(`slots: 0/1 live, 2 stale, pool ${pool}, format 1`);
  });

  it('D4 a beat more than 600 s in the future is flagged but still fresh', () => {
    const pool = freshPool();
    const beat = nowS() + 1000;
    seed(pool, 'gate.lock', { owner: 'skewed', beat });
    const r = sub(pool, ['status'], undefined);
    const m = r.stdout.match(
      new RegExp(`heartbeat fresh \\(beat ${beat}, (\\d+)s in the future\\)`),
    );
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(990);
    expect(Number(m[1])).toBeLessThanOrEqual(1000);
    expect(r.stdout).toContain('slots: 1/1 live, 0 stale');
  });

  it('T48 status lists every existing slot, including one beyond the count, and no transient; it modifies nothing', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'zero' });
    seed(pool, 'gate.lock.1', { owner: 'one' });
    for (const base of ['gate.lock', 'gate.lock.1']) {
      for (const t of ['cand.4242', 'reclaim.4242.1']) {
        const dir = seed(pool, `${base}.${t}`, { owner: 'transient' });
        expect(fs.existsSync(dir)).toBe(true);
      }
    }
    const before = listing(pool);
    const r = sub(pool, ['status'], undefined);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`${pool}/gate.lock held by zero`);
    expect(lines[1]).toContain(`${pool}/gate.lock.1 held by one`);
    expect(r.stdout).not.toContain('transient');
    expect(listing(pool)).toEqual(before);
  });

  it('T48 beatnew and format temp files are not slots either', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'zero' });
    writeTransient(pool, 'gate.lock.beatnew.99');
    writeTransient(pool, '.format.tmp.99');
    const r = sub(pool, ['status'], undefined);
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(2);
  });

  it('T91 status prints the project per slot, and unknown for a four-file slot, which is still listed', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'six', project: 'my-project' });
    seed(pool, 'gate.lock.1', { owner: 'four' }, { files: 4 });
    const r = sub(pool, ['status'], undefined);
    expect(r.stdout).toContain(`${pool}/gate.lock held by six project my-project`);
    expect(r.stdout).toContain(`${pool}/gate.lock.1 held by four project unknown`);
  });

  it('T61 / T65 a slot not owned by the expected uid is invisible; an empty seam is inert', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'a', pid });
    seedOld(pool, 'gate.lock.1', { owner: 'b', pid });
    const hidden = sub(pool, ['status'], undefined, { env: FOREIGN });
    expect(hidden.stdout).toBe(
      `free: ${pool}/gate.lock is not held\nslots: 0/1 live, 0 stale, pool ${pool}, format 1\n`,
    );
    const hb = sub(pool, ['heartbeat'], pid, { env: FOREIGN });
    expect(hb.status).toBe(1);
    expect(hb.stderr).toContain('no lock');
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
    expect(readSlot(pool, 'gate.lock.1').beat).toBe('1000');
    for (const env of [{}, { ...TM, GATE_LOCK_TEST_SLOT_UID: '' }]) {
      const shown = sub(pool, ['status'], undefined, { env });
      expect(shown.stdout).toContain('gate.lock held by a');
      expect(shown.stdout).toContain('gate.lock.1 held by b');
    }
  });

  it('D20 the slot-uid seam is ignored outside test mode (with a warning)', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'a' });
    const r = sub(pool, ['status'], undefined, { env: { GATE_LOCK_TEST_SLOT_UID: '65534' } });
    expect(r.stdout).toContain('held by a');
    expect(r.stderr).toContain('ignoring GATE_LOCK_TEST_SLOT_UID');
  });

  it('D19 status --json is schema version 1', () => {
    const pool = freshPool();
    const pid = livePid();
    const dead = deadPid();
    const beat = nowS() - 2;
    seed(pool, 'gate.lock', { owner: 'a', pid, beat, started: 111, project: 'p', worktree: '/w' });
    seed(pool, 'gate.lock.2', { owner: 'b', pid: dead, beat: '', started: 222 }, { files: 6 });
    const r = sub(pool, ['status', '--json'], undefined, { env: { GATE_LOCK_SLOTS: '3' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const json = JSON.parse(r.stdout);
    expect(json).toEqual({
      version: 1,
      format: 1,
      pool,
      slotCount: 3,
      live: 1,
      stale: 1,
      slots: [
        {
          path: `${pool}/gate.lock`,
          name: 'gate.lock',
          owner: 'a',
          project: 'p',
          worktree: '/w',
          started: '111',
          pid: String(pid),
          pidAlive: true,
          beat: String(beat),
          beatState: 'fresh',
          live: true,
        },
        {
          path: `${pool}/gate.lock.2`,
          name: 'gate.lock.2',
          owner: 'b',
          project: 'else',
          worktree: '/somewhere/else',
          started: '222',
          pid: String(dead),
          pidAlive: false,
          beat: null,
          beatState: 'missing',
          live: false,
        },
      ],
    });
  });

  it('D19 status --json on an empty pool has an empty slots array', () => {
    const pool = freshPool();
    const json = JSON.parse(sub(pool, ['status', '--json'], undefined).stdout);
    expect(json).toMatchObject({ version: 1, live: 0, stale: 0, slots: [] });
  });

  it('D19 status --json escapes quotes, backslashes and control or non-ASCII bytes into valid JSON', () => {
    const pool = freshPool();
    const dir = seed(pool, 'gate.lock', { owner: 'x', project: 'y' });
    fs.writeFileSync(path.join(dir, 'owner'), 'a"b\\c\tdé\n');
    fs.writeFileSync(path.join(dir, 'project'), '{"k":1}\n');
    const r = sub(pool, ['status', '--json'], undefined);
    const json = JSON.parse(r.stdout);
    expect(json.slots[0].owner).toBe('a"b\\c?d??');
    expect(json.slots[0].project).toBe('{"k":1}');
  });
});

describe('T20-T22 release', () => {
  it('T20 the holder releases its slot (exit 0, released by); a second release is a clean no-op', () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const r = sub(pool, ['release', 'lane'], pid);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`gate-lock: released by lane (${pool}/gate.lock)\n`);
    expect(names(pool)).toEqual(['.format']);
    const again = sub(pool, ['release', 'lane'], pid);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`gate-lock: nothing to release (${pool}/gate.lock)\n`);
  });

  it('T21 after a reclaim the old holder is refused (both ways), the replacement stays, the true holder releases', () => {
    const pool = freshPool();
    const oldPid = deadPid();
    seed(pool, 'gate.lock', { owner: 'old', pid: oldPid });
    const newPid = livePid();
    expect(acquire(pool, 'new', newPid).status).toBe(0);
    const pin = { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock` };
    // owner right, pid wrong
    const a = sub(pool, ['release', 'new'], oldPid, { env: pin });
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('release refused');
    expect(a.stderr).toContain(`pid ${newPid}`);
    expect(a.stderr).toContain(`pid ${oldPid}`);
    // pid right, owner wrong
    const b = sub(pool, ['release', 'old'], newPid, { env: pin });
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('release refused');
    expect(b.stderr).toContain('held by new');
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'new', pid: String(newPid) });
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    const ok = sub(pool, ['release', 'new'], newPid, { env: pin });
    expect(ok.status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });

  it('D7 an unpinned release by a caller that holds nothing exits 0 "nothing to release" and removes nobody’s slot', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'someone-else' });
    const before = listing(pool);
    const r = sub(pool, ['release', 'mine'], livePid());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`gate-lock: nothing to release (${pool}/gate.lock)\n`);
    expect(listing(pool)).toEqual(before);
  });

  it('D7 an unpinned release with the right pid but another lane has nothing to release; the slot stays', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'theirs', pid });
    const before = listing(pool);
    const r = sub(pool, ['release', 'mine'], pid);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to release');
    expect(listing(pool)).toEqual(before);
  });

  it('D12 a removal that fails half way puts the slot back: exit 1 release failed, nothing left aside', () => {
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
      expect(r.stderr).toContain('release failed');
      expect(names(pool)).toEqual(['.format', 'gate.lock']);
    } finally {
      fs.chmodSync(inner, 0o700);
    }
  });

  it('T22 a release that cannot remove the slot (read-only slot directory) is exit 1 "release failed"; the slot remains', () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const dir = path.join(pool, 'gate.lock');
    const before = listing(pool);
    fs.chmodSync(dir, 0o500);
    try {
      const r = sub(pool, ['release', 'lane'], pid);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('release failed');
      expect(r.stderr).not.toContain('released');
      expect(names(pool)).toEqual(['.format', 'gate.lock']);
      expect(names(dir)).toEqual(SIX);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(listing(pool).map((l) => l.replace(/^0500/, '0700'))).toEqual(
      before.map((l) => l.replace(/^0500/, '0700')),
    );
  });

  it('D12 a slot replaced between the check and the rename-aside is put back untouched: refused, no aside', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const hook = path.join(scratchOf(pool), 'hook-aside');
    const { done } = startBin(['release', 'lane'], {
      env: {
        ...TM,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: hook,
      },
      cwd: wtDir(pool),
    });
    await waitForFile(hook);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'intruder', pid: livePid() });
    const written = readSlot(pool, 'gate.lock');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release refused');
    expect(readSlot(pool, 'gate.lock')).toEqual(written);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });

  it('D12 when the name was taken meanwhile the moved slot is left aside, never deleted', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const aside = path.join(scratchOf(pool), 'hook-aside');
    const restore = path.join(scratchOf(pool), 'hook-restore');
    const { child, done } = startBin(['release', 'lane'], {
      env: {
        ...TM,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        GATE_LOCK_TEST_PAUSE_BEFORE_ASIDE: aside,
        GATE_LOCK_TEST_PAUSE_BEFORE_RESTORE: restore,
      },
      cwd: wtDir(pool),
    });
    await waitForFile(aside);
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'intruder', pid: livePid() });
    const intruder = readSlot(pool, 'gate.lock');
    releaseHook(aside);
    await waitForFile(restore);
    const third = livePid();
    seed(pool, 'gate.lock', { owner: 'third', pid: third });
    const thirdBytes = readSlot(pool, 'gate.lock');
    releaseHook(restore);
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('never deleted');
    expect(readSlot(pool, 'gate.lock')).toEqual(thirdBytes);
    const asides = names(pool).filter((n) => n.includes('.reclaim.'));
    expect(asides).toHaveLength(1);
    expect(asides[0].startsWith(`gate.lock.reclaim.${child.pid}.`)).toBe(true);
    expect(readSlot(pool, asides[0])).toEqual(intruder);
  });
});

describe('verify (C18-C20)', () => {
  it('C18 a holder that is still the holder verifies silently with exit 0', () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    expect(sub(pool, ['verify', 'lane'], pid)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('C19 a missing slot is exit 1 naming verify, no lock and the path', () => {
    const pool = freshPool();
    const r = sub(pool, ['verify', 'lane'], livePid());
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`gate-lock: verify: no lock at ${pool}/gate.lock\n`);
  });

  it('C19 / T49 a stranger pid, or a wrong lane, never verifies through someone else’s slot', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'lane', pid });
    const stranger = sub(pool, ['verify', 'lane'], livePid());
    expect(stranger.status).toBe(1);
    expect(stranger.stderr).toContain('verify failed');
    expect(stranger.stderr).toContain('held by lane');
    expect(stranger.stderr).toContain(`pid ${pid}`);
    const wrongLane = sub(pool, ['verify', 'other'], pid);
    expect(wrongLane.status).toBe(1);
    expect(wrongLane.stderr).toContain('verify failed');
  });

  it('T49 unpinned calls find the caller’s own slot among several; heartbeat moves only that beat; release removes only it', () => {
    const pool = freshPool();
    const env = { GATE_LOCK_SLOTS: '2' };
    const [p0, p1] = [livePid(), livePid()];
    seedOld(pool, 'gate.lock', { owner: 'zero', pid: p0 });
    seedOld(pool, 'gate.lock.1', { owner: 'one', pid: p1 });
    expect(sub(pool, ['verify', 'zero'], p0, { env }).status).toBe(0);
    expect(sub(pool, ['verify', 'one'], p1, { env }).status).toBe(0);
    expect(sub(pool, ['verify', 'zero'], p1, { env }).status).toBe(1);
    expect(sub(pool, ['heartbeat'], p1, { env }).status).toBe(0);
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
    expect(Number(readSlot(pool, 'gate.lock.1').beat)).toBeGreaterThan(1000);
    const rel = sub(pool, ['release', 'one'], p1, { env });
    expect(rel.stdout).toContain(`released by one (${pool}/gate.lock.1)`);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('a holder only in slot 1 verifies unpinned (the scan finds it, no slot 0 fallback needed)', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock.1', { owner: 'one', pid });
    expect(sub(pool, ['verify', 'one'], pid).status).toBe(0);
  });
});

describe('T59-T66 forged slots and pins', () => {
  it('T59 planted non-canonical names carrying a real holder’s owner and pid are invisible and untouched', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock.1', { owner: 'real', pid });
    seedOld(pool, 'gate.lock.0', { owner: 'real', pid });
    seedOld(pool, 'gate.lock.007', { owner: 'real', pid });
    const st = sub(pool, ['status'], undefined);
    expect(st.stdout.trimEnd().split('\n')).toHaveLength(2);
    expect(st.stdout).toContain(`${pool}/gate.lock.1 held by real`);
    expect(sub(pool, ['heartbeat'], pid).status).toBe(0);
    expect(Number(readSlot(pool, 'gate.lock.1').beat)).toBeGreaterThan(1000);
    expect(readSlot(pool, 'gate.lock.0').beat).toBe('1000');
    expect(readSlot(pool, 'gate.lock.007').beat).toBe('1000');
    expect(sub(pool, ['verify', 'real'], pid).status).toBe(0);
    expect(sub(pool, ['release', 'real'], pid).status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock.0', 'gate.lock.007']);
  });

  it('F19 the names .64, .100 and .01 are not slots either', () => {
    const pool = freshPool();
    for (const n of ['gate.lock.64', 'gate.lock.100', 'gate.lock.01', 'gate.lock.']) {
      seed(pool, n, { owner: 'plant' });
    }
    expect(sub(pool, ['status'], undefined).stdout).toContain('free:');
  });

  it('T60 a symlink at a canonical name is invisible: the real slot beats, the link target does not', () => {
    const pool = freshPool();
    const pid = livePid();
    const target = path.join(scratchOf(pool), 'target');
    seedOld(scratchOf(pool), 'target', { owner: 'real', pid });
    fs.symlinkSync(target, path.join(pool, 'gate.lock'));
    seedOld(pool, 'gate.lock.1', { owner: 'real', pid });
    const st = sub(pool, ['status'], undefined);
    expect(st.stdout.trimEnd().split('\n')).toHaveLength(2);
    expect(sub(pool, ['heartbeat'], pid).status).toBe(0);
    expect(Number(readSlot(pool, 'gate.lock.1').beat)).toBeGreaterThan(1000);
    expect(fs.readFileSync(path.join(target, 'beat'), 'utf8')).toBe('1000\n');
    expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
  });

  it('T62 a pinned heartbeat refreshes the pinned slot and not decoys carrying the same owner and pid', () => {
    const pool = freshPool();
    const pid = livePid();
    for (const n of ['gate.lock', 'gate.lock.1', 'gate.lock.2']) {
      seedOld(pool, n, { owner: 'lane', pid });
    }
    const r = sub(pool, ['heartbeat'], pid, {
      env: { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.1` },
    });
    expect(r.status).toBe(0);
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
    expect(Number(readSlot(pool, 'gate.lock.1').beat)).toBeGreaterThan(1000);
    expect(readSlot(pool, 'gate.lock.2').beat).toBe('1000');
  });

  it('T66 / C24 a pid in two slots: pinned to the second refreshes only it; unpinned takes the first', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'a', pid });
    seedOld(pool, 'gate.lock.1', { owner: 'b', pid });
    sub(pool, ['heartbeat'], pid, { env: { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.1` } });
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
    expect(Number(readSlot(pool, 'gate.lock.1').beat)).toBeGreaterThan(1000);
    const pool2 = freshPool();
    seedOld(pool2, 'gate.lock', { owner: 'a', pid });
    seedOld(pool2, 'gate.lock.1', { owner: 'b', pid });
    sub(pool2, ['heartbeat'], pid);
    expect(Number(readSlot(pool2, 'gate.lock').beat)).toBeGreaterThan(1000);
    expect(readSlot(pool2, 'gate.lock.1').beat).toBe('1000');
  });

  describe('T63 bad pins are refused by verify, heartbeat and release with exit 2 naming the pin', () => {
    const run = (pool, pin, pid, env = {}) =>
      ['verify', 'heartbeat', 'release'].map((c) =>
        sub(pool, c === 'heartbeat' ? [c] : [c, 'lane'], pid, {
          env: { GATE_LOCK_SLOT_PATH: pin, ...env },
        }),
      );
    const refused = (results, pin, snippet) => {
      for (const r of results) {
        expect(r.status).toBe(2);
        expect(r.stdout).toBe('');
        expect(r.stderr).toContain(pin);
        expect(r.stderr).toContain(snippet);
      }
    };

    it('a .0 name and a .64 name are not slots on this host', () => {
      const pool = freshPool();
      const pid = livePid();
      seedOld(pool, 'gate.lock', { owner: 'lane', pid });
      for (const name of ['gate.lock.0', 'gate.lock.64', 'gate.lock.007']) {
        seedOld(pool, name, { owner: 'lane', pid });
        refused(run(pool, `${pool}/${name}`, pid), `${pool}/${name}`, 'is not a slot on this host');
      }
      expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
      expect(names(pool)).toEqual([
        '.format',
        'gate.lock',
        'gate.lock.0',
        'gate.lock.007',
        'gate.lock.64',
      ]);
    });

    it('a name that exists nowhere, outside the pool, with a trailing slash or relative, is not a slot either', () => {
      const pool = freshPool();
      const pid = livePid();
      const other = freshPool();
      for (const pin of [
        `${other}/gate.lock`,
        `${pool}/gate.lock/`,
        `${pool}//gate.lock`,
        'gate.lock',
        `${pool}/gate.lock.1/../gate.lock`,
        `${pool}/x/gate.lock`,
      ]) {
        refused(run(pool, pin, pid), pin, 'is not a slot on this host');
      }
    });

    it('a symlink at a canonical name is left alone: the link and its target survive', () => {
      const pool = freshPool();
      const pid = livePid();
      const target = path.join(scratchOf(pool), 'target');
      seedOld(scratchOf(pool), 'target', { owner: 'lane', pid });
      fs.symlinkSync(target, path.join(pool, 'gate.lock'));
      refused(run(pool, `${pool}/gate.lock`, pid), `${pool}/gate.lock`, 'left alone');
      expect(fs.lstatSync(path.join(pool, 'gate.lock')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(target, 'beat'), 'utf8')).toBe('1000\n');
      expect(names(target)).toEqual(SIX);
    });

    it('a real slot judged under a foreign uid seam is left alone: beat unchanged, slot still there', () => {
      const pool = freshPool();
      const pid = livePid();
      seedOld(pool, 'gate.lock', { owner: 'lane', pid });
      refused(run(pool, `${pool}/gate.lock`, pid, FOREIGN), `${pool}/gate.lock`, 'left alone');
      expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
      expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    });

    it('a regular file at a canonical name is left alone too', () => {
      const pool = freshPool();
      writeRaw(pool, 'gate.lock', 'file\n');
      refused(run(pool, `${pool}/gate.lock`, livePid()), `${pool}/gate.lock`, 'left alone');
      expect(fs.readFileSync(path.join(pool, 'gate.lock'), 'utf8')).toBe('file\n');
    });
  });

  it('F64 a canonical pin that does not exist is a lost lock: verify and heartbeat exit 1, release exits 0 nothing to release', () => {
    const pool = freshPool();
    const pid = livePid();
    seedOld(pool, 'gate.lock', { owner: 'lane', pid });
    const pin = { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.3` };
    const v = sub(pool, ['verify', 'lane'], pid, { env: pin });
    expect(v.status).toBe(1);
    expect(v.stderr).toContain('no lock');
    expect(v.stderr).toContain(`${pool}/gate.lock.3`);
    const h = sub(pool, ['heartbeat'], pid, { env: pin });
    expect(h.status).toBe(1);
    expect(h.stderr).toContain('no lock');
    const r = sub(pool, ['release', 'lane'], pid, { env: pin });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`gate-lock: nothing to release (${pool}/gate.lock.3)\n`);
    expect(readSlot(pool, 'gate.lock').beat).toBe('1000');
  });

  it('R12 / F62 a pinned verify and release act on the pinned slot only, whatever sorts first', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'lane', pid });
    seed(pool, 'gate.lock.1', { owner: 'lane', pid });
    const pin = { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.1` };
    expect(sub(pool, ['verify', 'lane'], pid, { env: pin }).status).toBe(0);
    const r = sub(pool, ['release', 'lane'], pid, { env: pin });
    expect(r.stdout).toContain(`released by lane (${pool}/gate.lock.1)`);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('F65 a bad pin is exit 2, never exit 1 (not answered as a lost lock)', () => {
    const pool = freshPool();
    const r = sub(pool, ['verify', 'lane'], livePid(), {
      env: { GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.64` },
    });
    expect(r.status).toBe(2);
  });

  it('an empty GATE_LOCK_SLOT_PATH is no pin', () => {
    const pool = freshPool();
    const pid = livePid();
    seed(pool, 'gate.lock', { owner: 'lane', pid });
    expect(sub(pool, ['verify', 'lane'], pid, { env: { GATE_LOCK_SLOT_PATH: '' } }).status).toBe(0);
  });
});

describe('caller pid for the other subcommands', () => {
  it('release, verify and heartbeat without a caller pid are refused (exit 2) naming the variable', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'lane' });
    const before = listing(pool);
    for (const args of [['release', 'lane'], ['verify', 'lane'], ['heartbeat']]) {
      const r = sub(pool, args, undefined);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('GATE_LOCK_CALLER_PID');
    }
    expect(listing(pool)).toEqual(before);
  });
});

describe('T69 / T84 slots in the pool', () => {
  it('T69 at count 2 two acquires from two worktrees fill slot 0 and 1 in the pool; nothing lands in the temp directory', () => {
    const pool = freshPool();
    const tmp = path.join(scratchOf(pool), 'tmp-elsewhere');
    fs.mkdirSync(tmp);
    const env = { GATE_LOCK_SLOTS: '2', TMPDIR: tmp };
    const a = acquire(pool, 'lane-a', livePid(), { env, cwd: wtDir(pool, 'wt-a') });
    const b = acquire(pool, 'lane-b', livePid(), { env, cwd: wtDir(pool, 'wt-b') });
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    expect(names(path.join(pool, 'gate.lock.1'))).toEqual(SIX);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(readSlot(pool, 'gate.lock.1')).toMatchObject({ owner: 'lane-b', project: 'wt-b' });
  });

  it('T84 a pool of six derived slots runs six gates at once and refuses the seventh', () => {
    const pool = freshPool();
    const env = {
      ...TM,
      GATE_HOST_WORKERS: '4',
      GATE_LOCK_TEST_NPROC: '24',
      GATE_LOCK_SLOTS: undefined,
    };
    for (let i = 0; i < 6; i++) {
      const r = acquire(pool, `lane${i}`, livePid(), { env, cwd: wtDir(pool, `wt${i}`) });
      expect(r.status, r.stderr).toBe(0);
    }
    const seventh = acquire(pool, 'lane6', livePid(), { env, cwd: wtDir(pool, 'wt6') });
    expect(seventh.status).toBe(75);
    expect(seventh.stderr).toContain('busy');
    expect(seventh.stderr).toContain('lane0');
    expect(names(pool)).toEqual([
      '.format',
      'gate.lock',
      'gate.lock.1',
      'gate.lock.2',
      'gate.lock.3',
      'gate.lock.4',
      'gate.lock.5',
    ]);
  }, 60000);
});
