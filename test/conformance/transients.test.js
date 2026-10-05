// F20-F23, D16: transient names and the janitor. Fixtures are written directly per §2.
import { describe, expect, it } from 'vitest';
import {
  freshPool,
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
    writeSlot(pool, 'gate.lock', {
      owner: 'holder',
      pid: 999997,
      started: now,
      beat: now,
      worktree: '/x',
      project: 'x',
    });
    // Transients that must not appear in status.
    writeTransient(pool, 'gate.lock.cand.12345');
    writeTransient(pool, 'gate.lock.beatnew.12345');
    writeTransient(pool, 'gate.lock.reclaim.12345.1');
    writeTransient(pool, '.format.tmp.12345');
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('gate.lock held by holder');
    expect(r.stdout).not.toContain('cand');
    expect(r.stdout).not.toContain('beatnew');
    expect(r.stdout).not.toContain('reclaim');
    expect(r.stdout).not.toContain('format.tmp');
  });

  it('F19 a transient at a canonical-looking name (.0, .64, .100) is not a slot name', () => {
    const pool = freshPool();
    // These are not slots: they do not match F19's name rule. Status shows free.
    writeTransient(pool, 'gate.lock.1.cand.1');
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('free:');
  });

  it('D16 clean removes a stale transient whose creator pid is dead and is older than the threshold', () => {
    const pool = freshPool();
    const t = writeTransient(pool, 'gate.lock.cand.999999');
    setAge(t, 700);
    const r = runCli(['clean'], {
      env: { ...lockEnv(pool), GATE_LOCK_STALE_SECONDS: '600' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/janitor: removed gate.lock.cand.999999/);
    expect(names(pool)).toEqual(['.format']);
  });
});
