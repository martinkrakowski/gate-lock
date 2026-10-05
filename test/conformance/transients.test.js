// F20-F23, D16: transient names and the janitor. Fixtures are written directly per §2.
import { describe, expect, it } from 'vitest';
import {
  freshPool,
  deadPid,
  lockEnv,
  names,
  nowS,
  runCli,
  setAge,
  writeSlot,
  writeTransient,
  wtDir,
} from './helpers.js';

describe('F20-F23 transient names', () => {
  it('T48 status lists slots (including beyond count) and never lists transients', () => {
    const pool = freshPool();
    const now = nowS();
    const dead = deadPid();
    // Slot 0 is within the configured count.
    writeSlot(pool, 'gate.lock', {
      owner: 'holder',
      pid: dead,
      started: now,
      beat: now,
      worktree: '/x',
      project: 'x',
    });
    // Slot 1 is beyond the configured count of 1, but status must still list it.
    writeSlot(pool, 'gate.lock.1', {
      owner: 'beyond',
      pid: dead,
      started: now,
      beat: now,
      worktree: '/y',
      project: 'y',
    });
    // Transients that must not appear in status.
    writeTransient(pool, 'gate.lock.cand.12345');
    writeTransient(pool, 'gate.lock.beatnew.12345');
    writeTransient(pool, 'gate.lock.reclaim.12345.1');
    writeTransient(pool, '.format.tmp.12345');
    const r = runCli(['status'], { env: { ...lockEnv(pool), GATE_LOCK_SLOTS: '1' }, cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gate.lock held by holder');
    expect(r.stdout).toContain('gate.lock.1 held by beyond');
    expect(r.stdout).not.toContain('cand');
    expect(r.stdout).not.toContain('beatnew');
    expect(r.stdout).not.toContain('reclaim');
    expect(r.stdout).not.toContain('format.tmp');
  });

  it('F19 non-canonical names (.0, .007, .64, .100) are not slot names', () => {
    const pool = freshPool();
    const now = nowS();
    const dead = deadPid();
    // Plant directories at each name from F19: they carry a real holder's owner
    // and pid and sort before slot 1, but must not be read as slots.
    for (const name of ['gate.lock.0', 'gate.lock.007', 'gate.lock.64', 'gate.lock.100']) {
      writeSlot(pool, name, {
        owner: 'planter',
        pid: dead,
        started: now,
        beat: now,
        worktree: '/x',
        project: 'x',
      });
    }
    // Also plant a transient at one of the names to make sure the F21 transient
    // filter is what keeps it out, not the name filter.
    writeTransient(pool, 'gate.lock.0.cand.1');
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('free:');
    expect(r.stdout).not.toMatch(/gate\.lock\.0/);
    expect(r.stdout).not.toMatch(/gate\.lock\.007/);
    expect(r.stdout).not.toMatch(/gate\.lock\.64\b/);
    expect(r.stdout).not.toMatch(/gate\.lock\.100/);
  });

   it('D16 clean removes a stale transient whose creator pid is dead and is older than the threshold', () => {
    const pool = freshPool();
    const creator = deadPid();
    const t = writeTransient(pool, `gate.lock.cand.${creator}`);
    setAge(t, 700);
    const r = runCli(['clean'], {
      env: { ...lockEnv(pool), GATE_LOCK_STALE_SECONDS: '600' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`janitor: removed gate\\.lock\\.cand\\.${creator}`));
    expect(names(pool)).toEqual(['.format']);
  });
});
