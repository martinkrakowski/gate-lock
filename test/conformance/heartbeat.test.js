// C17-C23, F34-F42: heartbeat, verify, release. Fixtures are planted directly per §2.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  freshPool,
  lockEnv,
  names,
  nowS,
  runCli,
  writeSlot,
  wtDir,
} from './helpers.js';

describe('C17-C19 heartbeat', () => {
  it('T17 heartbeat moves the beat past the seeded value (1000), exit 0, silent', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const now = nowS();
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: child.pid,
        started: 1000,
        beat: 1000,
        worktree: '/wt',
        project: 'wt',
      });
      const r = runCli(['heartbeat'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      const beat = Number(fs.readFileSync(`${pool}/gate.lock/beat`, 'utf8').replace(/\n$/, ''));
      expect(beat).toBeGreaterThan(1000);
      expect(names(pool)).toEqual(['.format', 'gate.lock']);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('T18 heartbeat from a pid that is not the holder is refused; beat unchanged', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: 999994,
        started: nowS(),
        beat: nowS(),
        worktree: '/wt',
        project: 'wt',
      });
      const r = runCli(['heartbeat'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/heartbeat refused/);
      expect(fs.readFileSync(`${pool}/gate.lock/beat`, 'utf8')).toBe(`${nowS()}\n`);
      // The beat is unchanged (still the seeded value).
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('C22 heartbeat with no matching slot exits 1 with "no lock"', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const r = runCli(['heartbeat'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no lock/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('C18-C19 verify', () => {
  it('C18 verify exits 0 and prints nothing while the slot names this lane and pid', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: child.pid,
        started: nowS(),
        beat: nowS(),
        worktree: '/wt',
        project: 'wt',
      });
      const r = runCli(['verify', 'lane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('C19 verify with a stranger pid exits 1 and stderr contains "verify failed"', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: 999993,
        started: nowS(),
        beat: nowS(),
        worktree: '/wt',
        project: 'wt',
      });
      const r = runCli(['verify', 'lane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/verify failed/);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('C13-C17 release', () => {
  it('T20 release by the holder removes the slot (exit 0, "released by"); a second release is a clean no-op', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: child.pid,
        started: nowS(),
        beat: nowS(),
        worktree: '/wt',
        project: 'wt',
      });
      const r1 = runCli(['release', 'lane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r1.status).toBe(0);
      expect(r1.stdout).toMatch(/released by lane/);
      expect(names(pool)).toEqual(['.format']);

      // Second release: idempotent no-op.
      const r2 = runCli(['release', 'lane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid) },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r2.status).toBe(0);
      expect(r2.stdout).toMatch(/nothing to release/);
      expect(names(pool)).toEqual(['.format']);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('C21 release pinned to a slot with a wrong pid exits 1, stderr contains "release refused", slot untouched', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const now = nowS();
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: 999992,
        started: now,
        beat: now,
        worktree: '/wt',
        project: 'wt',
      });
      // Pin the slot: release finds it by the pin, checks owner and pid, and refuses.
      const r = runCli(['release', 'lane'], {
        env: {
          ...lockEnv(pool),
          GATE_LOCK_CALLER_PID: String(child.pid),
          GATE_LOCK_SLOT_PATH: `${pool}/gate.lock`,
        },
        cwd: wtDir(pool, 'wt0'),
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/release refused/);
      expect(fs.existsSync(`${pool}/gate.lock/owner`)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
