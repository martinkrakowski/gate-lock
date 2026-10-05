// Helpers shared by the run tests (GL3). Not a test file.
//
// Nothing here synchronises with a sleep: a wrapped command announces itself by
// touching a file and then blocks reading a fifo, so the test decides the
// instant it ends; signals are sent to the process the harness started, and
// every wait is a handshake on a file or a poll of a condition.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { runBin, scratchOf, startBin, waitForFile } from './harness.js';
import { TM, freshPool as slotPool, livePid, names, until, wtDir } from './slots.js';

export { TM, livePid, until };

/** A pool that already holds its marker, so a listing is comparable before and after. */
export function freshPool() {
  return slotPool();
}

/** Write a POSIX sh script under the pool's scratch and return its path. */
export function script(pool, name, body) {
  const p = `${scratchOf(pool)}/${name}`;
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o700);
  return p;
}

/**
 * A fifo a wrapped command can block on, plus the handshake files around it.
 * `ready` appears when the command is up (and holds its pid), `done` when it has
 * run to its end. `release()` lets it finish; nothing here polls.
 *
 * The command is registered with the afterEach below, so a test that fails, times
 * out or throws before it ever asks for the pid still cannot leave it running: a
 * blocker parked in open(2) on its fifo waits for ever, and four of them were found
 * on this host eleven hours after the runs that made them, each waiting on a fifo
 * whose scratch directory had already been taken away. `track()` is not enough on
 * its own, because it needs the pid and the pid is what a test that never got as far
 * as the handshake does not have.
 */
