// Helpers shared by the configuration tests (GL1). Not a test file.
import fs from 'node:fs';
import path from 'node:path';
import { freshPool, runBin, scratchOf } from './harness.js';

/** What `run` still prints once configuration has resolved (GL3 replaces it). */
export const NOT_IMPL = 'gate-lock: not implemented yet\n';

export const UID = process.getuid();

/** Seams are honoured only in test mode (D20). Spread this into env to enable them. */
export const TM = { GATE_LOCK_TEST_MODE: '1' };

/** Run `status` (any subcommand that is not --format/--version/workers resolves configuration). */
export function cfg(env = {}, args = ['status']) {
  const dir = env.GATE_LOCK_DIR;
  lastPool = typeof dir === 'string' && dir !== '' ? dir.replace(/\/+$/, '') : undefined;
  return runBin(args, { env });
}

// The pool of the latest cfg() call, so accepted() can prove the tool really did
// its work: a stub that only exits 2 with "not implemented yet" must not pass.
let lastPool;

/**
 * Configuration was accepted: the subcommand then ran (`status` exits 0 with
 * nothing on stderr, `clean` exits 0 silently), or was refused on its own
 * terms (a usage error, the missing caller pid), or is not built yet (`run`);
 * and, for an explicit pool, the pool now holds its .format marker.
 */
export function accepted(r) {
  const said =
    (r.status === 0 && r.stderr === '' && (r.stdout === '' || /^(free|\/)/.test(r.stdout))) ||
    (r.status === 2 &&
      r.stdout === '' &&
      (r.stderr === NOT_IMPL ||
        /^gate-lock: [^\n]*\nusage: /.test(r.stderr) ||
        /^gate-lock: [^\n]*GATE_LOCK_CALLER_PID[^\n]*\n$/.test(r.stderr)));
  if (!said || lastPool === undefined) return said;
  return fs.existsSync(path.join(lastPool, '.format'));
}

/** A configuration refusal: exit 2, nothing on stdout, one gate-lock: line on stderr. */
export function refusal(r, ...needles) {
  expect2(r.status === 2, `exit ${r.status}, stderr ${JSON.stringify(r.stderr)}`);
  expect2(r.stdout === '', `stdout ${JSON.stringify(r.stdout)}`);
  expect2(/^gate-lock: [^\n]*\n$/.test(r.stderr), `stderr ${JSON.stringify(r.stderr)}`);
  expect2(r.stderr !== NOT_IMPL, 'configuration was accepted');
  expect2(!/\nusage: /.test(r.stderr), 'configuration was accepted (usage error)');
  for (const n of needles) {
    expect2(r.stderr.includes(n), `stderr ${JSON.stringify(r.stderr)} lacks ${JSON.stringify(n)}`);
  }
  return r;
}

function expect2(cond, message) {
  if (!cond) throw new Error(message);
}

/** A fresh pool whose parent (the scratch) is a dir we can add siblings to. */
export function poolIn() {
  const pool = freshPool({ create: false });
  return { pool, scratch: scratchOf(pool) };
}

export function modeOf(p) {
  return (fs.lstatSync(p).mode & 0o7777).toString(8).padStart(4, '0');
}

/** Make a directory with an exact mode (the umask cannot loosen or tighten it). */
export function mkdirMode(p, mode = 0o700) {
  fs.mkdirSync(p, { recursive: true });
  fs.chmodSync(p, mode);
  return p;
}

export { path };
