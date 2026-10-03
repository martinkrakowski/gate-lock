// GL3: the core of `run` - spec 6.D (T23, T24, T32-T34, T37-T40, T42, T43, T46),
// R15 (lost lock while running), R20 (nested run), H6 and the run half of T64.
//
// Signal and supervisor behaviour is in run-signals.test.js, the caller loop and
// the status file in run-wait.test.js, and the caller (runner) contract in
// runner.test.js. Every window here is a file handshake: a wrapped command
// announces itself and then blocks reading a fifo, so no test sleeps to
// synchronise.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIN, listing, releaseHook, scratchOf, waitForFile } from './harness.js';
import {
  TM,
  acquire,
  deadPid,
  livePid,
  names,
  nowS,
  readSlot,
  seed,
  until,
  wtDir,
} from './slots.js';
import {
  beatPids,
  alive,
  blocker,
  freshPool,
  runOnce,
  runRaw,
  script,
  slotsReported,
  startRun,
  track,
  up,
  waitForDead,
} from './run.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];

/** A path under the pool's scratch, for a file a run writes. */
const out = (pool, name) => path.join(scratchOf(pool), name);

/** Shell code a wrapped command uses to give its slot to another holder, atomically. */
const stealSlot = `replace() {
  rm -rf "$1" "$1.new"
  mkdir -m 0700 "$1.new"
  printf 'replacement\\n' >"$1.new/owner"
  printf '%s\\n' "$2" >"$1.new/pid"
  printf '%s\\n' "$3" >"$1.new/started"
  printf '%s\\n' "$3" >"$1.new/beat"
  printf '%s\\n' "$4" >"$1.new/worktree"
  printf '%s\\n' "\${4##*/}" >"$1.new/project"
  # The replacement is published by a rename, so a heartbeat that lands in the
  # window finds either the slot or the whole replacement, never a half-written one.
  mv "$1.new" "$1"
}`;

describe('T23 run holds a slot around one command', () => {
  it("T23 the slot names the lane and run's own pid, a contender is told busy, and the run releases the slot", async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane-a', block.cmd, {
      // An unrelated caller pid in the environment must not become the holder.
      env: { GATE_LOCK_CALLER_PID: String(livePid()) },
    });
    await up(block);
    const slot = readSlot(pool, 'gate.lock');
    expect(slot.owner).toBe('lane-a');
    expect(slot.pid).toBe(String(gate.child.pid));
    expect(slot.worktree).toBe(`${scratchOf(pool)}/wt0`);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
    // A contender from another worktree is refused with 75 and busy, and the
    // holder's slot is left exactly as it was.
    const before = listing(path.join(pool, 'gate.lock'));
    const contender = acquire(pool, 'contender', livePid(), { cwd: wtDir(pool, 'wt-b') });
    expect(contender.status).toBe(75);
    expect(contender.stderr).toContain('busy');
    expect(contender.stderr).toContain('lane-a');
    expect(listing(path.join(pool, 'gate.lock'))).toEqual(before);
    // When the command ends the run exits 0 and the slot is gone.
    block.release();
    const r = await gate.done;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`acquired by lane-a pid ${gate.child.pid}`);
    expect(r.stdout).toContain('released by lane-a');
    expect(names(pool)).toEqual(['.format']);
    expect(slotsReported(r.stdout)).toEqual([`${pool}/gate.lock`]);
  });

  it('C32 the command inherits stdout and stderr unchanged, so a failing run is reported live', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane-a', block.cmd, { env: { GATE_LOCK_SLOTS: '2' } });
    await up(block);
    const live = startRun(pool, 'lane-b', ['sh', '-c', 'echo out-of-band; echo err-out >&2'], {
      cwd: wtDir(pool, 'wt-b'),
      env: { GATE_LOCK_SLOTS: '2' },
    });
    const r = await live.done;
    expect(r.status).toBe(0);
    // Not captured into anything: both streams arrive.
    expect(r.stdout).toContain('out-of-band');
    expect(r.stderr).toContain('err-out');
    expect(r.stdout).toContain('acquired by lane-b');
    block.release();
    expect((await gate.done).status).toBe(0);
  });
});

