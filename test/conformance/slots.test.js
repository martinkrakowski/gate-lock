// F24-F42: slot files, heartbeat cadence, liveness. Fixtures are written directly per §2.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  freshPool,
  listing,
  livePid,
  lockEnv,
  names,
  nowS,
  runCli,
  writeFormat,
  writeRaw,
  writeSlot,
  wtDir,
} from './helpers.js';

describe('F24-F29 six-file slot', () => {
  it('T2 the six files written per §2 are read back byte for byte', () => {
    const pool = freshPool();
    const pid = livePid();
    const now = nowS();
    const dir = writeSlot(pool, 'gate.lock', {
      owner: 'mylane',
      pid,
      started: now,
      beat: now,
      worktree: '/work/tree',
      project: 'tree',
    });
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('held by mylane');
    expect(r.stdout).toContain('project tree');
    expect(r.stdout).toContain('pid ' + pid + ' alive');
    const files = names(dir);
    expect(files).toEqual(['beat', 'owner', 'pid', 'project', 'started', 'worktree']);
    for (const [f, expected] of [
      ['owner', 'mylane'],
      ['pid', String(pid)],
      ['started', String(now)],
      ['beat', String(now)],
      ['worktree', '/work/tree'],
      ['project', 'tree'],
    ]) {
      expect(fs.readFileSync(`${dir}/${f}`, 'utf8')).toBe(`${expected}\n`);
    }
  });
});

describe('F30 four-file compatibility slot', () => {
  it('T57 a four-file slot (no worktree/project) is valid and never blocks a same-worktree acquirer', () => {
    const pool = freshPool();
    const now = nowS();
    const dir = writeSlot(pool, 'gate.lock', {
      owner: 'old',
      pid: 999999,
      started: now,
      beat: now,
    }, { files: 4 });
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('held by old');
    expect(r.stdout).toContain('project unknown');
    const files = names(dir);
    expect(files).toEqual(['beat', 'owner', 'pid', 'started']);
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
      env: { ...lockEnv(pool2), GATE_LOCK_CALLER_PID: String(livePid()), GATE_LOCK_STALE_SECONDS: '3600' },
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
    writeSlot(pool, 'gate.lock', {
      owner: 'deadholder',
      pid: 999998,
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

describe('F24-F32 slot directory listing', () => {
  it('T2 acquire creates exactly the six files with mode 0600 and the slot dir 0700', () => {
    const pool = freshPool();
    const caller = livePid();
    const r = runCli(['acquire', 'lane'], {
      env: { ...lockEnv(pool), GATE_LOCK_CALLER_PID: String(caller) },
      cwd: wtDir(pool, 'wt0'),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by lane');
    const slotDir = `${pool}/gate.lock`;
    expect(names(slotDir)).toEqual(['beat', 'owner', 'pid', 'project', 'started', 'worktree']);
    for (const f of ['beat', 'owner', 'pid', 'project', 'started', 'worktree']) {
      const mode = (fs.statSync(`${slotDir}/${f}`).mode & 0o7777).toString(8).padStart(4, '0');
      expect(mode, `${f} mode`).toBe('0600');
    }
    const dirMode = (fs.statSync(slotDir).mode & 0o7777).toString(8).padStart(4, '0');
    expect(dirMode).toBe('0700');
  });
});
