// Helpers shared by the configuration tests (GL1). Not a test file.
import fs from 'node:fs';
import path from 'node:path';
import { freshPool, runBin, scratchOf } from './harness.js';

/** What every subcommand still prints once configuration has resolved (GL2a replaces it). */
export const NOT_IMPL = 'gate-lock: not implemented yet\n';

export const UID = process.getuid();

/** Seams are honoured only in test mode (D20). Spread this into env to enable them. */
export const TM = { GATE_LOCK_TEST_MODE: '1' };

/** Run `status` (any subcommand that is not --format/--version/workers resolves configuration). */
export function cfg(env = {}, args = ['status']) {
  return runBin(args, { env });
}

/** Configuration was accepted: exit 2 only because the subcommand is not built yet. */
export function accepted(r) {
  return r.status === 2 && r.stderr === NOT_IMPL && r.stdout === '';
}

/** A configuration refusal: exit 2, nothing on stdout, one gate-lock: line on stderr. */
export function refusal(r, ...needles) {
  expect2(r.status === 2, `exit ${r.status}, stderr ${JSON.stringify(r.stderr)}`);
  expect2(r.stdout === '', `stdout ${JSON.stringify(r.stdout)}`);
  expect2(/^gate-lock: [^\n]*\n$/.test(r.stderr), `stderr ${JSON.stringify(r.stderr)}`);
  expect2(r.stderr !== NOT_IMPL, 'configuration was accepted');
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
