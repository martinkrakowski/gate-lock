// GL2b: the remaining race guarantees - R3 (reclaim arbitration), R6 (a reader
// never sees an empty or missing beat), R10 (the .format publication race) and
// the slot part of T93 (a storm of N+2 acquirers into N slots). Every window is
// a pause seam or a handshaked file; no test relies on a sleep to synchronise.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BIN,
  buildEnv,
  freshPool as barePool,
  listing,
  releaseHook,
  scratchOf,
  testShell,
  waitForFile,
} from './harness.js';
import {
  TM,
  acquire,
  deadPid,
  freshPool,
  livePid,
  names,
  path,
  readSlot,
  seed,
  startAcquire,
  sub,
  wtDir,
} from './slots.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];

/** The `sh -c` argument vector for the selected shell, as the harness builds it. */
function shellCommand(script) {
  const [shellCmd, ...shellArgs] = testShell().split(/\s+/).filter(Boolean);
  return [shellCmd, [...shellArgs, '-c', script]];
}

describe('R3 reclaim arbitration', () => {
  it('R3 two acquirers that both judge a slot reclaimable: the rename picks one, the loser ends busy and the winner keeps its slot', async () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'stale-one', pid: deadPid() });
    const inspect = path.join(scratchOf(pool), 'hook-inspect');
    const scan = path.join(scratchOf(pool), 'hook-scan');
    // The second acquirer parks after judging the stale holder reclaimable (H3),
    // and the first parks after winning the name, before its own scan: every
    // step below is a handshake, so the interleaving is the test's own.
    const second = startAcquire(pool, 'second', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_INSPECT: inspect },
      cwd: wtDir(pool, 'wt-b'),
    });
    await waitForFile(inspect);
    const first = startAcquire(pool, 'first', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_SCAN: scan },
      cwd: wtDir(pool, 'wt-a'),
    });
    // The first reclaims the stale slot and wins it.
    await waitForFile(scan);
    expect(readSlot(pool, 'gate.lock').owner).toBe('first');
    const winner = readSlot(pool, 'gate.lock');
    // Let the second proceed: it renames the slot aside, finds a fresh holder
    // where the stale one was, restores it and gives up.
    releaseHook(inspect);
    const rb = await second.done;
    expect(rb.status).toBe(75);
    expect(rb.stderr).toContain('busy');
    expect(rb.stderr).toContain('first');
    expect(rb.stderr).toContain('reclaim aborted');
    expect(rb.stderr).toContain('restored');
    // Only then the first finishes its scan: the slot it won is still its own,
    // byte for byte, and the loser left no aside behind.
    releaseHook(scan);
    const ra = await first.done;
    expect(ra.status).toBe(0);
    expect(ra.stdout).toContain('acquired by first');
    expect(readSlot(pool, 'gate.lock')).toEqual(winner);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });
});

