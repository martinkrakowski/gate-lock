import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMAT } from '../src/index.js';
import { BIN, REPO_ROOT, buildEnv, freshPool, runBin, scratchOf, testShell } from './harness.js';

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

describe('bin/gate-lock preamble and dispatch', () => {
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

  it('an unknown subcommand, and no subcommand, exit 2 with the gate-lock: prefix and a usage line', () => {
    for (const args of [['frobnicate'], []]) {
      const r = runBin(args, { env: { GATE_LOCK_DIR: freshPool() } });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^gate-lock: [^\n]+\nusage: gate-lock /);
    }
  });

  it('run holds a slot around one command and clean runs the janitor', () => {
    const pool = freshPool();
    const r = runBin(['run', 'x', '--', 'true'], { env: { GATE_LOCK_DIR: pool } });
    expect(r).toMatchObject({ status: 0, stderr: '' });
    expect(r.stdout).toContain('acquired by x');
    expect(r.stdout).toContain('released by x');
    // clean is built (D16): it runs the pass and says nothing when there is
    // nothing to remove.
    const c = runBin(['clean'], { env: { GATE_LOCK_DIR: pool } });
    expect(c).toMatchObject({ status: 0, stdout: '', stderr: '' });
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

  describe('--version tolerates package.json formatting', () => {
    // A copy of the stub in <scratch>/bin with its own package.json beside it.
    const versionFor = (packageJson) => {
      const scratch = scratchOf(freshPool());
      fs.mkdirSync(path.join(scratch, 'bin'));
      const copy = path.join(scratch, 'bin', 'gate-lock');
      fs.copyFileSync(BIN, copy);
      fs.chmodSync(copy, 0o755);
      fs.writeFileSync(path.join(scratch, 'package.json'), packageJson);
      return runBin(['--version'], { bin: copy });
    };
    const cases = {
      'four-space indent':
        '{\n    "name": "x",\n    "version": "1.2.3",\n    "license": "MIT"\n}\n',
      'tab indent': '{\n\t"name": "x",\n\t"version": "1.2.3",\n\t"license": "MIT"\n}\n',
      'no space around the colon': '{\n  "version":"1.2.3",\n  "x": 1\n}\n',
      'spaces on both sides of the colon': '{\n  "version" : "1.2.3",\n  "x": 1\n}\n',
      'no trailing comma': '{\n  "name": "x",\n  "version": "1.2.3"\n}\n',
      'CRLF line endings': '{\r\n  "name": "x",\r\n  "version": "1.2.3",\r\n  "x": 1\r\n}\r\n',
      'only the first version line counts': '{\n  "version": "1.2.3",\n  "version": "9.9.9"\n}\n',
    };
    for (const [title, json] of Object.entries(cases)) {
      it(title, () => {
        expect(versionFor(json)).toMatchObject({ status: 0, stdout: '1.2.3\n', stderr: '' });
      });
    }
    it('a package.json without a version exits 2 with the prefix', () => {
      const r = versionFor('{ "name": "x" }\n');
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^gate-lock: /);
    });
  });

  it('a symlink cycle exits 2 instead of looping (cap of 40)', () => {
    // sh -c makes $0 the operand, so the cycle is never opened by the kernel. The
    // script itself is copied beside the cycle and *sourced*, not handed to -c as
    // text: bin/gate-lock is over 128 KiB and no single argv entry may be larger
    // than that (MAX_ARG_STRLEN), so the spawn was refused with E2BIG, the run never
    // started, and this test timed out on both Linux legs at ec300fc without the
    // cap ever being reached.
    const scratch = scratchOf(freshPool());
    const copy = path.join(scratch, 'gate-lock');
    fs.copyFileSync(BIN, copy);
    fs.symlinkSync('loop-b', path.join(scratch, 'loop-a'));
    fs.symlinkSync('loop-a', path.join(scratch, 'loop-b'));
    const [shell, ...shellArgs] = testShell().split(/\s+/).filter(Boolean);
    const r = spawnSync(
      shell,
      [...shellArgs, '-c', '. "$2"', path.join(scratch, 'loop-a'), '--format', copy],
      {
        env: buildEnv(),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(r.error, `the spawn itself failed: ${r.error && r.error.message}`).toBe(undefined);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^gate-lock: .*symbolic link/);
  });

  it('a chain of 30 links still resolves', () => {
    const scratch = scratchOf(freshPool());
    let prev = BIN;
    for (let i = 0; i < 30; i++) {
      const link = path.join(scratch, `l${i}`);
      fs.symlinkSync(prev, link);
      prev = link;
    }
    expect(runBin(['--version'], { bin: prev }).stdout).toBe(`${pkg.version}\n`);
  });
});
