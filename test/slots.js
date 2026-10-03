// Helpers shared by the slot tests (GL2a). Not a test file. Slots of other
// clients are planted with the harness's spec-exact writers, never with the CLI.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import {
  freshPool as harnessFreshPool,
  runBin,
  scratchOf,
  startBin,
  writeFormat,
  writeSlot,
} from './harness.js';

export { path };

/** Seams are honoured only in test mode (D20). */
export const TM = { GATE_LOCK_TEST_MODE: '1' };

export const nowS = () => Math.floor(Date.now() / 1000);

// Long-lived children that stand in for a holder's pid (T113): really alive, and
// not the test process. Killed after each test.
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

/** A pid that is really alive for the rest of the test: a long `sleep` child. */
export function livePid() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(child);
  return child.pid;
}

/** A pid that really is dead: a child that exited and was reaped (T113). */
export function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(r.stdout);
}

let wtCounter = 0;
/**
 * A physically resolved working directory under the pool's scratch, outside any
 * repository, so its worktree identity is its own path. Distinct per name.
 */
export function wtDir(pool, name = `wt${wtCounter++}`) {
  const dir = path.join(scratchOf(pool), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/**
 * A fresh pool that already holds its marker (mode 0600, as this tool writes it),
 * so a listing taken before the first call is comparable with one taken after.
 */
export function freshPool() {
  const pool = harnessFreshPool();
  writeFormat(pool, 1, { mode: 0o600 });
  return pool;
}

/** The environment for a lock call against `pool`. */
export function lockEnv(pool, extra = {}) {
  return { GATE_LOCK_DIR: pool, ...extra };
}

/** Run `acquire <lane>` with caller pid `pid` from `cwd` (default: the pool's own wt0). */
export function acquire(pool, lane, pid, { env = {}, cwd } = {}) {
  return runBin(['acquire', lane], {
    env: lockEnv(pool, { GATE_LOCK_CALLER_PID: String(pid), ...env }),
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
}

/** Start `acquire` without waiting (for pause-hook races). */
export function startAcquire(pool, lane, pid, { env = {}, cwd } = {}) {
  return startBin(['acquire', lane], {
    env: lockEnv(pool, { GATE_LOCK_CALLER_PID: String(pid), ...env }),
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
}

/** Run any subcommand against `pool` with the given caller pid and extra env. */
export function sub(pool, args, pid, { env = {}, cwd } = {}) {
  const e = lockEnv(pool, env);
  if (pid !== undefined) e.GATE_LOCK_CALLER_PID = String(pid);
  return runBin(args, { env: e, cwd: cwd ?? wtDir(pool, 'wt0') });
}

const SIX = ['owner', 'pid', 'started', 'beat', 'worktree', 'project'];

/** Read a slot's files as { name: content-without-newline }, undefined when absent. */
export function readSlot(pool, name) {
  const out = {};
  for (const f of SIX) {
    try {
      out[f] = fs.readFileSync(path.join(pool, name, f), 'utf8').replace(/\n$/, '');
    } catch {
      out[f] = undefined;
    }
  }
  return out;
}

/** The names in `dir`, sorted. */
export function names(dir) {
  return fs.readdirSync(dir).sort();
}

/** Seed a six-file holder at `name` with sensible defaults; returns its directory. */
export function seed(pool, name, fields = {}, opts) {
  const now = nowS();
  return writeSlotDefaults(pool, name, { started: now, beat: now, ...fields }, opts);
}

function writeSlotDefaults(pool, name, fields, opts) {
  const f = {
    owner: 'holder',
    pid: livePid(),
    worktree: '/somewhere/else',
    project: 'else',
    ...fields,
  };
  return writeSlot(pool, name, f, opts);
}

/** Wait until `fn()` is true; reject after timeoutMs. */
export async function until(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
