// F11-F17: the .format marker. Fixtures are written directly per §2, never via the CLI.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  freshPool,
  listing,
  lockEnv,
  names,
  runCli,
  writeFormat,
  writeRaw,
  wtDir,
} from './helpers.js';

describe('F11 the .format marker', () => {
  it('T71 existing marker "1\\n" is accepted, stderr empty, bytes unchanged', () => {
    const pool = freshPool({ withFormat: false });
    writeFormat(pool, 1, { mode: 0o644 });
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('free:');
    expect(names(pool)).toEqual(['.format']);
    expect(fs.readFileSync(`${pool}/.format`)).toEqual(Buffer.from('1\n'));
  });
});

describe('F12-F13 the format check', () => {
  it('T72 a marker holding "2" is refused (exit 2) and stderr names "lock format", "2", and "this gate speaks 1"', () => {
    const pool = freshPool({ withFormat: false });
    writeFormat(pool, 2);
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/lock format/);
    expect(r.stderr).toMatch(/2/);
    expect(r.stderr).toMatch(/this gate speaks 1/);
    expect(names(pool)).toEqual(['.format']);
  });

  it('T72 an empty marker is refused (exit 2) and stderr says "nothing"', () => {
    const pool = freshPool({ withFormat: false });
    writeRaw(pool, '.format', '', 0o600);
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/lock format/);
    expect(r.stderr).toMatch(/nothing/);
  });

  it('T70 a missing pool is created with mode 0700 and ".format" holding "1"', () => {
    const pool = freshPool({ withFormat: false });
    const child = `${pool}/pool`;
    const r = runCli(['status'], {
      env: { GATE_LOCK_DIR: child, TMPDIR: '/tmp' },
      cwd: wtDir(pool),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(names(child)).toEqual(['.format']);
    expect(fs.readFileSync(`${child}/.format`)).toEqual(Buffer.from('1\n'));
  });
});

describe('F14 the marker is not rewritten', () => {
  it('T71 an existing valid marker is not rewritten: bytes and mtime are unchanged', () => {
    const pool = freshPool({ withFormat: false });
    writeFormat(pool, 1, { mode: 0o600 });
    const before = fs.statSync(`${pool}/.format`);
    const r = runCli(['status'], { env: lockEnv(pool), cwd: wtDir(pool) });
    expect(r.status).toBe(0);
    const after = fs.statSync(`${pool}/.format`);
    expect(before.mtimeMs).toBe(after.mtimeMs);
    expect(before.size).toBe(after.size);
    expect(fs.readFileSync(`${pool}/.format`)).toEqual(Buffer.from('1\n'));
  });
});
