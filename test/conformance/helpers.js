// Conformance suite helpers (GL4b): spec-exact fixture writers and CLI runners.
// Every fixture here is constructed from docs/requirements.md section 2 alone,
// never through the CLI. The suite asserts the CLI's observable effects as golden
// directory listings and exact file bytes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = path.join(REPO_ROOT, 'bin', 'gate-lock');

const ENV_ALLOW_LIST = ['PATH', 'HOME'];

export const TM = { GATE_LOCK_TEST_MODE: '1' };

const scratches = [];

afterEach(() => {
  while (scratches.length > 0) {
    fs.rmSync(scratches.pop(), { recursive: true, force: true });
  }
});

export function buildEnv(extra = {}) {
  const env = {};
  for (const key of ENV_ALLOW_LIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { TMPDIR: '/tmp' });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

export function testShell() {
  const value = process.env.GATE_LOCK_TEST_SHELL;
  return value === undefined || value === '' ? 'sh' : value;
}

function command(args, { shell = testShell(), bin = BIN } = {}) {
  const [shellCmd, ...shellArgs] = shell.split(/\s+/).filter(Boolean);
  return [shellCmd, [...shellArgs, bin, ...args]];
}

export function runCli(args = [], { env = {}, cwd, timeout, ...rest } = {}) {
  const [cmd, argv] = command(args, rest);
  const result = spawnSync(cmd, argv, {
    env: buildEnv(env),
    cwd,
    encoding: 'utf8',
    timeout: timeout ?? 30000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 0,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function startCli(args = [], { env = {}, cwd, ...rest } = {}) {
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

export function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
  }
}

export async function until(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error('timed out');
  }
}

const children = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

export function freshScratching() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lock-conformance-')));
  fs.chmodSync(dir, 0o700);
  scratches.push(dir);
  return dir;
}

export function freshPool({ withFormat = true, mode = 0o700 } = {}) {
  const scratch = freshScratching();
  const pool = path.join(scratch, 'pool');
  fs.mkdirSync(pool, { mode });
  fs.chmodSync(pool, mode);
  if (withFormat) writeFormat(pool, 1);
  return pool;
}

export function scratchOf(pool) {
  return path.dirname(pool);
}

export function writeFormat(pool, value = 1, { mode = 0o600 } = {}) {
  const p = path.join(pool, '.format');
  fs.writeFileSync(p, `${value}\n`);
  fs.chmodSync(p, mode);
  return p;
}

export function writeSlot(
  pool,
  name,
  { owner, pid, started, beat, worktree, project },
  { files = 6, dirMode = 0o700, fileMode = 0o600 } = {},
) {
  if (files !== 4 && files !== 6) throw new Error('files must be 4 or 6');
  if (files === 6) {
    if (worktree === undefined) throw new Error('writeSlot: worktree is required for files: 6');
    if (project === undefined) throw new Error('writeSlot: project is required for files: 6');
  }
  const dir = path.join(pool, name);
  fs.mkdirSync(dir, { mode: dirMode });
  fs.chmodSync(dir, dirMode);
  const content = { owner, pid, started, beat };
  if (files === 6) Object.assign(content, { worktree, project });
  for (const [file, val] of Object.entries(content)) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, `${val}\n`);
    fs.chmodSync(p, fileMode);
  }
  return dir;
}

export function writeTransient(pool, name) {
  const p = path.join(pool, name);
  if (/\.(cand|reclaim)\./.test(name)) {
    fs.mkdirSync(p, { mode: 0o700 });
    fs.chmodSync(p, 0o700);
  } else if (/\.(beatnew|format\.tmp)\./.test(name)) {
    fs.writeFileSync(p, /\.format\.tmp\./.test(name) ? '1\n' : '0\n');
    fs.chmodSync(p, 0o600);
  } else {
    throw new Error(`not a transient name: ${name}`);
  }
  return p;
}

export function writeRaw(pool, rel, bytes, fileMode = 0o600) {
  const p = path.join(pool, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  fs.chmodSync(p, fileMode);
  return p;
}

export function setAge(target, seconds) {
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(target, when, when);
}

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

export function readFile(pool, rel) {
  return fs.readFileSync(path.join(pool, rel), 'utf8');
}

export function fileBytes(pool, rel) {
  return fs.readFileSync(path.join(pool, rel));
}

export function names(dir) {
  return fs.readdirSync(dir).sort();
}

export function nowS() {
  return Math.floor(Date.now() / 1000);
}

export function livePid() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(child);
  afterEach(() => {
    while (children.length > 0) {
      const c = children.pop();
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
  return child.pid;
}

export function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(r.stdout);
}

export function wtDir(pool, name = `conformance-wt`) {
  const dir = path.join(scratchOf(pool), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

export function lockEnv(pool, extra = {}) {
  return { GATE_LOCK_DIR: pool, ...extra };
}

export function acquire(pool, lane, pid, { env = {}, cwd } = {}) {
  return runCli(['acquire', lane], {
    env: lockEnv(pool, { GATE_LOCK_CALLER_PID: String(pid), ...env }),
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
}

export function status(pool, { json = false, env = {}, cwd } = {}) {
  return runCli(json ? ['status', '--json'] : ['status'], {
    env: lockEnv(pool, env),
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
}

export function release(pool, lane, pid, { pin, env = {}, cwd } = {}) {
  const e = lockEnv(pool, env);
  if (pid !== undefined) e.GATE_LOCK_CALLER_PID = String(pid);
  if (pin) e.GATE_LOCK_SLOT_PATH = pin;
  return runCli(['release', lane], { env: e, cwd: cwd ?? wtDir(pool, 'wt0') });
}

export function verify(pool, lane, pid, { pin, env = {}, cwd } = {}) {
  const e = lockEnv(pool, env);
  if (pid !== undefined) e.GATE_LOCK_CALLER_PID = String(pid);
  if (pin) e.GATE_LOCK_SLOT_PATH = pin;
  return runCli(['verify', lane], { env: e, cwd: cwd ?? wtDir(pool, 'wt0') });
}

export function heartbeat(pool, pid, { pin, env = {}, cwd } = {}) {
  const e = lockEnv(pool, env);
  if (pid !== undefined) e.GATE_LOCK_CALLER_PID = String(pid);
  if (pin) e.GATE_LOCK_SLOT_PATH = pin;
  return runCli(['heartbeat'], { env: e, cwd: cwd ?? wtDir(pool, 'wt0') });
}

export function clean(pool, { env = {}, cwd } = {}) {
  return runCli(['clean'], { env: lockEnv(pool, env), cwd: cwd ?? wtDir(pool, 'wt0') });
}

export function setStale(pool, seconds) {
  return { GATE_LOCK_STALE_SECONDS: String(seconds) };
}