export function waiting(pool, name = 'block') {
  const dir = `${scratchOf(pool)}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  // A fifo, so the command blocks in open(2) with no polling and no sleep:
  // Node has no mkfifo, but mkfifo(1) is everywhere a POSIX shell is.
  const made = spawnSync('mkfifo', [`${dir}/go`], { stdio: 'ignore' });
  if (made.error || made.status !== 0) throw new Error(`mkfifo failed for ${dir}/go`);
  const w = {
    dir,
    ready: `${dir}/ready`,
    done: `${dir}/done`,
    pid: () => Number(fs.readFileSync(`${dir}/ready`, 'utf8')),
    release: () => {
      try {
        // O_NONBLOCK: when the command is already gone there is no reader left, and
        // a plain open for writing would wait for one for ever. With it, the open
        // answers ENXIO at once, which is the "nothing to let go of" case.
        const fd = fs.openSync(`${dir}/go`, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        try {
          fs.writeSync(fd, 'go\n');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* the command is gone; there is nothing to let go of */
      }
    },
  };
  waitingCommands.push(dir);
  return w;
}

/**
 * Stop one registered command, given only the directory it waits in. The pid is
 * read out of the handshake the command wrote itself, and it is only signalled while
 * it is still running *this* command's script: where the kernel has recycled a pid
 * between the test ending and this running, the argument vector says so, and a
 * stranger's process is not ours to kill. Where `ps` is missing there is nothing to
 * cross-check with, and the pid came out of a file this test wrote, so it is killed
 * on the strength of that.
 */
function stopWaiting(dir) {
  let pid;
  try {
    pid = Number(fs.readFileSync(`${dir}/ready`, 'utf8'));
  } catch {
    return; // the command never came up; there is nothing of it to stop
  }
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return;
  const listed = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  if (listed.stdout && !listed.stdout.includes(dir)) return; // a recycled pid
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** The body of a command that announces itself, blocks, and then finishes, with the
 *  waiting directory as its $n argument. */
const blockBody = (n) =>
  [
    `printf '%s\\n' "$$" >"$${n}/ready"`,
    `read _ignored <"$${n}/go"`,
    `printf '%s\\n' "$$" >"$${n}/done"`,
  ].join('\n');

/** A wrapped command that announces itself and then blocks until the test lets it go.
 *  `pre` runs first (it sees the waiting directory as $1 and any extra `args`
 *  from $2 on), `ignoreTerm` makes it deaf to TERM. */
export function blocker(pool, name = 'block', { ignoreTerm = false, pre = '', args = [] } = {}) {
  const w = waiting(pool, name);
  const body = [ignoreTerm ? "trap '' TERM" : '', pre, blockBody(1)].filter(Boolean).join('\n');
  return { ...w, cmd: [script(pool, `${name}.sh`, body), w.dir, ...args] };
}

/** A wrapped command that ignores TERM and gives its slot away, so the lock is lost. */
export function thief(pool, slot, name = 'thief') {
  const w = waiting(pool, name);
  const body = ["trap '' TERM", 'rm -rf "$1"', blockBody(2)].join('\n');
  return { ...w, cmd: [script(pool, `${name}.sh`, body), slot, w.dir] };
}

/** A wrapped command that ignores TERM, so only the supervisor's KILL stops it. */
export function stubborn(pool, name = 'stubborn') {
  return blocker(pool, name, { ignoreTerm: true });
}

/**
 * A wrapped command that waits until the heartbeat loop has refreshed the beat at
 * least once - bounded polling inside the command, as T24 asks - and then runs
 * `then` with the slot as $1 and `args` from $2 on. With a long heartbeat period
 * the rest of the run is then deterministic: the loop will not refresh again
 * before the run ends, so what follows is what decides the exit status.
 */
export function afterBeat(pool, slot, name, then, args = []) {
  const body = [
    'started=$(cat "$1/started")',
    'i=0',
    'while [ "$i" -lt 20 ]; do',
    '  b=$(cat "$1/beat" 2>/dev/null || printf \'\')',
    '  if [ -n "$b" ] && [ "$b" -gt "$started" ]; then break; fi',
    '  i=$((i + 1))',
    '  sleep 1',
    'done',
    then,
  ].join('\n');
  return [script(pool, `${name}.sh`, body), slot, ...args];
}

// Pids the tests learned about (the wrapped commands), killed after each test
// so a failing assertion cannot leave a gate running.
const pids = [];
// The waiting directories of every wrapped command made in this file, for the same
// reason and with the difference spelled out in waiting(): a command whose pid a test
// never learned is found by the handshake it wrote instead.
const waitingCommands = [];
// Runs this file started, stopped after each test for the same reason.
const startedRuns = [];
afterEach(stopHelpers);

/**
 * Everything a test may have started, stopped now: the runs it started with their own
 * helpers, the commands that wait on a fifo, and every pid it tracked. The afterEach
 * above is this, and a test that has to see the effect itself calls it directly: it is
 * exported so the guarantee can be tested rather than only relied on.
 *
 * The order is not an accident: vitest runs `after` hooks in reverse order of
 * registration (`sequence.hooks` defaults to "stack"), and this file is imported
 * after harness.js, so this runs before the scratches are removed - which is what
 * lets the handshake files be read.
 */
export function stopHelpers() {
  while (startedRuns.length > 0) {
    stopRun(startedRuns.pop());
  }
  while (waitingCommands.length > 0) {
    stopWaiting(waitingCommands.pop());
  }
  while (pids.length > 0) {
    killPid(pids.pop());
  }
}

/** Signal one pid, and shrug at one that has gone. */
function killPid(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Stop a run this file started, helpers and all. Killing the run alone is not enough:
 * its helpers - the supervisor, the command, the watchdog, and the loop inside the
 * supervisor - are its children, and a run that is KILLed takes none of them with it.
 * They are listed *before* it is signalled, because a child of a dead process is
 * reparented at once and its parent link - the only thing that says whose it was - is
 * gone with it. A helper of a run whose test has ended is a helper with nothing left
 * to stop it, and one that has to be KILLed to go is the shape that was found on this
 * host hours after the test that made it.
 */
function stopRun(recorded) {
  const pid = recorded.pid;
  const tmpRoot = recorded.tmpRoot;
  const trace = recorded.trace;
  const helpers = descendants(pid);
  for (const helper of helpers) killPid(helper);
  killPid(pid);
  // Remove only the private directory this specific run created. The run_scratch loop
  // in bin/gate-lock names it gate-lock-run.<pid>; only when a recycled pid left one
  // behind does it append .<k>. The run publishes its actual directory in its trace
  // (when a trace seam was set), so that case is resolved to the right name rather
  // than inferred from a PID-prefix scan of the shared temp root - which can match a
  // recycled PID's newer directory and delete it while that run uses it.
  let dir = runDirOf(pid, tmpRoot);
  if (trace) {
    let traceText;
    try {
      traceText = fs.readFileSync(trace, 'utf8');
    } catch {
      /* trace file may not exist yet */
    }
    if (traceText) {
      const match = traceText.match(
        new RegExp(`run ${pid} private directory (.+)\n`),
      );
      if (match) dir = match[1];
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone, or not ours to remove */
  }
}

/**
 * The pids below `pid`, three levels deep, which is as deep as a run goes: run ->
 * supervisor -> loop -> the heartbeat child of that loop. Where `pgrep` is missing the
 * answer is an empty list and the run is signalled on its own, as it always was.
 */
function descendants(pid, depth = 3) {
  if (depth < 1) return [];
  const listed = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];
  const kids = listed.stdout
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((kid) => Number.isInteger(kid) && kid > 0);
  return kids.flatMap((kid) => [kid, ...descendants(kid, depth - 1)]);
}

/** Remember a pid so it is killed after the test, even if the test fails. */
export function track(pid) {
  if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  return pid;
}

/** Is `pid` still a process? */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Has this pid stopped being a process of ours? A signal-zero probe answers for a
 * pid that the kernel has not finished retiring, so where /proc says a pid has no
 * entry at all, that is the answer; elsewhere the probe is the only one there is.
 */
export function stopped(pid) {
  if (fs.existsSync('/proc')) {
    try {
      fs.statSync(`/proc/${pid}`);
      return false;
    } catch {
      return true;
    }
  }
  return !alive(pid);
}

/** Wait until `pid` is not a live process any more. */
export async function waitForDead(pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The private directory a run keeps in the temp root: `$tmpRoot/gate-lock-run.<pid>`
 * of the run whose pid is `pid`. `tmpRoot` is the directory the run resolved, which
 * a test knows when it sets `GATE_LOCK_TEST_TMP_ROOT` and otherwise is the system
 * one. When the run created a `gate-lock-run.<pid>.<k>` directory (because a leftover
 * base existed), pass the trace file it wrote so the actual name is read back.
 */
export function runDirOf(pid, tmpRoot, trace) {
  const base = path.join(tmpRoot ?? os.tmpdir(), `gate-lock-run.${pid}`);
  if (!trace) return base;
  let traceText;
  try {
    traceText = fs.readFileSync(trace, 'utf8');
  } catch {
    return base;
  }
  const match = traceText.match(new RegExp(`run ${pid} private directory (.+)\n`));
  return match ? match[1] : base;
}

/**
 * Wait until a run that was KILLed has nothing left of itself.
 *
 * A KILLed run cannot clean up: the last of its helpers to leave removes the private
 * directory instead (the janitor walks the pool, not the temp root - D16 against
 * D21), and the loop and the watchdog leave within a second of the supervisor. A test
 * that takes that directory away while a helper is still writing into it fails with
 * ENOTEMPTY, which is what macOS CI saw, so this waits for the directory to be gone
 * and therefore for every helper that writes into it to have left.
 */
export async function waitRunGone(gate, { tmpRoot, trace, timeoutMs = 30000 } = {}) {
  const dir = runDirOf(gate.child.pid, tmpRoot, trace);
  await until(() => !fs.existsSync(dir), timeoutMs);
}

/**
 * Both the base name and any `.<k>` suffixed directory for `pid`: a leftover
 * `gate-lock-run.<pid>` may sit beside the `.<k>` the run actually created, and a
 * test that removes one must not take the other.
 */
export function runDirNames(pid, tmpRoot) {
  tmpRoot = tmpRoot ?? os.tmpdir();
  const list = [path.join(tmpRoot, `gate-lock-run.${pid}`)];
  for (let k = 1; k <= 20; k++) {
    const p = path.join(tmpRoot, `gate-lock-run.${pid}.${k}`);
    if (fs.existsSync(p)) list.push(p);
  }
  return list;
}

/**
 * The listing of a pool whose run still holds its slot: `.format`, the slot, and at
 * most one staged beat.
 *
 * A staged beat is the tool's own name pattern beside the slot (`<slot>.beatnew.<pid>`,
 * F39) and exists only while a refresh is between staging it and renaming it into
 * place, so a listing taken in that instant sees a file that is gone a moment later.
 * A pool whose run has ended has no such excuse and is listed exactly - that is the
 * property - so this is for the listings taken while a run lives, and it says what
 * the pool holds apart from that transient and how many it tolerates, with the whole
 * listing in the failure message.
 */
export function heldListing(pool) {
  const listing = names(pool);
  const staged = listing.filter((n) => /^gate\.lock(\.\d+)?\.beatnew\.\d+$/.test(n));
  return {
    listing,
    held: listing.filter((n) => !staged.includes(n)),
    staged,
  };
}

/** Run `run <lane> -- <cmd...>` synchronously (usage errors and refusals). */
export function runOnce(pool, lane, cmd, { args = [], env = {}, cwd, timeout } = {}) {
  return runBin(['run', ...args, lane, '--', ...cmd], {
    env: { GATE_LOCK_DIR: pool, ...env },
    cwd: cwd ?? wtDir(pool, 'wt0'),
    timeout,
  });
}

/** Run `run` with a raw argument vector (usage-error shapes, which have no command). */
export function runRaw(pool, args, { env = {}, cwd } = {}) {
  return runBin(['run', ...args], {
    env: { GATE_LOCK_DIR: pool, ...env },
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
}

/** Start `run <lane> -- <cmd...>` without waiting (signals and races). */
export function startRun(pool, lane, cmd, { args = [], env = {}, cwd } = {}) {
  const started = startBin(['run', ...args, lane, '--', ...cmd], {
    env: { GATE_LOCK_DIR: pool, ...env },
    cwd: cwd ?? wtDir(pool, 'wt0'),
  });
  // A run that is still alive when its test ends would keep beating every
  // period for as long as the host is up, so every started run is remembered
  // here and stopped after the test, failed or not.
  startedRuns.push({
    pid: started.child.pid,
    tmpRoot: env.GATE_LOCK_TEST_TMP_ROOT,
    trace: env.GATE_LOCK_TEST_TRACE,
  });
  return started;
}

/** Wait until a command has announced itself and return its pid. */
export async function up(block) {
  await waitForFile(block.ready);
  return block.pid();
}

/**
 * A live view of a started run's stderr: the test can wait for output it has not
 * received yet (the harness only hands over the full text when the run ends).
 */
export function watchStderr(child) {
  let text = '';
  child.stderr.setEncoding('utf8').on('data', (d) => {
    text += d;
  });
  return () => text;
}

/** The slot paths a run reported on stdout (from the `acquired` lines). */
export function slotsReported(stdout) {
  return [...stdout.matchAll(/^gate-lock: acquired by .* at (.*)$/gm)].map((m) => m[1]);
}

/**
 * Wait for a helper of a run to have said that it was gone, and then for the process
 * itself.
 *
 * The marker is the helper's own word: every helper publishes `<name>` from its EXIT
 * trap on every exit it takes of its own accord, and it is a much better thing to wait
 * for than process absence. A helper nobody has reaped is still a process, so a poll of
 * absence is a poll of a guess - and on a loaded host it is a guess that has outlasted
 * the bound written beside it, which is how this shape failed twice in a row here.
 *
 * `dir` may already be gone, and that counts: when the run is gone, the last helper
 * standing takes the private directory with it, and that is this helper's own last act.
 * The short bound afterwards is the assertion the test actually wants - the process is
 * gone - and a helper that published the marker and is still there is a fact worth
 * failing on.
 *
 * This is for the helpers that end by being asked. A helper that was KILLed writes no
 * marker, because a KILL runs no trap: the supervisor the teardown gives up on, and any
 * helper of a run this file's cleanup stops, are waited for by process instead.
 */
export async function waitHelperGone(dir, name, pid, { timeoutMs = 60000, settleMs = 5000 } = {}) {
  await until(() => fs.existsSync(path.join(dir, name)) || !fs.existsSync(dir), timeoutMs);
  await untilGone(pid, settleMs);
}

/** The parent of `pid`, or 0 when it is gone and cannot be asked. */
export function parentOf(pid) {
  const listed = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return 0;
  return Number(listed.stdout.trim());
}

/**
 * Wait until `pid` is not a process at all. `stopped`, not `alive`: a process this
 * shell has not reaped yet is still a process, and a helper that has ended but has not
 * been waited for would read as alive.
 */
export async function untilGone(pid, timeoutMs = 10000) {
  await until(() => stopped(pid), timeoutMs);
}

/**
 * A hook directory holding the H8 seam of one heartbeat refresh. Releasing it by
 * removing the whole directory releases the parked refresh and, because the path can no
 * longer be created, lets every later refresh through: `pause_at` creates the file it
 * waits on, and a path it cannot create is a pause it does not take. So the seam takes
 * exactly one refresh, which is what a test that parks a refresh means; `reparked` is
 * the assertion that keeps it that way, and `released` says the property holds rather
 * than that it did once.
 *
 * The directory goes rather than the file in it on purpose. Removing only the file
 * would let the next refresh re-create it and park again - a second parked refresh, which
 * is not what these tests mean, and which is what macOS CI saw on T36. And a seam whose
 * directory is gone must be *passed over*, not failed: that is the path a released seam
 * leaves behind, and a tool that ended a heartbeat there would end a run's beat and call
 * it a lost lock (see C23 in slots-ops).
 */
export function beatHook(pool, name = 'beat-hook') {
  let released = false;
  const dir = `${scratchOf(pool)}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    seam: path.join(dir, 'beat-rename'),
    release: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      released = true;
    },
    /** Has any refresh parked on this seam since it was released? */
    reparked: () => fs.existsSync(path.join(dir, 'beat-rename')),
    /** Is the seam still able to park a refresh? False once it has been released. */
    released: () => released,
  };
}

