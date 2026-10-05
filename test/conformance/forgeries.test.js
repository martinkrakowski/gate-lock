// F57-F61: forged-slot identification. Fixtures are planted directly per §2.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshPool, lockEnv, nowS, runCli, writeSlot, wtDir } from './helpers.js';

const TM = { GATE_LOCK_TEST_MODE: '1' };

describe('F57-F61 forged and foreign slots', () => {
  it('T59 non-canonical names (.0, .007) carrying a real holder are invisible to status', () => {
    const pool = freshPool();
    const now = nowS();
    writeSlot(pool, 'gate.lock.1', {
      owner: 'real',
      pid: 999990,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    // Non-canonical name carrying the same owner/pid: must not be read as a slot.
    writeSlot(pool, 'gate.lock.1.cand.42', {
      owner: 'real',
      pid: 999990,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    const r = runCli(['status'], { env: { ...lockEnv(pool), ...TM }, cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gate.lock.1 held by real');
    expect(r.stdout).not.toMatch(/gate\.lock\.1\.cand/);
  });

  it('T60 a symlink at a canonical name is invisible to status', () => {
    const pool = freshPool();
    const scratch = wtDir(pool);
    const target = path.join(scratch, 'real-slot');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
    const now = nowS();
    writeSlot(target, 'gate.lock', {
      owner: 'real',
      pid: 999989,
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
    writeSlot(
      pool,
      'gate.lock',
      {
        owner: 'foreigner',
        pid: 999988,
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
    writeSlot(target, 'gate.lock', {
      owner: 'holder',
      pid: 4242,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    const linkPath = path.join(pool, 'gate.lock');
    fs.symlinkSync(target, linkPath);
    const r = runCli(['release', 'holder'], {
      env: { ...lockEnv(pool, TM), GATE_LOCK_SLOT_PATH: linkPath, GATE_LOCK_CALLER_PID: '4242' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not a valid slot/);
    expect(fs.existsSync(path.join(pool, 'gate.lock', 'owner'))).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});