describe('T24 the heartbeat loop', () => {
  it('T24 with a one-second period the beat moves past the start time, stdout names the heartbeat pid, stderr is empty', () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    const moved = path.join(scratchOf(pool), 'moved');
    // Bounded polling inside the command, not a single timed read: the command
    // itself proves the beat moved.
    const cmd = [
      script(
        pool,
        'beat-watch.sh',
        `started=$(cat "$1/started")
i=0
while [ "$i" -lt 20 ]; do
  b=$(cat "$1/beat" 2>/dev/null || printf '')
  if [ -n "$b" ] && [ "$b" -gt "$started" ]; then printf '%s\\n' "$b" >"$2"; break; fi
  i=$((i + 1))
  sleep 1
done`,
      ),
      slot,
      moved,
    ];
    const r = runOnce(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('heartbeat pid');
    expect(r.stdout).toContain('every 1s while lane runs');
    expect(Number(fs.readFileSync(moved, 'utf8').trim())).toBeGreaterThan(nowS() - 5);
    expect(beatPids(r.stdout)).toHaveLength(1);
    expect(names(pool)).toEqual(['.format']);
  });

  it('D10 the supervisor owns the loop: the beat moves while the command runs, and the loop is reaped with the run', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    await up(block);
    const started = readSlot(pool, 'gate.lock').started;
    await until(() => readSlot(pool, 'gate.lock').beat !== started);
    block.release();
    const r = await gate.done;
    expect(r.status).toBe(0);
    // Nothing outlives the run: the loop the supervisor started is gone.
    expect(beatPids(r.stdout)).toHaveLength(1);
  });

  it('C42 the loop stages its beat beside the slot and leaves nothing behind', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    await up(block);
    const started = readSlot(pool, 'gate.lock').started;
    await until(() => readSlot(pool, 'gate.lock').beat !== started);
    // While the command runs, the pool holds the marker and the slot and
    // nothing else: no transient is ever left at the end of a refresh.
    expect(names(pool).sort()).toEqual(['.format', 'gate.lock']);
    block.release();
    expect((await gate.done).status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T32 the command status is the run status', () => {
  it('T32 the command status passes through and the slot is still released', () => {
    const pool = freshPool();
    for (const code of ['3', '127', '1']) {
      const r = runOnce(pool, 'lane', ['sh', '-c', `exit ${code}`]);
      expect(r.status).toBe(Number(code));
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain('released by lane');
      expect(names(pool)).toEqual(['.format']);
    }
  });
});

describe('T33 a replacement slot', () => {
  it('T33 a command that replaces the slot with another holder: non-zero, verify failed, FAILED to release, release refused, the replacement intact', () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    const other = livePid();
    const worktree = `${scratchOf(pool)}/wt9`;
    const started = nowS();
    // One heartbeat period of an hour, so the only refresh this run makes is the
    // first one and what decides the answer is the replacement, not a lost lock.
    const cmd = [
      script(pool, 'steal-exit.sh', `${stealSlot}\nreplace "$1" "$2" "$3" "$4"`),
      slot,
      other,
      started,
      worktree,
    ];
    const r = runOnce(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '3600' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('verify failed');
    expect(r.stderr).toContain('FAILED to release the lock');
    expect(r.stderr).toContain('release refused');
    // The replacement is left exactly as the command wrote it.
    expect(readSlot(pool, 'gate.lock')).toEqual({
      owner: 'replacement',
      pid: String(other),
      started: String(started),
      beat: String(started),
      worktree,
      project: 'wt9',
    });
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });
});

describe('T34 / R15 the lock is lost while the command runs', () => {
  it('T34 replacing the slot with another holder stops the command: non-zero, the lost-lock line, the command dead, no completion marker, the replacement intact', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    const other = livePid();
    const worktree = `${scratchOf(pool)}/wt9`;
    const started = nowS();
    // The command gives its own slot to another holder and keeps running.
    const block = blocker(pool, 'thief', {
      pre: `${stealSlot}\nreplace "$2" "$3" "$4" "$5"`,
      args: [slot, other, started, worktree],
    });
    const gate = startRun(pool, 'lane', block.cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    await up(block);
    const victim = track(block.pid());
    const r = await gate.done;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('the lock was lost while the command ran');
    expect(r.stderr).toContain('lock lost');
    // The command was stopped: its pid is dead and its completion marker absent.
    await waitForDead(victim);
    expect(fs.existsSync(block.done)).toBe(false);
    // The replacement slot is left in place.
    expect(readSlot(pool, 'gate.lock').owner).toBe('replacement');
    expect(readSlot(pool, 'gate.lock').pid).toBe(String(other));
  });

  it('R15 the same with the slot deleted outright (a reclaim stand-in)', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    const block = blocker(pool, 'victim', { pre: 'rm -rf "$2"', args: [slot] });
    const gate = startRun(pool, 'lane', block.cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    await up(block);
    const victim = track(block.pid());
    const r = await gate.done;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('the lock was lost while the command ran');
    expect(r.status).toBe(2);
    await waitForDead(victim);
    expect(fs.existsSync(block.done)).toBe(false);
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T37 the slot disappears under the run', () => {
  it('T37 a command that deletes the slot and exits: non-zero with verify, no lock and FAILED to release', () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    // One heartbeat period of an hour: the only refresh is the first one, so what
    // decides the answer is the slot's absence, not the loop noticing it.
    const cmd = [script(pool, 'drop-exit', `rm -rf "$1"`), slot];
    const r = runOnce(pool, 'lane', cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '3600' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('verify');
    expect(r.stderr).toContain('no lock');
    expect(r.stderr).toContain('FAILED to release the lock');
    // The release itself is idempotent, which is why the verify is separate:
    // it says "nothing to release" and run is the one that reports the failure.
    expect(r.stdout).toContain('nothing to release');
    expect(r.stdout).not.toContain('released by lane');
  });
});

describe('T38 / R20 a nested run', () => {
  it('T38 the inner run loses with 75 naming the outer lane, never starts its command, and the outer run still releases', async () => {
    const pool = freshPool();
    const outer = blocker(pool, 'outer');
    const inner = blocker(pool, 'inner');
    const a = startRun(pool, 'outer-lane', outer.cmd, { env: { GATE_LOCK_SLOTS: '2' } });
    await up(outer);
    // Two slots, so the inner run wins one, finds the outer holder in the same
    // worktree, gives its own slot back and says so (F56 through run).
    const b = runOnce(pool, 'inner-lane', inner.cmd, { env: { GATE_LOCK_SLOTS: '2' } });
    expect(b.status).toBe(75);
    expect(b.stderr).toContain('busy');
    expect(b.stderr).toContain('same worktree');
    expect(b.stderr).toContain('outer-lane');
    expect(b.stdout).not.toContain('acquired');
    // The inner command never started.
    expect(fs.existsSync(inner.ready)).toBe(false);
    expect(fs.existsSync(inner.done)).toBe(false);
    // The outer run is untouched and still cleans up.
    expect(readSlot(pool, 'gate.lock').owner).toBe('outer-lane');
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    outer.release();
    const r = await a.done;
    expect(r.status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });

  it('R20 with one slot the inner run is simply busy, and still starts no command', async () => {
    const pool = freshPool();
    const outer = blocker(pool, 'outer');
    const inner = blocker(pool, 'inner');
    const a = startRun(pool, 'outer-lane', outer.cmd);
    await up(outer);
    const b = runOnce(pool, 'inner-lane', inner.cmd);
    expect(b.status).toBe(75);
    expect(b.stderr).toContain('busy');
    expect(b.stderr).toContain('outer-lane');
    expect(fs.existsSync(inner.ready)).toBe(false);
    outer.release();
    expect((await a.done).status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T39 the command arguments', () => {
  it('T39 arguments pass through intact: spaces, a later --, quotes and globs', () => {
    const pool = freshPool();
    const out = path.join(scratchOf(pool), 'argv');
    const argv = [
      script(pool, 'argv.sh', `: >"$1"\nprintf '%s\\n' "$@" >>"$1"`),
      out,
      'one two',
      '--',
      'three four',
      '*.ts',
      "it's",
      '',
    ];
    const r = runOnce(pool, 'lane', argv);
    expect(r.status).toBe(0);
    // `"$@"` in the command is everything after the script: the output file, then
    // the arguments. Nothing was re-parsed, split or expanded, and the later `--`
    // arrived as an ordinary argument (C29).
    expect(fs.readFileSync(out, 'utf8')).toBe(`${out}\none two\n--\nthree four\n*.ts\nit's\n\n`);
  });
});

describe('T40 usage errors take no lock', () => {
  it('T40 no separator, nothing after the separator, no lane and a stray word are all exit 2 with usage', () => {
    const pool = freshPool();
    const cases = [
      ['lane', 'true'],
      ['lane', '--'],
      ['--', 'true'],
      ['lane', 'extra', '--', 'true'],
      ['lane', 'true', '--', 'true'],
    ];
    for (const args of cases) {
      const r = runRaw(pool, args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/^gate-lock: [^\n]+\nusage: gate-lock /);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(names(pool), args.join(' ')).toEqual(['.format']);
    }
  });

  it('T40 an unknown option and a missing option value are usage errors too', () => {
    const pool = freshPool();
    for (const args of [
      ['--frobnicate', 'lane', '--', 'true'],
      ['--wait', 'lane', '--', 'true'],
      ['--status-file', 'lane', '--', 'true'],
      ['--wait', 'x', 'lane', '--', 'true'],
    ]) {
      const r = runRaw(pool, args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toContain('usage');
      expect(names(pool)).toEqual(['.format']);
    }
  });
});

describe('T42 / T43 the heartbeat period', () => {
  it('T42 zero is refused naming the variable and "at least one second", with no lock taken', () => {
    const pool = freshPool();
    const r = runOnce(pool, 'lane', ['true'], { env: { GATE_LOCK_HEARTBEAT_SECONDS: '0' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GATE_LOCK_HEARTBEAT_SECONDS');
    expect(r.stderr).toContain('at least one second');
    expect(r.stdout).toBe('');
    expect(names(pool)).toEqual(['.format']);
  });

  it('T43 a non-numeric period is refused naming the variable, before any lock is taken', () => {
    const pool = freshPool();
    for (const v of ['x', '1.5', '-1', '12345678901']) {
      const r = runOnce(pool, 'lane', ['true'], { env: { GATE_LOCK_HEARTBEAT_SECONDS: v } });
      expect(r.status, v).toBe(2);
      expect(r.stderr, v).toContain('GATE_LOCK_HEARTBEAT_SECONDS');
      expect(names(pool), v).toEqual(['.format']);
    }
  });
});

describe('T64 / F66 the command sees no pin', () => {
  it('T64 run takes slot 0 although the inherited pin names slot 1, the command sees no GATE_LOCK_SLOT_* variable, and the slot is released', () => {
    const pool = freshPool();
    const seen = path.join(scratchOf(pool), 'env');
    const inheritedOut = path.join(scratchOf(pool), 'inherited-out');
    const r = runOnce(pool, 'lane', [script(pool, 'dump-env.sh', `env | sort >"$1"`), seen], {
      env: {
        GATE_LOCK_SLOTS: '2',
        GATE_LOCK_SLOT_PATH: path.join(pool, 'gate.lock.1'),
        GATE_LOCK_SLOT_OUT: inheritedOut,
      },
    });
    expect(r.status).toBe(0);
    expect(slotsReported(r.stdout)).toEqual([path.join(pool, 'gate.lock')]);
    const slots = fs
      .readFileSync(seen, 'utf8')
      .split('\n')
      .filter((l) => l.includes('GATE_LOCK_SLOT_'));
    expect(slots).toEqual([]);
    // The inherited slot-out file was never written either: run records its own.
    expect(fs.existsSync(inheritedOut)).toBe(false);
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T46 three runs at slot count 3', () => {
  it('T46 three runs in three worktrees hold three slots; a fourth is told busy and no fourth slot appears', async () => {
    const pool = freshPool();
    // Twelve processors, four workers a slot: three slots (V11), and the counts
    // agree, so nothing else is refused.
    const env = {
      ...TM,
      GATE_LOCK_TEST_NPROC: '12',
      GATE_HOST_WORKERS: '4',
      GATE_LOCK_HEARTBEAT_SECONDS: '1',
      // The project's own count is left unset, so the host's derived count is
      // the pool's count and the two cannot disagree (V12, V15).
      GATE_LOCK_SLOTS: undefined,
    };
    const runs = [0, 1, 2].map((k) => {
      const block = blocker(pool, `lane${k}`);
      const gate = startRun(pool, `lane${k}`, block.cmd, { env, cwd: wtDir(pool, `wt-${k}`) });
      return { block, gate, worktree: `${scratchOf(pool)}/wt-${k}` };
    });
    // Whatever happens, the three runs are released and reaped: a leaked run
    // keeps beating for as long as the host is up, and this suite is not a gate.
    try {
      for (const r of runs) await up(r.block);
      const held = names(pool)
        .filter((n) => /^gate\.lock(\.\d+)?$/.test(n))
        .sort();
      expect(held).toEqual(['gate.lock', 'gate.lock.1', 'gate.lock.2']);
      // Each slot records its own run's pid and its own worktree.
      for (const [k, name] of held.entries()) {
        const slot = readSlot(pool, name);
        expect(slot.worktree).toBe(runs[k].worktree);
        expect(slot.owner).toBe(`lane${k}`);
        expect(runs[k].gate.child.pid).toBe(Number(slot.pid));
      }
      // A fourth run in a fourth worktree is refused as busy, naming a holder.
      const fourth = blocker(pool, 'lane3');
      const refused = runOnce(pool, 'lane3', fourth.cmd, { env, cwd: wtDir(pool, 'wt-3') });
      expect(refused.status).toBe(75);
      expect(refused.stderr).toContain('busy');
      expect(refused.stderr).toMatch(/lane[0-2]/);
      expect(names(pool).filter((n) => /^gate\.lock(\.\d+)?$/.test(n))).toHaveLength(3);
      expect(fs.existsSync(fourth.ready)).toBe(false);
    } finally {
      for (const r of runs) r.block.release();
      for (const r of runs) await r.gate.done;
    }
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('the worker cap warning', () => {
  it('with more than one slot and no worker cap anywhere, run warns once on stderr and the exit status is unchanged', () => {
    const pool = freshPool();
    const warned = runOnce(pool, 'lane', ['sh', '-c', 'exit 3'], { env: { GATE_LOCK_SLOTS: '3' } });
    // The warning is on stderr and the status is the command's own, unchanged.
    expect(warned.status).toBe(3);
    const lines = warned.stderr.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^gate-lock: .*workers?/);
    expect(lines[0]).toContain('GATE_LOCK_WORKERS');
    // With a cap set the decision has been made, so the tool says nothing. The
    // host's processor count is pinned through the seam, because a cap also
    // derives the slot count (V11) and a mismatch is a refusal of its own (V15).
    const pinned = { ...TM, GATE_LOCK_TEST_NPROC: '6', GATE_LOCK_SLOTS: undefined };
    for (const env of [{ GATE_HOST_WORKERS: '2' }, { GATE_LOCK_WORKERS: '2' }]) {
      const r = runOnce(pool, 'lane', ['true'], { env: { ...pinned, ...env } });
      expect(r.status, JSON.stringify(env)).toBe(0);
      expect(r.stderr, JSON.stringify(env)).toBe('');
    }
    // One slot is the default and never warns.
    expect(runOnce(pool, 'lane', ['true']).stderr).toBe('');
  });
});

describe('H6 after-acquire', () => {
  it('H6 a run parked after the acquire holds the slot and starts no command until it is let go', async () => {
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'hook-after-acquire');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_ACQUIRE: hook },
    });
    await waitForFile(hook);
    // The slot exists, named for this run, and the command has not started.
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane');
    expect(fs.existsSync(block.ready)).toBe(false);
    releaseHook(hook);
    await up(block);
    block.release();
    expect((await gate.done).status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('T41 / R9 a signal before the held flag', () => {
  it('T41 TERM to a run parked after the acquire releases the slot, exits 143 and starts no command', async () => {
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'hook-after-acquire');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_AFTER_ACQUIRE: hook },
    });
    await waitForFile(hook);
    gate.child.kill('SIGTERM');
    releaseHook(hook);
    const r = await gate.done;
    expect(r.status).toBe(143);
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    expect(fs.existsSync(block.ready)).toBe(false);
  });
});

describe('D10 the supervisor stops a command that ignores TERM', () => {
  it('D10 a command that ignores TERM is KILLed after the grace period, and the run reports the lost lock', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    // The command takes its own slot away, so the next refresh fails, and it
    // ignores the TERM that follows: only the KILL can stop it.
    const block = blocker(pool, 'thief', { ignoreTerm: true, pre: 'rm -rf "$2"', args: [slot] });
    const gate = startRun(pool, 'lane', block.cmd, { env: { GATE_LOCK_HEARTBEAT_SECONDS: '1' } });
    await up(block);
    const victim = track(block.pid());
    // The grace period is ten seconds (D10), which is why this test has its own
    // budget: it proves the KILL really happens and not before it.
    const started = Date.now();
    const r = await gate.done;
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('lock lost');
    expect(Date.now() - started).toBeGreaterThan(9000);
    await waitForDead(victim, 20000);
    expect(fs.existsSync(block.done)).toBe(false);
    expect(names(pool)).toEqual(['.format']);
  }, 60_000);
});

describe('a probe like the one that hung for 77 minutes', () => {
  it('D10 under `timeout`, a run around a command that ignores TERM ends by itself: it exits inside the grace, and no lock outlives it', () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    // The shape that hung: `timeout 30 gate-lock run lane -- <a command that
    // ignores TERM>`, with the command taking its own slot away so the loop
    // stops it. Which internal path answers depends on whether the loop or the
    // command is first to notice, so the test says what must always be true: the
    // run ends by itself, well inside the probe's own budget, says the lock was
    // lost or that it could not give it back, kills the command and leaves the
    // pool as it found it.
    const block = blocker(pool, 'deaf', { ignoreTerm: true, pre: 'rm -rf "$2"', args: [slot] });
    const status = out(pool, 'probe-status');
    const probe = spawnSync(
      'timeout',
      ['30', BIN, 'run', '--status-file', status, 'lane', '--', ...block.cmd],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GATE_LOCK_DIR: pool,
          GATE_LOCK_HEARTBEAT_SECONDS: '1',
          GATE_LOCK_TEST_MODE: '1',
          GATE_LOCK_TEST_KILL_GRACE: '2',
        },
        encoding: 'utf8',
        timeout: 40000,
      },
    );
    // `timeout` answers 124 when its child overran it: this is the whole point
    // of the test, and the run's own status is what it should be instead.
    expect(probe.status).not.toBe(124);
    expect(probe.status).toBe(2);
    expect(probe.stderr).toMatch(/lock lost|FAILED to release the lock/);
    expect(fs.readFileSync(status, 'utf8')).toBe('tool:2\n');
    // The command is dead and the pool is as it was: no slot for the next
    // caller to reclaim, and no transient left in the pool.
    expect(fs.existsSync(`${block.dir}/done`)).toBe(false);
    expect(names(pool)).toEqual(['.format']);
    const pid = Number(fs.readFileSync(`${block.dir}/ready`, 'utf8'));
    expect(track(pid)).toBe(pid);
    expect(alive(pid)).toBe(false);
  }, 60_000);
});

describe('D10 a loop that keeps dying', () => {
  it('D10 the supervisor restarts the loop once and the run still returns the command status', async () => {
    const pool = freshPool();
    const die = path.join(scratchOf(pool), 'loop-die');
    fs.writeFileSync(die, '1\n');
    // The command keeps the run alive, so both loops are certainly started.
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_TEST_LOOP_DIE: die, GATE_LOCK_HEARTBEAT_SECONDS: '1' },
    });
    await up(block);
    // The first loop died before it ever refreshed the beat, so a beat that moves
    // is the restarted loop at work.
    const started = readSlot(pool, 'gate.lock').started;
    await until(() => readSlot(pool, 'gate.lock').beat !== started);
    expect(fs.readFileSync(die, 'utf8').trim()).toBe('0');
    block.release();
    const r = await gate.done;
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(beatPids(r.stdout)).toHaveLength(2);
  });

  it('D10 a second abnormal death stops the command and the run exits 2 with "lock lost"', async () => {
    const pool = freshPool();
    const die = path.join(scratchOf(pool), 'loop-die');
    fs.writeFileSync(die, '2\n');
    const block = blocker(pool, 'victim', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_TEST_LOOP_DIE: die,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
      },
    });
    await up(block);
    const victim = track(block.pid());
    const r = await gate.done;
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('lock lost');
    expect(r.stderr).toContain('the lock was lost while the command ran');
    await waitForDead(victim);
    expect(fs.existsSync(block.done)).toBe(false);
  });
});

describe('D21 the file recording the slot path', () => {
  it('the run records its slot path outside the pool and leaves neither there nor beside it', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd);
    await up(block);
    // Nothing of run's own is published in the pool: the slot path was recorded
    // in a private directory, which the acquire wrote through D21's own rules.
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    block.release();
    expect((await gate.done).status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
    expect(names(scratchOf(pool)).filter((n) => n.startsWith('gate-lock-run'))).toEqual([]);
  });
});

describe('a busy pool is never taken over', () => {
  it('run is busy against a live holder and leaves the slot byte for byte as found', () => {
    const pool = freshPool();
    const holder = seed(pool, 'gate.lock', { owner: 'holder', pid: livePid() });
    const before = listing(holder);
    const r = runOnce(pool, 'lane', ['true']);
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('busy');
    expect(r.stderr).toContain('holder');
    expect(r.stdout).not.toContain('acquired');
    expect(listing(holder)).toEqual(before);
  });

  it('C10 a run that reclaims a dead holder says so on stdout, before the acquired line', () => {
    const pool = freshPool();
    seed(pool, 'gate.lock', { owner: 'corpse', pid: deadPid(), beat: nowS() });
    const r = runOnce(pool, 'lane', ['true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reclaiming');
    expect(r.stdout.indexOf('reclaiming')).toBeLessThan(r.stdout.indexOf('acquired by'));
    expect(names(pool)).toEqual(['.format']);
  });
});

describe('a lane label run cannot store', () => {
  it('D14 a label with a newline is refused by run before anything is taken', () => {
    const pool = freshPool();
    const r = runOnce(pool, 'bad\nlabel', ['true']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('printable ASCII');
    expect(names(pool)).toEqual(['.format']);
  });
});
