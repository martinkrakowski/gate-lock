import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEnv,
  freshPool,
  listing,
  scratchOf,
  testShell,
  writeFormat,
  writeSlot,
  writeTransient,
} from './harness.js';

describe('harness: environment isolation (T110, H14)', () => {
  it('T110 buildEnv never inherits GATE_*, XDG_RUNTIME_DIR or TMPDIR', () => {
    vi.stubEnv('GATE_LOCK_DIR', '/nope');
    vi.stubEnv('GATE_HOST_SLOTS', '9');
    vi.stubEnv('GATE_LOCK_SLOTS', '9');
    vi.stubEnv('XDG_RUNTIME_DIR', '/nope');
    vi.stubEnv('TMPDIR', '/nope');
    vi.stubEnv('SOME_OTHER_VAR', 'x');
    const env = buildEnv();
    expect(Object.keys(env).filter((k) => k.startsWith('GATE_'))).toEqual([]);
    expect(env).not.toHaveProperty('XDG_RUNTIME_DIR');
    expect(env).not.toHaveProperty('TMPDIR');
    expect(env).not.toHaveProperty('SOME_OTHER_VAR');
    expect(env.PATH).toBe(process.env.PATH);
    vi.unstubAllEnvs();
  });

  it('T110 a spawned process sees only the allow-list plus what the test sets', () => {
    vi.stubEnv('GATE_HOST_WORKERS', '7');
    vi.stubEnv('TMPDIR', '/nope');
    const out = execFileSync('/usr/bin/env', { env: buildEnv({ GATE_LOCK_SLOTS: '2' }) })
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')[0])
      .filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k));
    expect(out).toContain('GATE_LOCK_SLOTS');
    expect(out).not.toContain('GATE_HOST_WORKERS');
    expect(out).not.toContain('TMPDIR');
    vi.unstubAllEnvs();
  });

  it('T110 variables the test sets are passed, and undefined deletes a key', () => {
    const env = buildEnv({ GATE_LOCK_DIR: '/p', TMPDIR: '/t', PATH: undefined });
    expect(env.GATE_LOCK_DIR).toBe('/p');
    expect(env.TMPDIR).toBe('/t');
    expect(env).not.toHaveProperty('PATH');
  });

  it('GATE_LOCK_TEST_SHELL selects the shell and defaults to sh', () => {
    vi.stubEnv('GATE_LOCK_TEST_SHELL', '');
    expect(testShell()).toBe('sh');
    vi.stubEnv('GATE_LOCK_TEST_SHELL', 'bash --posix');
    expect(testShell()).toBe('bash --posix');
    vi.unstubAllEnvs();
  });
});

describe('harness: fresh pool (T111)', () => {
  let remembered;

  it('T111 freshPool is physically resolved, mode 0700, under os.tmpdir()', () => {
    const pool = freshPool();
    remembered = scratchOf(pool);
    expect(pool).toBe(fs.realpathSync(pool));
    expect(fs.realpathSync(os.tmpdir()) === path.dirname(remembered)).toBe(true);
    expect(fs.statSync(pool).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(remembered).mode & 0o7777).toBe(0o700);
    expect(fs.readdirSync(pool)).toEqual([]);
  });

  it('freshPool is auto-cleaned after each test', () => {
    expect(remembered).toBeTruthy();
    expect(fs.existsSync(remembered)).toBe(false);
  });

  it('freshPool({create:false}) names a pool that does not exist yet', () => {
    const pool = freshPool({ create: false });
    expect(fs.existsSync(pool)).toBe(false);
    expect(fs.existsSync(path.dirname(pool))).toBe(true);
  });

  it('two pools never collide', () => {
    expect(freshPool()).not.toBe(freshPool());
  });
});

describe('harness: spec-exact writers and listing', () => {
  const held = {
    owner: 'lane-a',
    pid: 123,
    started: 1000,
    beat: 1010,
    worktree: '/w/proj',
    project: 'proj',
  };

  it('writeSlot writes six one-line files byte for byte', () => {
    const pool = freshPool();
    const dir = writeSlot(pool, 'gate.lock', held);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'beat',
      'owner',
      'pid',
      'project',
      'started',
      'worktree',
    ]);
    expect(fs.readFileSync(path.join(dir, 'owner'), 'utf8')).toBe('lane-a\n');
    expect(fs.readFileSync(path.join(dir, 'pid'), 'utf8')).toBe('123\n');
    expect(fs.readFileSync(path.join(dir, 'beat'), 'utf8')).toBe('1010\n');
    expect(fs.readFileSync(path.join(dir, 'worktree'), 'utf8')).toBe('/w/proj\n');
    expect(fs.readFileSync(path.join(dir, 'project'), 'utf8')).toBe('proj\n');
  });

  it('writeSlot with files:4 omits worktree and project (F30)', () => {
    const pool = freshPool();
    const dir = writeSlot(pool, 'gate.lock.1', held, { files: 4 });
    expect(fs.readdirSync(dir).sort()).toEqual(['beat', 'owner', 'pid', 'started']);
  });

  it('writeFormat writes the marker with a trailing newline', () => {
    const pool = freshPool();
    writeFormat(pool, 1);
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    fs.rmSync(path.join(pool, '.format'));
    writeFormat(pool, 2);
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('2\n');
  });

  it('writeTransient makes directories for cand/reclaim and files for beatnew/format.tmp (F20, F23)', () => {
    const pool = freshPool();
    writeTransient(pool, 'gate.lock.cand.42');
    writeTransient(pool, 'gate.lock.reclaim.42.tok');
    writeTransient(pool, 'gate.lock.beatnew.42');
    writeTransient(pool, '.format.tmp.42');
    expect(listing(pool)).toEqual([
      '0600 .format.tmp.42',
      '0600 gate.lock.beatnew.42',
      '0700 gate.lock.cand.42/',
      '0700 gate.lock.reclaim.42.tok/',
    ]);
    expect(() => writeTransient(pool, 'gate.lock')).toThrow();
  });

  it('listing is sorted, relative and carries modes', () => {
    const pool = freshPool();
    writeFormat(pool);
    writeSlot(pool, 'gate.lock', held, { files: 4 });
    expect(listing(pool)).toEqual([
      '0644 .format',
      '0700 gate.lock/',
      '0600 gate.lock/beat',
      '0600 gate.lock/owner',
      '0600 gate.lock/pid',
      '0600 gate.lock/started',
    ]);
  });

  it('listing sorts by path like find | sort under LC_ALL=C', () => {
    const pool = freshPool();
    writeSlot(pool, 'gate.lock', held, { files: 4 });
    writeSlot(pool, 'gate.lock.1', held, { files: 4 });
    const paths = listing(pool).map((l) => l.slice(l.indexOf(' ') + 1));
    expect(paths.slice(0, 4)).toEqual([
      'gate.lock/',
      'gate.lock.1/',
      'gate.lock.1/beat',
      'gate.lock.1/owner',
    ]);
    expect(paths[paths.length - 1]).toBe('gate.lock/started');
  });

  it('listing shows symlinks and an empty pool is an empty list', () => {
    const pool = freshPool();
    expect(listing(pool)).toEqual([]);
    fs.symlinkSync('/elsewhere', path.join(pool, 'link'));
    expect(listing(pool)).toHaveLength(1);
    expect(listing(pool)[0]).toMatch(/^l\d{4} link -> \/elsewhere$/);
  });
});
