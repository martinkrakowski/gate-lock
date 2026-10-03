import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BIN,
  POISON_POOL,
  buildEnv,
  cleanupScratches,
  freshPool,
  listing,
  releaseHook,
  runBin,
  scratchOf,
  setAge,
  startBin,
  testShell,
  waitForFile,
  writeFormat,
  writeRaw,
  writeSlot,
  writeTransient,
} from './harness.js';

describe('harness: environment isolation (T110, H14)', () => {
  it('T110 buildEnv never inherits GATE_*, XDG_RUNTIME_DIR or TMPDIR', () => {
    vi.stubEnv('GATE_LOCK_DIR', '/nope');
    vi.stubEnv('GATE_HOST_SLOTS', '9');
    vi.stubEnv('GATE_HOST_WORKERS', '9');
    vi.stubEnv('GATE_LOCK_SLOTS', '9');
    vi.stubEnv('XDG_RUNTIME_DIR', '/nope');
    vi.stubEnv('TMPDIR', '/nope');
    vi.stubEnv('SOME_OTHER_VAR', 'x');
    const env = buildEnv();
    expect(env.GATE_LOCK_DIR).toBe(POISON_POOL);
    expect(env.GATE_LOCK_SLOTS).toBe('1');
    expect(Object.keys(env).filter((k) => k.startsWith('GATE_'))).toEqual([
      'GATE_LOCK_DIR',
      'GATE_LOCK_SLOTS',
    ]);
    expect(env).not.toHaveProperty('XDG_RUNTIME_DIR');
    expect(env).not.toHaveProperty('TMPDIR');
    expect(env).not.toHaveProperty('SOME_OTHER_VAR');
    expect(env.PATH).toBe(process.env.PATH);
    vi.unstubAllEnvs();
  });

  it('T110 a spawned process sees exactly the allow-list plus the isolation defaults', () => {
    vi.stubEnv('GATE_HOST_WORKERS', '7');
    vi.stubEnv('TMPDIR', '/nope');
    const keys = execFileSync('/usr/bin/env', { env: buildEnv() })
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')[0])
      .filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k))
      .sort();
    const expected = ['GATE_LOCK_DIR', 'GATE_LOCK_SLOTS', 'PATH'];
    if (process.env.HOME !== undefined) expected.push('HOME');
    expect(keys).toEqual(expected.sort());
    vi.unstubAllEnvs();
  });

  it('T110 the poison pool sits under a parent that does not exist', () => {
    expect(path.isAbsolute(POISON_POOL)).toBe(true);
    expect(fs.existsSync(path.dirname(POISON_POOL))).toBe(false);
  });

  it('T110 variables the test sets win, and undefined deletes a key (even the defaults)', () => {
    const env = buildEnv({
      GATE_LOCK_DIR: '/p',
      GATE_LOCK_SLOTS: undefined,
      TMPDIR: '/t',
      PATH: undefined,
    });
    expect(env.GATE_LOCK_DIR).toBe('/p');
    expect(env).not.toHaveProperty('GATE_LOCK_SLOTS');
    expect(env.TMPDIR).toBe('/t');
    expect(env).not.toHaveProperty('PATH');
    expect(buildEnv({ GATE_LOCK_SLOTS: 3 }).GATE_LOCK_SLOTS).toBe('3');
    expect(buildEnv({ GATE_LOCK_DIR: undefined })).not.toHaveProperty('GATE_LOCK_DIR');
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
  it('T111 freshPool is physically resolved, mode 0700, directly under os.tmpdir()', () => {
    const pool = freshPool();
    expect(pool).toBe(fs.realpathSync(pool));
    expect(path.dirname(scratchOf(pool))).toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.statSync(pool).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(scratchOf(pool)).mode & 0o7777).toBe(0o700);
    expect(fs.readdirSync(pool)).toEqual([]);
  });

  it('cleanup removes every scratch, independent of test order', () => {
    const a = scratchOf(freshPool());
    const b = scratchOf(freshPool({ create: false }));
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);
    cleanupScratches();
    expect(fs.existsSync(a) || fs.existsSync(b)).toBe(false);
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

describe('harness: async processes and hooks', () => {
  it('startBin drives two processes at once with the same controlled env', async () => {
    const a = startBin(['--format']);
    const b = startBin(['--version']);
    expect(a.child.pid).not.toBe(b.child.pid);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra).toMatchObject({ status: 0, stdout: '1\n', stderr: '' });
    expect(rb.status).toBe(0);
    expect(rb.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('startBin reports the exit status of a refusal', async () => {
    const r = await startBin(['nope']).done;
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^gate-lock: /);
  });

  it('startBin honours the shell and bin options', async () => {
    const r = await startBin(['--format'], { shell: 'sh', bin: BIN }).done;
    expect(r.status).toBe(0);
  });

  it('waitForFile resolves when the file appears and rejects on timeout', async () => {
    const pool = freshPool();
    const hook = path.join(pool, 'hook');
    setTimeout(() => fs.writeFileSync(hook, ''), 150);
    await waitForFile(hook, 5000);
    await expect(waitForFile(path.join(pool, 'never'), 200)).rejects.toThrow(/never/);
  });

  it('waitForFile resolves at once for an existing file', async () => {
    const pool = freshPool();
    fs.writeFileSync(path.join(pool, 'here'), '');
    await waitForFile(path.join(pool, 'here'), 1000);
  });

  it('releaseHook removes the hook file and tolerates a missing one', () => {
    const pool = freshPool();
    const hook = path.join(pool, 'hook');
    fs.writeFileSync(hook, '');
    releaseHook(hook);
    expect(fs.existsSync(hook)).toBe(false);
    expect(() => releaseHook(hook)).not.toThrow();
  });

  it('runBin and startBin pass a poison pool by default (no spawned tool reaches a real pool)', () => {
    // The stub ignores the pool; the env builder is what guarantees isolation.
    expect(runBin(['--format']).status).toBe(0);
    expect(buildEnv().GATE_LOCK_DIR).toBe(POISON_POOL);
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
  const without = (obj, ...keys) =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
  const modeOf = (p) => fs.statSync(p).mode & 0o7777;

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
    const four = without(held, 'worktree', 'project');
    const dir = writeSlot(pool, 'gate.lock.1', four, { files: 4 });
    expect(fs.readdirSync(dir).sort()).toEqual(['beat', 'owner', 'pid', 'started']);
    // files:4 ignores worktree/project even when given
    const dir2 = writeSlot(pool, 'gate.lock.2', held, { files: 4 });
    expect(fs.readdirSync(dir2)).toHaveLength(4);
  });

  it('writeSlot with files:6 throws when worktree or project is undefined', () => {
    const pool = freshPool();
    const noWorktree = without(held, 'worktree');
    const noProject = without(held, 'project');
    expect(() => writeSlot(pool, 'gate.lock', noWorktree)).toThrow(/worktree/);
    expect(() => writeSlot(pool, 'gate.lock', noProject)).toThrow(/project/);
    expect(fs.readdirSync(pool)).toEqual([]);
  });

  it('writeSlot honours a mode override (an imitated foreign slot)', () => {
    const pool = freshPool();
    const dir = writeSlot(pool, 'gate.lock', held, { mode: 0o755, fileMode: 0o644 });
    expect(modeOf(dir)).toBe(0o755);
    expect(modeOf(path.join(dir, 'pid'))).toBe(0o644);
    const dflt = writeSlot(pool, 'gate.lock.1', held);
    expect(modeOf(dflt)).toBe(0o700);
    expect(modeOf(path.join(dflt, 'pid'))).toBe(0o600);
  });

  it('writeFormat writes the marker with a trailing newline and honours { mode }', () => {
    const pool = freshPool();
    writeFormat(pool, 1);
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    expect(modeOf(path.join(pool, '.format'))).toBe(0o644);
    fs.rmSync(path.join(pool, '.format'));
    writeFormat(pool, 2, { mode: 0o664 });
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('2\n');
    expect(modeOf(path.join(pool, '.format'))).toBe(0o664);
  });

  it('writeRaw writes exact bytes (empty, unterminated, binary) with an explicit mode', () => {
    const pool = freshPool();
    writeRaw(pool, 'empty', '');
    writeRaw(pool, 'noeol', '12', 0o640);
    writeRaw(pool, 'bin', Buffer.from([0, 255, 10]));
    expect(fs.readFileSync(path.join(pool, 'empty'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(pool, 'noeol'), 'utf8')).toBe('12');
    expect(modeOf(path.join(pool, 'noeol'))).toBe(0o640);
    expect(modeOf(path.join(pool, 'empty'))).toBe(0o600);
    expect([...fs.readFileSync(path.join(pool, 'bin'))]).toEqual([0, 255, 10]);
  });

  it('writeRaw writes inside a slot directory by relative path', () => {
    const pool = freshPool();
    writeSlot(pool, 'gate.lock', held);
    writeRaw(pool, 'gate.lock/beat', '');
    expect(fs.readFileSync(path.join(pool, 'gate.lock', 'beat'), 'utf8')).toBe('');
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

  it('the .format.tmp.* transient holds the marker content "1\\n"', () => {
    const pool = freshPool();
    writeTransient(pool, '.format.tmp.9');
    expect(fs.readFileSync(path.join(pool, '.format.tmp.9'), 'utf8')).toBe('1\n');
  });

  it('setAge backdates atime and mtime of a file and a directory', () => {
    const pool = freshPool();
    const f = writeTransient(pool, 'gate.lock.beatnew.1');
    const d = writeTransient(pool, 'gate.lock.cand.1');
    const before = Date.now() / 1000;
    setAge(f, 700);
    setAge(d, 700);
    for (const p of [f, d]) {
      const st = fs.statSync(p);
      expect(before - st.mtimeMs / 1000).toBeGreaterThan(690);
      expect(before - st.mtimeMs / 1000).toBeLessThan(710);
      expect(before - st.atimeMs / 1000).toBeGreaterThan(690);
    }
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

  it('listing({ modes: false }) leaves modes out', () => {
    const pool = freshPool();
    writeFormat(pool);
    writeSlot(pool, 'gate.lock', held, { files: 4 });
    fs.symlinkSync('/elsewhere', path.join(pool, 'link'));
    expect(listing(pool, { modes: false })).toEqual([
      '.format',
      'gate.lock/',
      'gate.lock/beat',
      'gate.lock/owner',
      'gate.lock/pid',
      'gate.lock/started',
      'link -> /elsewhere',
    ]);
  });

  it('listing sorts by path like find | sort under LC_ALL=C', () => {
    const pool = freshPool();
    writeSlot(pool, 'gate.lock', held, { files: 4 });
    writeSlot(pool, 'gate.lock.1', held, { files: 4 });
    const paths = listing(pool, { modes: false });
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
    expect(listing(pool)[0]).toMatch(/^l\d{4} link -> \/elsewhere$/);
  });
});
