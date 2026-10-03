// GL3 round 11 (D25): a helper must not outlive the run it belongs to.
//
// The three helpers of a run - the supervisor, the heartbeat loop and the
// watchdog - ignore every signal for their whole life, so the only thing that can
// end one is being asked. Nothing was asking them to notice that `run` itself had
// gone, and a run that is KILLed (nothing but SIGKILL ends a wait, C40) left all
// three behind. That is the worst failure a lock can have: the beat keeps moving,
// so the slot looks held and no run, janitor or operator reclaims it.
//
// Nothing here synchronises with a sleep in the tool: the run is started, the loop
// is named from the line it printed, and the waits are polls of a condition.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { scratchOf } from './harness.js';
import { TM, names, readSlot, until } from './slots.js';
import { beatPids, blocker, freshPool, startRun, stopped, track, up } from './run.js';

/** The parent of `pid`, or 0 when it is gone and cannot be asked. */
function parentOf(pid) {
  const listed = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return 0;
  return Number(listed.stdout.trim());
}

/** Wait until `pid` is not a process at all (a zombie is still one). */
async function untilGone(pid, timeoutMs) {
  await until(() => stopped(pid), timeoutMs);
}

describe('D25 a helper does not outlive the run', () => {
  it('a KILLed run leaves no supervisor and no loop, and the slot stops beating', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_HEARTBEAT_SECONDS: '1' },
    });
    // A live view of the run's stdout: the loop's pid is in the line it printed,
    // and that line is out before anything else is.
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    const command = track(await up(block));
    const started = readSlot(pool, 'gate.lock').started;
    await until(() => readSlot(pool, 'gate.lock').beat !== started);
    const loop = beatPids(out)[0];
    expect(loop, `the run announced its loop: ${out}`).toBeGreaterThan(0);
    // The loop is the supervisor's child and the supervisor is the run's, so the two
    // pids name every helper this run started.
    const supervisor = parentOf(loop);
    expect(parentOf(supervisor), 'the supervisor is a child of the run').toBe(gate.child.pid);

    // Nothing but a KILL ends a wait (C40), and this is that: the caller gives up
    // on a run that will not answer. The slot is left behind, holding a pid that is
    // gone - and it must be left *stale*, not beating.
    gate.child.kill('SIGKILL');
    await untilGone(loop, 5000);
    await untilGone(supervisor, 5000);
    expect(stopped(loop), 'the heartbeat loop').toBe(true);
    expect(stopped(supervisor), 'the supervisor').toBe(true);

    // The beat stops where the KILL found it. A slot that keeps beating with a dead
    // pid in it is never reclaimed, so this is the whole point of the two waits.
    const beat = readSlot(pool, 'gate.lock').beat;
    await new Promise((r) => setTimeout(r, 3000));
    expect(readSlot(pool, 'gate.lock').beat, 'the beat kept moving').toBe(beat);
    // The command is not ours to stop - a KILL of the run is the caller's doing, and
    // the test kills it here rather than leaving it behind.
    expect(command).toBeGreaterThan(0);
    // Nothing of the run's is left in the pool either: the slot is there, reclaimable,
    // and nothing of the private directory is published.
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(pool).filter((n) => n.endsWith('.gone') || n.endsWith('.stop'))).toEqual([]);
    expect(names(scratchOf(pool)).filter((n) => n.startsWith('gate-lock'))).toEqual([]);
  }, 60_000);
});