/**
 * Wait for a condition, with the tool's own trace in the failure when there is one to
 * show: a test that waits for a decision the tool has not made is exactly the case
 * where "timed out" on its own says nothing.
 */
export async function untilTraced(seen, file, timeoutMs = 60000) {
  try {
    await until(seen, timeoutMs);
  } catch (e) {
    throw new Error(`${e.message}: ${traceText(file)}`, { cause: e });
  }
}

/** The tool's decision trace, as it stands now, for a failure message: a test that
 * fails on a decision the tool made can put the tool's own account of it in the
 * message rather than a guess.
 */
export function traceText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '(no trace written)';
  }
}

/** The heartbeat pids a run printed, one per heartbeat loop its supervisor started. */
export function beatPids(stdout) {
  return [...stdout.matchAll(/^gate-lock: heartbeat pid (\d+) /gm)].map((m) => Number(m[1]));
}

/** A pid that is really alive for the length of the test. */
export function longLived() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  afterEach(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });
  return child.pid;
}

/**
 * The pids of `pid`'s children whose command line contains `needle`. A run's
 * acquire, release, command, supervisor and loop are all its children, and a test
 * that needs a signal to reach one of them and *not* the run itself has to say
 * which. `pgrep` and `ps` are on GNU and BSD alike; where they are missing the
 * tests that use this are skipped.
 */
export function childrenMatching(pid, needle) {
  const listed = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .filter((child) =>
      spawnSync('ps', ['-o', 'args=', '-p', child], { encoding: 'utf8' }).stdout.includes(needle),
    );
}

/** Is `pgrep` available here? The tests that aim a signal at a grandchild need it. */
export const HAS_PGREP = spawnSync('pgrep', ['--version'], { stdio: 'ignore' }).error === undefined;
