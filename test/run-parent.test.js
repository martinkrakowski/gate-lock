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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scratchOf, waitForFile } from './harness.js';
import { TM, names, readSlot, until } from './slots.js';
import {
  beatPids,
  blocker,
  freshPool,
  runDirOf,
  startRun,
  stopHelpers,
  stopped,
  track,
  up,
  waitRunGone,
} from './run.js';

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

describe('D25 nothing a test starts outlives the test', () => {
  it('a waiting command is stopped by the cleanup, whether or not the test learned its pid', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    // The command is started here rather than through `run`, because the guarantee
    // under test is the harness's own and nothing else's: a blocker parks in open(2)
    // on its fifo and never ends by itself, so a test that fails, times out or throws
    // before it tracks the pid used to leave it running for ever. Four of them were
    // found on this host eleven hours after the runs that made them, each one a
    // `block.sh` waiting on a fifo whose scratch directory had been taken away.
    const child = spawn(block.cmd[0], block.cmd.slice(1), { stdio: 'ignore' });
    const closed = new Promise((resolve) => child.on('close', resolve));
    // The handshake the command itself writes: the pid in this file is the one the
    // cleanup has to find, and the test never calls track() or pid().
    await waitForFile(block.ready);
    expect(stopped(child.pid)).toBe(false);
    stopHelpers();
    await closed;
    expect(stopped(child.pid), 'the cleanup left the command running').toBe(true);
  }, 30_000);

  it('the cleanup stops a wedged run and its helpers, which nothing else would', async () => {
    const pool = freshPool();
    const wedge = path.join(scratchOf(pool), 'loop-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_HEARTBEAT_SECONDS: '1', GATE_LOCK_TEST_LOOP_WEDGE: wedge },
    });
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    await up(block);
    await until(() => beatPids(out).length > 0, 10000);
    const loop = beatPids(out)[0];
    // The loop is the supervisor's child and the supervisor is the run's, so the two
    // pids name every helper this run started.
    const supervisor = parentOf(loop);
    expect(parentOf(supervisor), `the supervisor is a child of the run: ${out}`).toBe(
      gate.child.pid,
    );
    // The loop is wedged where it reads no stop file, so this is the shape that leaks:
    // a run that is KILLed takes none of its helpers with it, and this supervisor is
    // already waiting on that loop - which is the one wait in it that nothing times
    // out. Left alone it is still there an hour later with an hour of `sleep` under it.
    stopHelpers();
    await until(() => stopped(gate.child.pid), 5000);
    await until(() => stopped(supervisor), 5000);
    await until(() => stopped(loop), 5000);
    expect(stopped(supervisor), 'the supervisor outlived the test').toBe(true);
    expect(stopped(loop), 'the wedged loop outlived the test').toBe(true);
    // A run that is KILLed cannot take its private directory with it, and every helper
    // of it was KILLed here too, so the last one that could have removed it is gone
    // too. The test does it instead, so that a cleanup of the tests is a cleanup of
    // the host as well.
    fs.rmSync(runDirOf(gate.child.pid), { recursive: true, force: true });
  }, 30_000);
});

describe('D25 a helper does not outlive the run', () => {
  it('a KILLed run leaves no supervisor and no loop, and the slot stops beating', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_TMP_ROOT: scratchOf(pool),
      },
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
    const killed = Date.now();
    await untilGone(loop, 5000);
    await untilGone(supervisor, 5000);
    expect(stopped(loop), 'the heartbeat loop').toBe(true);
    expect(stopped(supervisor), 'the supervisor').toBe(true);

    // The beat stops where the KILL found it. A slot that keeps beating with a dead
    // pid in it is never reclaimed, so this is the whole point of the two waits.
    const beat = readSlot(pool, 'gate.lock').beat;
    await new Promise((r) => setTimeout(r, 3000));
    expect(readSlot(pool, 'gate.lock').beat, 'the beat kept moving').toBe(beat);
    // The command goes with the lock. This one stops at a plain TERM, which is what
    // the supervisor sends when it finds its run gone; the deaf command below is the
    // same shape with the grace in between.
    expect(command).toBeGreaterThan(0);
    await untilGone(command, 10000);
    expect(stopped(command), 'a command that answers TERM ends at once').toBe(true);
    // Inside a margin, and well inside the ten second grace a KILL would have needed:
    // this command was stopped by the TERM the supervisor sends as soon as it finds
    // its run gone.
    expect(Date.now() - killed, 'the command waited for the KILL').toBeLessThan(8000);
    // The last helper to leave removes the private directory, so waiting for it to
    // go is waiting for every helper of this run that writes into it.
    await waitRunGone(gate, { tmpRoot: scratchOf(pool) });
    expect(
      fs.existsSync(runDirOf(gate.child.pid, scratchOf(pool))),
      'the private directory outlived its run',
    ).toBe(false);
    // Nothing of the run's is left in the pool either: the slot is there, reclaimable,
    // and nothing of the private directory is published.
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(names(pool).filter((n) => n.endsWith('.gone') || n.endsWith('.stop'))).toEqual([]);
    expect(names(scratchOf(pool)).filter((n) => n.startsWith('gate-lock'))).toEqual([]);
  }, 60_000);

  it('a KILLed run stops a command that ignores TERM, after the grace and not after', async () => {
    const pool = freshPool();
    // Deaf to TERM, so only the KILL the grace ends in can stop it. A run that is
    // KILLed cannot reap its command and cannot stop it either, so the supervisor is
    // what does: TERM, the grace, KILL - D10's own escalation, for a run whose lock
    // is about to be lost because the beat stops with the loop.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_TMP_ROOT: scratchOf(pool),
      },
    });
    // A live view of the run's stdout, from before the command is up: the loop's
    // announcement is the proof that the heartbeat is running and will be the one to
    // notice that this run is gone.
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    const command = await up(block);
    const started = readSlot(pool, 'gate.lock').started;
    await until(() => readSlot(pool, 'gate.lock').beat !== started);
    expect(beatPids(out).length).toBeGreaterThan(0);
    gate.child.kill('SIGKILL');
    const killed = Date.now();
    await untilGone(command, 20000);
    // Inside the grace plus a margin: the grace is two seconds, and a supervisor
    // that forgot to stop the command at all would never end this wait.
    expect(Date.now() - killed, 'the deaf command outlived the grace').toBeLessThan(15000);
    expect(stopped(command), 'the command is gone, one way or another').toBe(true);
    expect(fs.existsSync(block.done), 'it was stopped, not allowed to finish').toBe(false);
    // The command ends inside the supervisor's grace, so that supervisor is still
    // running here - inside the very directory this test's cleanup takes away.
    await waitRunGone(gate, { tmpRoot: scratchOf(pool) });
    expect(
      fs.existsSync(runDirOf(gate.child.pid, scratchOf(pool))),
      'the private directory outlived its run',
    ).toBe(false);
  }, 60_000);
});
