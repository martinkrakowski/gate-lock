// F57-F61: forged-slot identification. Fixtures are planted directly per §2.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshPool, deadPid, livePid, lockEnv, nowS, runCli, writeSlot, wtDir } from './helpers.js';

const TM = { GATE_LOCK_TEST_MODE: '1' };

describe('F57-F61 forged and foreign slots', () => {
  it('T59 non-canonical names (.0, .007) carrying a real holder are invisible to status; an unpinned heartbeat moves only the real slot', () => {
    const pool = freshPool();
    const pid = livePid();
    const now = nowS();
    const oldBeat = now - 700;
    // Real holder at canonical slot 1, with a stale beat so the heartbeat will move it.
    const realDir = writeSlot(pool, 'gate.lock.1', {
      owner: 'real',
      pid,
      started: now - 700,
      beat: oldBeat,
      worktree: '/wt',
      project: 'wt',
    });
    // Non-canonical names carrying the same owner/pid: must not be read as slots (F19).
    const planted = ['gate.lock.0', 'gate.lock.007'];
    for (const name of planted) {
      writeSlot(pool, name, {
        owner: 'real',
        pid,
        started: now - 700,
        beat: oldBeat,
        worktree: '/wt',
        project: 'wt',
      });
    }
    const r = runCli(['status'], { env: { ...lockEnv(pool), ...TM }, cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    // Only the canonical name shows up as held.
    expect(r.stdout).toContain('gate.lock.1 held by real');
    expect(r.stdout).not.toMatch(/gate\.lock\.0/);
    expect(r.stdout).not.toMatch(/gate\.lock\.007/);
    // Unpinned heartbeat moves only the real slot's beat, not the plants'.
    const beatBefore = fs.readFileSync(`${path.join(pool, 'gate.lock.1', 'beat')}`, 'utf8');
    expect(beatBefore, 'real beat is the seeded old value').toBe(`${oldBeat}\n`);

    const hb = runCli(['heartbeat'], {
      env: { ...lockEnv(pool, TM), GATE_LOCK_CALLER_PID: String(pid) },
      cwd: wtDir(pool, 'wt0'),
    });
    expect(hb.status).toBe(0);
    // The real slot's beat moved past the seeded value.
    const beatAfter = fs.readFileSync(`${realDir}/beat`, 'utf8');
    expect(beatAfter, 'beat moved').not.toBe(beatBefore);
    // The planted directories' beats are untouched.
    for (const dir of planted) {
      expect(fs.readFileSync(`${path.join(pool, dir, 'beat')}`, 'utf8'), 'plant beat').toBe(
        beatBefore,
      );
    }
  });

  it('T60 a symlink at a canonical name is invisible to status', () => {
    const pool = freshPool();
    const scratch = wtDir(pool);
    const target = path.join(scratch, 'real-slot');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
    const now = nowS();
    const dead = deadPid();
    writeSlot(target, 'gate.lock', {
      owner: 'real',
      pid: dead,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    const linkPath = path.join(pool, 'gate.lock');
    fs.symlinkSync(target, linkPath);
    const r = runCli(['status'], { env: { ...lockEnv(pool), ...TM }, cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('free:');
  });

  it('T61 a slot owned by a different uid is invisible (uid seam)', () => {
    const pool = freshPool();
    const now = nowS();
    const dead = deadPid();
    writeSlot(
      pool,
      'gate.lock',
      {
        owner: 'foreigner',
        pid: dead,
        started: now,
        beat: now,
        worktree: '/wt',
        project: 'wt',
      },
      { dirMode: 0o755, fileMode: 0o644 },
    );
    // With the uid seam naming a foreign uid, the slot is invisible.
    const r = runCli(['status'], {
      env: { ...lockEnv(pool, TM), GATE_LOCK_TEST_SLOT_UID: '65534' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('free:');

    // Without the seam, the slot shows up (proves the seam, not a blanket filter).
    const r2 = runCli(['status'], { env: { ...lockEnv(pool), ...TM }, cwd: wtDir(pool) });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('held by foreigner');
  });

  it('T63 a bad pin (symlink at canonical name) is refused by release (exit 2)', () => {
    const pool = freshPool();
    const scratch = wtDir(pool);
    const target = path.join(scratch, 'fake-slot');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
    const now = nowS();
    const dead = deadPid();
    writeSlot(target, 'gate.lock', {
      owner: 'holder',
      pid: dead,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    const linkPath = path.join(pool, 'gate.lock');
    fs.symlinkSync(target, linkPath);
    const r = runCli(['release', 'holder'], {
      env: { ...lockEnv(pool, TM), GATE_LOCK_SLOT_PATH: linkPath, GATE_LOCK_CALLER_PID: String(dead) },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not a valid slot/);
    // The symlink is left in place (still a symlink), and the target's slot is untouched.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'gate.lock', 'owner'), 'utf8')).toBe('holder\n');
    expect(fs.existsSync(target)).toBe(true);
  });
});
