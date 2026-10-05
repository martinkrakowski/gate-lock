// C6-C12, F43-F51: acquire, reclaim, busy. Fixtures are planted directly per §2.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { freshPool, lockEnv, names, nowS, runCli, writeSlot, wtDir } from './helpers.js';

describe('C6-C12 acquire', () => {
  it('T3 acquire with no caller pid is refused (exit 2), stderr names the variable, nothing created', () => {
    const pool = freshPool();
    const r = runCli(['acquire', 'lane'], {
      env: lockEnv(pool),
      cwd: wtDir(pool, 'wt0'),
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/GATE_LOCK_CALLER_PID/);
    expect(names(pool)).toEqual(['.format']);
  });

  it('T2 acquire with an explicit caller pid exits 0, prints acquired line, and holds the lane/pid', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const r = runCli(['acquire', 'mylane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('acquired by mylane');
      expect(r.stdout).toContain(`at ${pool}/gate.lock`);
      expect(fs.readFileSync(`${pool}/gate.lock/owner`, 'utf8')).toBe('mylane\n');
      expect(fs.readFileSync(`${pool}/gate.lock/pid`, 'utf8')).toBe(`${child.pid}\n`);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('T6 a dead pid is reclaimed: exit 0, stdout contains "reclaiming" and "not alive"', () => {
    const pool = freshPool();
    const now = nowS();
    writeSlot(pool, 'gate.lock', {
      owner: 'deadholder',
      pid: 999996,
      started: now - 600,
      beat: now - 600,
      worktree: '/old',
      project: 'old',
    });
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const r = runCli(['acquire', 'newlane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt1'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/reclaiming/);
      expect(r.stdout).toMatch(/not alive/);
      expect(fs.readFileSync(`${pool}/gate.lock/owner`, 'utf8')).toBe('newlane\n');
      expect(fs.readFileSync(`${pool}/gate.lock/pid`, 'utf8')).toBe(`${child.pid}\n`);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('T10 an abandoned slot with only owner (no pid, no beat) is reclaimed', () => {
    const pool = freshPool();
    const slotDir = `${pool}/gate.lock`;
    fs.mkdirSync(slotDir, { mode: 0o700 });
    fs.chmodSync(slotDir, 0o700);
    fs.writeFileSync(`${slotDir}/owner`, 'orphanned\n', { mode: 0o600 });
    fs.chmodSync(`${slotDir}/owner`, 0o600);
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const r = runCli(['acquire', 'claimer'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/reclaiming/);
      expect(fs.readFileSync(`${slotDir}/owner`, 'utf8')).toBe('claimer\n');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('F43-F51 reclaim rules', () => {
  it('T54 a dead same-worktree holder in slot 1 does not block an acquire into slot 0', () => {
    const pool = freshPool();
    const now = nowS();
    writeSlot(pool, 'gate.lock.1', {
      owner: 'deadholder',
      pid: 999995,
      started: now - 700,
      beat: now - 700,
      worktree: '/work',
      project: 'work',
    });
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const r = runCli(['acquire', 'newlane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid), GATE_LOCK_SLOTS: '2' },
        cwd: wtDir(pool, 'wd'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('acquired by newlane');
      expect(names(pool)).toContain('gate.lock');
      expect(names(pool)).toContain('gate.lock.1');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
