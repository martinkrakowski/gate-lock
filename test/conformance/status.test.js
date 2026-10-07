// C25, C27, T19, T82, T91: status output and read-only behaviour.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  freshPool,
  deadPid,
  lockEnv,
  nowS,
  runCli,
  writeRaw,
  writeSlot,
  wtDir,
} from './helpers.js';

describe('C25-C27 status', () => {
  it('T19 status on an empty host exits 0 and says "free"', () => {
    const pool = freshPool();
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^free:.*\nslots:/);
  });

  it('T19 status with a live holder shows the lane and "alive"', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const now = nowS();
      writeSlot(pool, 'gate.lock', {
        owner: 'worker',
        pid: child.pid,
        started: now,
        beat: now,
        worktree: '/repo',
        project: 'repo',
      });
      const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('gate.lock held by worker project repo');
      expect(r.stdout).toContain('pid ' + child.pid + ' alive');
      expect(r.stdout).toContain('heartbeat fresh');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('T91 status prints the project name per slot', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const now = nowS();
      writeSlot(pool, 'gate.lock', {
        owner: 'lane',
        pid: child.pid,
        started: now,
        beat: now,
        worktree: '/repo',
        project: 'repo',
      });
      const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('project repo');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('T19 status with a dead holder says "not alive"', () => {
    const pool = freshPool();
    const now = nowS();
    const dead = deadPid();
    writeSlot(pool, 'gate.lock', {
      owner: 'deadone',
      pid: dead,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`pid ${dead} not alive`);
  });
});

describe('C27 status --json', () => {
  it('T19 status --json gives a stable machine-readable form with version:1 and the slot', () => {
    const pool = freshPool();
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const now = nowS();
      writeSlot(pool, 'gate.lock', {
        owner: 'jsonlane',
        pid: child.pid,
        started: now,
        beat: now,
        worktree: '/repo',
        project: 'repo',
      });
      const r = runCli(['status', '--json'], { env: lockEnv(pool), cwd: wtDir(pool) });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      const obj = JSON.parse(r.stdout);
      expect(obj.version).toBe(1);
      expect(obj.format).toBe(1);
      expect(obj.slots.length).toBe(1);
      expect(obj.slots[0].owner).toBe('jsonlane');
      expect(obj.slots[0].project).toBe('repo');
      expect(obj.slots[0].pidAlive).toBe(true);
      expect(obj.slots[0].live).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('status --json on an empty pool has an empty slots array', () => {
    const pool = freshPool();
    const r = runCli(['status', '--json'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.version).toBe(1);
    expect(obj.slots).toEqual([]);
  });
});

describe('T70-T72 format marker via CLI', () => {
  it('T70 missing pool is created with .format holding 1\\n', () => {
    const pool = freshPool({ withFormat: false });
    const child = `${pool}/pool`;
    const r = runCli(['status'], {
      env: { GATE_LOCK_DIR: child, TMPDIR: '/tmp' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('free:');
    expect(fs.readFileSync(`${child}/.format`)).toEqual(Buffer.from('1\n'));
  });

  it('T72 a wrong marker value ("2") is refused before any slot is touched', () => {
    const pool = freshPool({ withFormat: false });
    writeRaw(pool, '.format', '2\n', 0o600);
    const r = runCli(['acquire', 'lane'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: '999990' },
      cwd: wtDir(pool, 'wt0'),
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/lock format/);
  });
});