describe('R6 a reader never sees an empty or missing beat', () => {
  it('R6 thousands of reads under a heartbeat loop see neither an empty nor a missing beat', async () => {
    const pool = freshPool();
    const pid = livePid();
    expect(acquire(pool, 'lane', pid).status).toBe(0);
    const slot = path.join(pool, 'gate.lock');
    const reads = { total: 0, empty: 0, missing: 0 };
    let stopping = false;
    // The beat is replaced by rename (F38), so a reader only ever sees a whole
    // old or new value; this is the reader that proves it, thousands of times.
    const hammer = (async () => {
      while (!stopping) {
        for (let k = 0; k < 250; k += 1) {
          try {
            const value = fs.readFileSync(path.join(slot, 'beat'), 'utf8');
            reads.total += 1;
            if (value.replace(/\n/g, '') === '') reads.empty += 1;
          } catch {
            reads.missing += 1;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    // A loop of refreshes, pinned to the slot, under the shell under test, in
    // the harness's own environment (T110/H14) so nothing is inherited. The
    // binary is passed through the environment, not interpolated into the
    // script, so a checkout path with a space (or anything else the shell would
    // read) cannot break the loop.
    const refreshes = 40;
    const script = `i=0; while [ "$i" -lt ${refreshes} ]; do "$GATE_LOCK_TEST_LOOP_BIN" heartbeat || exit 1; i=$((i + 1)); done`;
    const [shellCmd, argv] = shellCommand(script);
    const loop = spawn(shellCmd, argv, {
      env: buildEnv({
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        GATE_LOCK_SLOT_PATH: slot,
        GATE_LOCK_TEST_LOOP_BIN: BIN,
      }),
      stdio: 'ignore',
    });
    const loopDone = new Promise((resolve) =>
      loop.on('close', (code, signal) => resolve({ code, signal })),
    );
    const loopResult = await loopDone;
    stopping = true;
    await hammer;
    expect(loopResult).toEqual({ code: 0, signal: null });
    expect(reads.total).toBeGreaterThan(1000);
    expect(reads.empty).toBe(0);
    expect(reads.missing).toBe(0);
    // No assertion that the beat advanced by a second: all 40 refreshes can
    // land in one epoch second, and the loop's exit status (checked above) is
    // what proves they were made.
  });
});

describe('R10 the .format publication race (H1)', () => {
  it('T93 / R10 two acquirers inside the publication window both complete: one marker, no temp, slots 0 and 1', async () => {
    // The harness's pool, with no marker yet: the only state in which two
    // acquirers can overlap inside the publication window (H1).
    const pool = barePool({ create: false });
    const link = path.join(scratchOf(pool), 'hook-link');
    const env = { ...TM, GATE_LOCK_SLOTS: '2' };
    // Both are inside the window between writing the temp marker and linking it,
    // which is only reachable while the pool has no marker at all.
    const a = startAcquire(pool, 'lane-a', livePid(), {
      env: { ...env, GATE_LOCK_TEST_PAUSE_BEFORE_FORMAT_LINK: `${link}.a` },
      cwd: wtDir(pool, 'wt-a'),
    });
    await waitForFile(`${link}.a`);
    const pidA = a.child.pid;
    const b = startAcquire(pool, 'lane-b', livePid(), {
      env: { ...env, GATE_LOCK_TEST_PAUSE_BEFORE_FORMAT_LINK: `${link}.b` },
      cwd: wtDir(pool, 'wt-b'),
    });
    await waitForFile(`${link}.b`);
    expect(names(pool).sort()).toEqual(
      [`.format.tmp.${pidA}`, `.format.tmp.${b.child.pid}`].sort(),
    );
    releaseHook(`${link}.a`);
    releaseHook(`${link}.b`);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect([ra.status, rb.status]).toEqual([0, 0]);
    expect(ra.stderr).toBe('');
    expect(rb.stderr).toBe('');
    // Exactly one marker with 1, no temp left, and the two slots.
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    expect(names(pool).sort()).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    const owners = [readSlot(pool, 'gate.lock').owner, readSlot(pool, 'gate.lock.1').owner].sort();
    expect(owners).toEqual(['lane-a', 'lane-b']);
    // Both release their own slot (C13) and leave the pool marked and empty.
    //
    // This has failed on the GitHub macOS runner (and not locally, even under
    // stress), with both releases answering 0 and the slots still there. The
    // failure carries everything needed to say why: what each release answered,
    // who each remaining slot names, and what each release was called with. Read
    // down the file: neither `find_slot owner` nor `resolve_pin` looks at the
    // caller's worktree, its cwd or TMPDIR - both take the pool from
    // GATE_LOCK_DIR, which the harness hands over as one realpath'd string for the
    // acquire and every release alike - so the platform-dependent step left in
    // that path is `owned_by`, i.e. `find <path> -prune -user <uid> -print`.
    const releases = [];
    for (const [lane, holder] of [
      ['lane-a', readSlot(pool, 'gate.lock').pid],
      ['lane-b', readSlot(pool, 'gate.lock.1').pid],
    ]) {
      const cwd = wtDir(pool, 'wt-a');
      const r = sub(pool, ['release', lane], holder, { cwd });
      const left = names(pool)
        .filter((n) => /^gate\.lock(\.\d+)?$/.test(n))
        .map(
          (n) =>
            `${n} owner=${readSlot(pool, n).owner} pid=${readSlot(pool, n).pid} worktree=${readSlot(pool, n).worktree}`,
        );
      releases.push(
        `${lane} caller pid=${holder} cwd=${cwd} -> status ${r.status} stdout ${JSON.stringify(r.stdout.trim())} stderr ${JSON.stringify(r.stderr.trim())} left ${JSON.stringify(left)}`,
      );
      expect(r.status, `${lane}: ${r.stderr}`).toBe(0);
    }
    expect(names(pool), releases.join('; ')).toEqual(['.format']);
  });
});

describe('T93 a storm of N+2 acquirers into N slots', () => {
  it('T93 20 iterations of N+2 acquirers never make more than N complete slots and leak nothing', async () => {
    const N = 2;
    const EXTRA = 2;
    const ROUNDS = 20;
    const pool = freshPool();
    // N+2 long-lived pids, one per acquirer, reused every round: a released pid
    // holds nothing, so the one-pid-one-slot refusal never fires.
    const pids = Array.from({ length: N + EXTRA }, () => livePid());
    let peak = 0;
    const sampler = setInterval(() => {
      const complete = names(pool)
        .filter((n) => /^gate\.lock(\.\d+)?$/.test(n))
        .filter((n) => SIX.every((f) => fs.existsSync(path.join(pool, n, f))));
      if (complete.length > peak) peak = complete.length;
    }, 5);
    let saturated = 0;
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const lanes = pids.map((_, k) => `round${round}-lane${k}`);
        const started = pids.map((pid, k) =>
          startAcquire(pool, lanes[k], pid, {
            env: { GATE_LOCK_SLOTS: String(N) },
            cwd: wtDir(pool, `wt-${round}-${k}`),
          }),
        );
        const results = await Promise.all(started.map((s) => s.done));
        // Every acquirer either took a slot or was told the host is busy.
        for (const r of results) expect([0, 75]).toContain(r.status);
        const winners = results.filter((r) => r.status === 0);
        expect(winners.length).toBeLessThanOrEqual(N);
        expect(winners.length).toBeGreaterThanOrEqual(1);
        if (winners.length === N) saturated += 1;
        // The peak is recorded from the settled round as well as from the
        // sampler, so the "never more than N complete slots" claim does not
        // depend on the timer having fired during the round.
        peak = Math.max(peak, winners.length);
        // Every winner is intact, with its own lane and its own pid, and no
        // two winners ever claim the same slot.
        const held = [];
        const taken = new Set();
        for (const [k, r] of results.entries()) {
          if (r.status !== 0) {
            expect(r.stderr).toContain('busy');
            continue;
          }
          const slot = r.stdout.trim().split(' at ')[1];
          expect(taken.has(slot), `${slot} was taken twice in one round`).toBe(false);
          taken.add(slot);
          expect(readSlot(pool, path.basename(slot))).toMatchObject({
            owner: lanes[k],
            pid: String(pids[k]),
          });
          expect(names(pool)).toContain(path.basename(slot));
          held.push([lanes[k], pids[k]]);
        }
        expect(peak).toBeLessThanOrEqual(N);
        // Release every holder; the pool must be left with nothing but the marker.
        for (const [lane, pid] of held) {
          expect(sub(pool, ['release', lane], pid).status).toBe(0);
        }
        expect(names(pool)).toEqual(['.format']);
      }
    } finally {
      clearInterval(sampler);
    }
    expect(saturated).toBeGreaterThanOrEqual(Math.floor(ROUNDS / 2));
    expect(peak).toBeLessThanOrEqual(N);
    expect(peak).toBeGreaterThanOrEqual(N);
    expect(listing(pool)).toEqual(['0600 .format']);
  }, 300_000); // a storm of spawns on a slow macOS runner: slow, not flaky
});
