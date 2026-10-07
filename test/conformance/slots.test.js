// F24-F42: slot files, heartbeat cadence, liveness. Fixtures are written directly per §2.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  freshPool,
  deadPid,
  livePid,
  lockEnv,
  names,
  nowS,
  runCli,
  writeSlot,
  wtDir,
} from './helpers.js';

describe('F24-F29 six-file slot', () => {
  it('T2 the six files per §2 are written by the CLI after a successful acquire', () => {
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
      const dir = `${pool}/gate.lock`;
      const files = names(dir);
      expect(files).toEqual(['beat', 'owner', 'pid', 'project', 'started', 'worktree']);
      for (const f of files) {
        const mode = (fs.statSync(`${dir}/${f}`).mode & 0o7777).toString(8).padStart(4, '0');
        expect(mode, `${f} mode`).toBe('0600');
      }
      expect(fs.readFileSync(`${dir}/owner`, 'utf8')).toBe('mylane\n');
      expect(fs.readFileSync(`${dir}/pid`, 'utf8')).toBe(`${child.pid}\n`);
      const dirMode = (fs.statSync(dir).mode & 0o7777).toString(8).padStart(4, '0');
      expect(dirMode).toBe('0700');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('F30 four-file compatibility slot', () => {
  it('T57 a four-file slot (no worktree/project) is valid and never blocks a same-worktree acquirer', () => {
    const pool = freshPool();
    const now = nowS();
    const live = livePid();
    const dir = writeSlot(
      pool,
      'gate.lock',
      {
        owner: 'old',
        pid: live,
        started: now,
        beat: now,
      },
      { files: 4 },
    );
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('held by old');
    expect(r.stdout).toContain('project unknown');
    const files = names(dir);
    expect(files).toEqual(['beat', 'owner', 'pid', 'started']);
    // A same-worktree acquirer is not blocked: the four-file holder has no worktree,
    // so the same-worktree scan finds no match, and the acquirer takes slot 1.
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    try {
      const a = runCli(['acquire', 'newlane'], {
        env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(child.pid), GATE_LOCK_SLOTS: '2' },
        cwd: wtDir(pool, 'wt1'),
      });
      expect(a.status).toBe(0);
      expect(a.stdout).toContain('acquired by newlane');
      // Slot 0 remains untouched: four files, same content, same pid.
      expect(names(dir)).toEqual(['beat', 'owner', 'pid', 'started']);
      expect(fs.readFileSync(`${dir}/pid`, 'utf8')).toBe(`${live}\n`);
      expect(fs.readFileSync(`${dir}/owner`, 'utf8')).toBe('old\n');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('F34-F38 heartbeat freshness and stale threshold', () => {
  it('T8 a widened threshold makes a 700s-old beat fresh; a tightened one reclaims it', () => {
    const pool = freshPool();
    const pid = livePid();
    const now = nowS();
    writeSlot(pool, 'gate.lock', {
      owner: 'oldholder',
      pid,
      started: now,
      beat: now - 700,
      worktree: '/somewhere',
      project: 'somewhere',
    });
    // Default threshold (600): 700s beat is stale.
    const r1 = runCli(['acquire', 'newlane'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(livePid()) },
      cwd: wtDir(pool, 'wt1'),
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/reclaiming.*stale/);

    // Fresh pool and holder, widened threshold makes it fresh.
    const pool2 = freshPool();
    writeSlot(pool2, 'gate.lock', {
      owner: 'oldholder',
      pid,
      started: now,
      beat: now - 700,
      worktree: '/somewhere',
      project: 'somewhere',
    });
    const r2 = runCli(['acquire', 'newlane'], {
      env: {
        ...lockEnv(pool2),
        GATE_LOCK_CALLER_PID: String(livePid()),
        GATE_LOCK_STALE_SECONDS: '3600',
      },
      cwd: wtDir(pool2, 'wt2'),
    });
    expect(r2.status).toBe(75);
    expect(r2.stderr).toMatch(/busy/);
  });
});

describe('F40-F42 liveness', () => {
  it('T6 a dead pid is reclaimed: exit 0, stdout contains "reclaiming" and "not alive"', () => {
    const pool = freshPool();
    const now = nowS();
    const dead = deadPid();
    writeSlot(pool, 'gate.lock', {
      owner: 'deadholder',
      pid: dead,
      started: now - 100,
      beat: now - 100,
      worktree: '/somewhere',
      project: 'somewhere',
    });
    const r = runCli(['acquire', 'newlane'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(livePid()) },
      cwd: wtDir(pool, 'wt1'),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/reclaiming/);
    expect(r.stdout).toMatch(/not alive/);
  });

  it('T5 a live holder with a fresh beat makes acquire exit 75 with "busy"', () => {
    const pool = freshPool();
    const pid = livePid();
    const now = nowS();
    writeSlot(pool, 'gate.lock', {
      owner: 'liveholder',
      pid,
      started: now,
      beat: now,
      worktree: '/elsewhere',
      project: 'elsewhere',
    });
    const r = runCli(['acquire', 'newlane2'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(livePid()) },
      cwd: wtDir(pool, 'wt2'),
    });
    expect(r.status).toBe(75);
    expect(r.stderr).toMatch(/busy/);
    expect(r.stderr).toMatch(/liveholder/);
  });
});

describe('F33 busy refusal leaves the holder untouched', () => {
  it('T5 a busy acquire leaves the holder slot byte-for-byte as found', () => {
    const pool = freshPool();
    const pid = livePid();
    const now = nowS();
    const dir = writeSlot(pool, 'gate.lock', {
      owner: 'holder',
      pid,
      started: now,
      beat: now,
      worktree: '/wt',
      project: 'wt',
    });
    // Snapshot every file's bytes before the busy acquire.
    const snapshot = {};
    for (const f of ['owner', 'pid', 'started', 'beat', 'worktree', 'project']) {
      snapshot[f] = fs.readFileSync(`${dir}/${f}`);
    }
    const snapshotNames = names(dir);
    const r = runCli(['acquire', 'newlane'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(livePid()) },
      cwd: wtDir(pool, 'wt1'),
    });
    expect(r.status).toBe(75);
    expect(r.stderr).toMatch(/busy/);
    // F33: the holder's directory contents are unchanged in name and bytes.
    expect(names(dir)).toEqual(snapshotNames);
    for (const [f, expected] of Object.entries(snapshot)) {
      expect(fs.readFileSync(`${dir}/${f}`), `${f} was modified`).toEqual(expected);
    }
  });
});
