// Shared test harness. Every spawn site builds its environment through
// buildEnv() (spec H14 / T110), and every pool lives in a physically resolved,
// owner-only scratch directory (T111) that is removed after each test.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO_ROOT, 'bin', 'gate-lock');

// The only variables a spawned tool inherits from the test process. Everything
// else (GATE_*, XDG_RUNTIME_DIR, TMPDIR, ...) must be set by the test itself.
const ENV_ALLOW_LIST = ['PATH', 'HOME'];

/**
 * Build the environment for a spawned tool: the allow-list from the current
 * environment, then `extra`. An `undefined` value in `extra` deletes the key.
 */
export function buildEnv(extra = {}) {
  const env = {};
  for (const key of ENV_ALLOW_LIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

const scratches = [];

afterEach(() => {
  while (scratches.length > 0) {
    fs.rmSync(scratches.pop(), { recursive: true, force: true });
  }
});

/**
 * Make a fresh scratch directory (mode 0700, physically resolved) holding a
 * pool at `<scratch>/pool`. The scratch directory is the pool's parent, so the
 * parent is owner-only and never the sticky system temp directory (F4).
 * Pass { create: false } to get the path of a pool that does not exist yet.
 * Returns the pool path; the scratch is removed after the current test.
 */
export function freshPool({ create = true } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lock-test-')));
  fs.chmodSync(scratch, 0o700);
  scratches.push(scratch);
  const pool = path.join(scratch, 'pool');
  if (create) {
    fs.mkdirSync(pool);
    fs.chmodSync(pool, 0o700);
  }
  return pool;
}

/** The scratch directory that owns a pool made by freshPool(). */
export function scratchOf(pool) {
  return path.dirname(pool);
}

/** The shell used to run bin/gate-lock: sh (default), dash or "bash --posix". */
export function testShell() {
  const value = process.env.GATE_LOCK_TEST_SHELL;
  return value === undefined || value === '' ? 'sh' : value;
}

/**
 * Run bin/gate-lock synchronously under the selected shell with a controlled
 * environment. Options: env (extra variables, see buildEnv), shell, cwd, bin,
 * timeout (ms).
 */
export function runBin(args = [], { env = {}, shell = testShell(), cwd, bin = BIN, timeout } = {}) {
  const [shellCmd, ...shellArgs] = shell.split(/\s+/).filter(Boolean);
  const result = spawnSync(shellCmd, [...shellArgs, bin, ...args], {
    env: buildEnv(env),
    cwd,
    encoding: 'utf8',
    timeout: timeout ?? 30000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function mode(file, value) {
  fs.chmodSync(file, value);
}

/**
 * Write a held slot byte for byte as format 1 describes it (F24-F30): a
 * directory of one-line files. files: 4 omits `worktree` and `project`.
 */
export function writeSlot(
  pool,
  name,
  { owner, pid, started, beat, worktree, project },
  { files = 6 } = {},
) {
  if (files !== 4 && files !== 6) throw new Error('files must be 4 or 6');
  const dir = path.join(pool, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  mode(dir, 0o700);
  const content = { owner, pid, started, beat };
  if (files === 6) Object.assign(content, { worktree, project });
  for (const [file, value] of Object.entries(content)) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, `${value}\n`);
    mode(p, 0o600);
  }
  return dir;
}

/** Write the pool marker (F11): the value followed by a newline. */
export function writeFormat(pool, value = 1) {
  const p = path.join(pool, '.format');
  fs.writeFileSync(p, `${value}\n`);
  mode(p, 0o644);
  return p;
}

/**
 * Write a transient (F20, F23) by name: `.cand.*` and `.reclaim.*` are
 * directories, `.beatnew.*` and `.format.tmp.*` are files.
 */
export function writeTransient(pool, name) {
  const p = path.join(pool, name);
  if (/\.(cand|reclaim)\./.test(name)) {
    fs.mkdirSync(p, { mode: 0o700 });
    mode(p, 0o700);
  } else if (/\.(beatnew|format\.tmp)\./.test(name)) {
    fs.writeFileSync(p, '0\n');
    mode(p, 0o600);
  } else {
    throw new Error(`not a transient name: ${name}`);
  }
  return p;
}

/**
 * Sorted recursive listing of `root` for golden asserts: one line per entry,
 * "<mode> <relative path>", with a trailing "/" on directories and a leading
 * "l" before the mode for symlinks. Sorted by path (code-point order, like
 * `find | sort` under LC_ALL=C). The root is not listed.
 */
export function listing(root) {
  const lines = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const st = fs.lstatSync(full);
      const perms = (st.mode & 0o7777).toString(8).padStart(4, '0');
      if (st.isSymbolicLink()) {
        lines.push(`l${perms} ${rel} -> ${fs.readlinkSync(full)}`);
      } else if (st.isDirectory()) {
        lines.push(`${perms} ${rel}/`);
        walk(full, rel);
      } else {
        lines.push(`${perms} ${rel}`);
      }
    }
  };
  walk(root, '');
  return lines.sort((a, b) => {
    const ka = a.slice(a.indexOf(' ') + 1).replace(/\/$/, '');
    const kb = b.slice(b.indexOf(' ') + 1).replace(/\/$/, '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
