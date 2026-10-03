// Shared test harness. Every spawn site builds its environment through
// buildEnv() (spec H14 / T110), and every pool lives in a physically resolved,
// owner-only scratch directory (T111) that is removed after each test.
import { spawn, spawnSync } from 'node:child_process';
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

// Isolation defaults (T110). The poison pool sits under a parent that does not
// exist, so a tool that is run without an explicit pool refuses (exit 2) and can
// never touch the host's real pool. The project slot count is pinned to 1.
export const POISON_POOL = '/nonexistent-gate-lock-poison/pool';
const ENV_DEFAULTS = { GATE_LOCK_DIR: POISON_POOL, GATE_LOCK_SLOTS: '1' };

/**
 * Build the environment for a spawned tool: the allow-list from the current
 * environment, then the isolation defaults, then `extra`. An `undefined` value
 * in `extra` deletes the key, so a test can also remove a default.
 */
export function buildEnv(extra = {}) {
  const env = {};
  for (const key of ENV_ALLOW_LIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, ENV_DEFAULTS);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

// Scratch directories to remove after each test. This list is module-global,
// so the suite must not run tests concurrently (no `describe.concurrent` or
// `it.concurrent`); vitest runs the tests of one file sequentially by default.
const scratches = [];

/** Remove every scratch directory made so far. Runs after each test. */
export function cleanupScratches() {
  while (scratches.length > 0) {
    fs.rmSync(scratches.pop(), { recursive: true, force: true });
  }
}

afterEach(cleanupScratches);

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

function command(args, { shell = testShell(), bin = BIN } = {}) {
  const [shellCmd, ...shellArgs] = shell.split(/\s+/).filter(Boolean);
  return [shellCmd, [...shellArgs, bin, ...args]];
}

/**
 * Run bin/gate-lock synchronously under the selected shell with a controlled
 * environment. Options: env (extra variables, see buildEnv), shell, cwd, bin,
 * timeout (ms).
 */
export function runBin(args = [], { env = {}, cwd, timeout, ...rest } = {}) {
  const [cmd, argv] = command(args, rest);
  const result = spawnSync(cmd, argv, {
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

/**
 * Start bin/gate-lock without waiting, with the same environment and shell
 * handling as runBin. Returns { child, done }: `done` resolves with
 * { status, signal, stdout, stderr } when the process exits. Stdin is closed.
 */
export function startBin(args = [], { env = {}, cwd, ...rest } = {}) {
  const [cmd, argv] = command(args, rest);
  const child = spawn(cmd, argv, {
    env: buildEnv(env),
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

/** Resolve when `file` exists (a pause-hook handshake); reject after timeoutMs. */
export async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Release a process parked on a pause hook by removing the hook file. */
export function releaseHook(file) {
  fs.rmSync(file, { force: true });
}

function mode(file, value) {
  fs.chmodSync(file, value);
}

/**
 * Write a held slot byte for byte as format 1 describes it (F24-F30): a
 * directory of one-line files. files: 4 omits `worktree` and `project`;
 * files: 6 throws if either is undefined. `mode` (directory, default 0700) and
 * `fileMode` (default 0600) let a fixture imitate another client.
 */
export function writeSlot(
  pool,
  name,
  { owner, pid, started, beat, worktree, project },
  { files = 6, mode: dirMode = 0o700, fileMode = 0o600 } = {},
) {
  if (files !== 4 && files !== 6) throw new Error('files must be 4 or 6');
  if (files === 6) {
    if (worktree === undefined) throw new Error('writeSlot: worktree is required for files: 6');
    if (project === undefined) throw new Error('writeSlot: project is required for files: 6');
  }
  const dir = path.join(pool, name);
  fs.mkdirSync(dir, { mode: dirMode });
  mode(dir, dirMode);
  const content = { owner, pid, started, beat };
  if (files === 6) Object.assign(content, { worktree, project });
  for (const [file, value] of Object.entries(content)) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, `${value}\n`);
    mode(p, fileMode);
  }
  return dir;
}

/** Write the pool marker (F11): the value followed by a newline. Default mode 0644. */
export function writeFormat(pool, value = 1, { mode: fileMode = 0o644 } = {}) {
  const p = path.join(pool, '.format');
  fs.writeFileSync(p, `${value}\n`);
  mode(p, fileMode);
  return p;
}

/**
 * Write exactly `bytes` (a string or Buffer, so empty or unterminated values
 * are possible) to `rel` under `pool`, with an explicit mode (default 0600).
 */
export function writeRaw(pool, rel, bytes, fileMode = 0o600) {
  const p = path.join(pool, rel);
  fs.writeFileSync(p, bytes);
  mode(p, fileMode);
  return p;
}

/**
 * Write a transient (F20, F23) by name: `.cand.*` and `.reclaim.*` are
 * directories, `.beatnew.*` and `.format.tmp.*` are files. A `.format.tmp.*`
 * file holds the marker content, `1\n`.
 */
export function writeTransient(pool, name) {
  const p = path.join(pool, name);
  if (/\.(cand|reclaim)\./.test(name)) {
    fs.mkdirSync(p, { mode: 0o700 });
    mode(p, 0o700);
  } else if (/\.(beatnew|format\.tmp)\./.test(name)) {
    fs.writeFileSync(p, /\.format\.tmp\./.test(name) ? '1\n' : '0\n');
    mode(p, 0o600);
  } else {
    throw new Error(`not a transient name: ${name}`);
  }
  return p;
}

/** Make `target` look `seconds` old: set atime and mtime to now minus seconds. */
export function setAge(target, seconds) {
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(target, when, when);
}

/**
 * Sorted recursive listing of `root` for golden asserts: one line per entry,
 * "<mode> <relative path>" (or just the path with { modes: false }), with a
 * trailing "/" on directories and "-> target" for symlinks (prefixed "l" before
 * the mode when modes are shown). Sorted by path in code-point order, like
 * `find | sort` under LC_ALL=C. The root itself is not listed.
 */
export function listing(root, { modes = true } = {}) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const st = fs.lstatSync(full);
      const perms = (st.mode & 0o7777).toString(8).padStart(4, '0');
      let text = rel;
      let head = perms;
      if (st.isSymbolicLink()) {
        text = `${rel} -> ${fs.readlinkSync(full)}`;
        head = `l${perms}`;
      } else if (st.isDirectory()) {
        text = `${rel}/`;
      }
      entries.push({ key: rel, line: modes ? `${head} ${text}` : text });
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full, rel);
    }
  };
  walk(root, '');
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries.map((e) => e.line);
}
