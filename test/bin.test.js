import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT } from '../src/index.js';
import { BIN, REPO_ROOT, freshPool, runBin, scratchOf } from './harness.js';

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

describe('bin/gate-lock stub', () => {
  it('--format prints 1 and exits 0', () => {
    const r = runBin(['--format']);
    expect(r).toMatchObject({ status: 0, stdout: '1\n', stderr: '' });
  });

  it('FORMAT export agrees with --format', () => {
    expect(String(FORMAT)).toBe(runBin(['--format']).stdout.trim());
  });

  it('--version prints the package.json version and exits 0', () => {
    const r = runBin(['--version']);
    expect(r).toMatchObject({ status: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });

  it('an unknown subcommand exits 2 with the gate-lock: prefix on stderr', () => {
    const r = runBin(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('gate-lock: not implemented yet\n');
  });

  it('no arguments, and the real subcommands, are not implemented yet (exit 2)', () => {
    for (const args of [[], ['acquire', 'x'], ['status'], ['run', 'x', '--', 'true']]) {
      const r = runBin(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^gate-lock: /);
    }
  });

  it('--format with extra arguments is not the bare query (exit 2)', () => {
    expect(runBin(['--format', 'x']).status).toBe(2);
    expect(runBin(['--version', 'x']).status).toBe(2);
  });

  it('works through a symlink (npm .bin) and from another working directory', () => {
    const scratch = scratchOf(freshPool());
    const link = path.join(scratch, 'gate-lock-link');
    fs.symlinkSync(BIN, link);
    expect(runBin(['--version'], { bin: link, cwd: scratch }).stdout).toBe(`${pkg.version}\n`);
    // relative link to the script, via a nested link (symlink chain)
    const link2 = path.join(scratch, 'link2');
    fs.symlinkSync('gate-lock-link', link2);
    expect(runBin(['--version'], { bin: link2, cwd: scratch }).stdout).toBe(`${pkg.version}\n`);
    // relative invocation from the bin directory
    expect(runBin(['--version'], { bin: './gate-lock', cwd: path.dirname(BIN) }).stdout).toBe(
      `${pkg.version}\n`,
    );
  });

  it('is a POSIX sh script with set -u and LC_ALL=C in the preamble', () => {
    const text = fs.readFileSync(BIN, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toMatch(/^set -u$/m);
    expect(text).toMatch(/^LC_ALL=C$/m);
  });
});
