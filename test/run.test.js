// GL3: the core of `run` - spec 6.D (T23, T24, T32-T34, T37-T40, T42, T43, T46),
// R15 (lost lock while running), R20 (nested run), H6 and the run half of T64.
//
// Signal and supervisor behaviour is in run-signals.test.js, the caller loop and
// the status file in run-wait.test.js, and the caller (runner) contract in
// runner.test.js. Every window here is a file handshake: a wrapped command
// announces itself and then blocks reading a fifo, so no test sleeps to
// synchronise.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listing, releaseHook, scratchOf, startBin, waitForFile } from './harness.js';
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
  beatHook,
  beatPids,
  blocker,
  freshPool,
  heldListing,
  parentOf,
  runOnce,
  runRaw,
  script,
  slotsReported,
  startRun,
  stopped,
  traceText,
  track,
  up,
  untilGone,
  untilTraced,
  waitForDead,
} from './run.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];

/**
 * The staged beats in a pool, by the tool's own name pattern: `<slot>.beatnew.<pid>`
 * beside the slot (F39). A staging file that survives a run means a refresh was cut
 * off between staging and the rename, which is a leak of ours and not the janitor's
 * (D16), so the tests that assert an exact pool listing also assert this is empty.
 */
const stagedBeats = (pool) =>
  names(pool).filter((n) => /^gate\.lock(\.\d+)?\.beatnew\.\d+$/.test(n));

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
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
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
    // While the command runs, the pool holds the marker and the slot and nothing
    // else - apart from a staged beat, which is what a refresh looks like from the
    // outside between staging it and renaming it, and which is gone a moment later.
    const held = heldListing(pool);
    expect(held.held.sort(), `pool: ${held.listing}`).toEqual(['.format', 'gate.lock']);
    expect(held.staged.length, `staged beats: ${held.listing}`).toBeLessThanOrEqual(1);
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
      expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
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
    // The outer run is live and its heartbeat refreshes every period, so its first
    // refresh can be staging its beat at this instant (D21).
    const held = heldListing(pool);
    expect(held.held, `pool: ${held.listing}`).toEqual(['.format', 'gate.lock']);
    expect(held.staged.length, `staged beats: ${held.listing}`).toBeLessThanOrEqual(1);
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
    // Sound but slow: the inner run spawns the tool twice (its own acquire and the
    // release it does not do), and under CPU stress that can outlast the
    // harness's spawn timeout - which would signal the run and turn this into a
    // test of the harness. Everything else here is a handshake.
    const b = runOnce(pool, 'inner-lane', inner.cmd, { timeout: 120000 });
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
  it('T40 every `gate-lock run` line in the README parses: the options come before the lane and -- follows it', () => {
    // Every `gate-lock run …` command the README shows a caller is run here with
    // its command replaced by `true` and its paths moved into this test's scratch,
    // so a recipe the parser rejects - the options after the lane, the wrong
    // number of arguments - fails this test rather than a reader's copy and paste.
    const pool = freshPool();
    const docs = ['README.md', 'CHANGELOG.md'].map((name) =>
      fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'),
    );
    const shown = docs
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      // The synopsis is a shape, not a command to run; every other line that
      // names `gate-lock run` and has a body is one.
      .filter((line) => /^gate-lock run \S/.test(line) && !line.includes('[--'))
      // `gate-lock run "$lane" … || case …` is a shell fragment: keep the run and
      // its arguments, drop the pipeline.
      .map((line) => line.split('||')[0].trim());
    expect(shown.length).toBeGreaterThan(3);
    for (const line of shown) {
      const head = line
        .replace(/\s+#.*$/, '')
        .split(/\s+/)
        .slice(2)
        .filter(Boolean);
      const separator = head.indexOf('--');
      expect(separator, line).toBeGreaterThan(0);
      // A shell word stands for itself here: the default of `${X:-n}` is n, and
      // a quoted variable or an absolute path becomes something of this test's.
      const args = head.slice(0, separator).map((word) => {
        const bare = word.replace(/^["']|["']$/g, '');
        const m = bare.match(/^\$\{[A-Z_]+:-(.+)\}$/);
        if (m) return m[1];
        if (bare === 'lane') return 'lane';
        if (bare.startsWith('/')) return path.join(scratchOf(pool), path.basename(bare));
        return bare;
      });
      // The words go to the parser in the order the README writes them, so the
      // parser is what judges them: options first, then the lane, then `--`. A
      // recipe with the options after the lane is a usage error here.
      const r = runRaw(pool, [...args, '--', 'true']);
      expect(r.status, `${line}\nstatus ${r.status}\n${r.stderr}`).toBe(0);
    }
  });

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
      return { block, gate, lane: `lane${k}`, worktree: wtDir(pool, `wt-${k}`) };
    });
    // Whatever happens, the three runs are released and reaped: a leaked run
    // keeps beating for as long as the host is up, and this suite is not a gate.
    try {
      for (const r of runs) await up(r.block);
      const held = names(pool)
        .filter((n) => /^gate\.lock(\.\d+)?$/.test(n))
        .sort();
      expect(held).toEqual(['gate.lock', 'gate.lock.1', 'gate.lock.2']);
      // Each slot records its own run's pid and its own worktree. Which lane wins
      // which slot is a race and is not asserted: a slot is matched to its run by
      // the worktree, which is what makes it that run's.
      for (const name of held) {
        const slot = readSlot(pool, name);
        const run = runs.find((r) => r.worktree === slot.worktree);
        expect(run, `${name} holds ${slot.worktree}`).toBeDefined();
        expect(slot.owner).toBe(run.lane);
        expect(slot.project).toBe(path.basename(slot.worktree));
        expect(run.gate.child.pid).toBe(Number(slot.pid));
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

describe('a signal into a half-built subshell', () => {
  it('D10 eight normal runs with slots to spare print nothing but the worker warning on stderr', () => {
    // `run` stops its supervisor and its loop as soon as a command that exits at
    // once is over, which is exactly when a helper subshell may still be starting.
    // bash 3.2 answers a TERM that meets a default disposition in a shell it is
    // still building with its own `run_pending_traps` warning and a resend of the
    // signal to itself - noise on the stderr a caller reads. The tool now asks
    // those subshells to stop through a file instead of a signal. On dash and bash
    // this passes either way; the macOS leg (/bin/sh = bash 3.2) is the check that
    // matters.
    const pool = freshPool();
    const seen = [];
    for (let round = 0; round < 8; round += 1) {
      const r = runOnce(pool, 'lane', ['sh', '-c', 'exit 3'], {
        env: { GATE_LOCK_SLOTS: '2' },
        timeout: 60000,
      });
      expect(r.status, `round ${round}: ${r.stderr}`).toBe(3);
      expect(r.stderr.split('\n').filter(Boolean), `round ${round}`).toHaveLength(1);
      seen.push(r.stderr);
    }
    expect(seen.every((s) => /workers?/.test(s))).toBe(true);
    expect(names(pool), `pool: ${names(pool)}`).toEqual(['.format']);
    expect(stagedBeats(pool)).toEqual([]);
  }, 60_000);
});

describe('the worker cap warning', () => {
  it('with more than one slot and no worker cap anywhere, run warns once on stderr and the exit status is unchanged', () => {
    const pool = freshPool();
    const warned = runOnce(pool, 'lane', ['sh', '-c', 'exit 3'], { env: { GATE_LOCK_SLOTS: '3' } });
    // The warning is on stderr and the status is the command's own, unchanged.
    expect(warned.status).toBe(3);
    const lines = warned.stderr.split('\n').filter(Boolean);
    expect(lines, warned.stderr).toHaveLength(1);
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

describe('D10 a helper that has already ended is not waited for', () => {
  it('D10 a watchdog that is gone before the command ends is not waited for: its stop file costs nothing', async () => {
    const pool = freshPool();
    const scratch = scratchOf(pool);
    // The command deafens itself to TERM, so the only thing that can stop it is
    // the KILL the watchdog escalates to. The seam retires that watchdog as soon as
    // it is armed - the state the cleanup finds when the grace ran out on its own -
    // so the run is about to write a stop file into the void: nothing is left to
    // take that file away, and a wait that watches it would spend its whole bound
    // before giving up. The gone file the watchdog leaves on every exit is what
    // tells the cancel not to.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        TMPDIR: scratch,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '30',
        GATE_LOCK_TEST_ESC_GONE: '1',
      },
    });
    await up(block);
    const victim = track(block.pid());
    gate.child.kill('SIGTERM');
    // The watchdog publishes its own pid, so the test can wait for it to be gone
    // rather than hope it is: the cancel below is only worth anything once the
    // helper it stops has certainly ended.
    const dir = path.join(scratch, `gate-lock-run.${gate.child.pid}`);
    await waitForFile(path.join(dir, 'escalator.pid'), 10000);
    const watchdog = Number(fs.readFileSync(path.join(dir, 'escalator.pid'), 'utf8'));
    await until(() => stopped(watchdog), 10000);
    expect(stopped(watchdog), 'the watchdog is gone before the command ends').toBe(true);
    block.release();
    const started = Date.now();
    const r = await gate.done;
    // The stop-file wait is bounded at eight one-second rounds, so a teardown that
    // waited on a watchdog which had already gone could not answer inside five of
    // these; a run that ends by itself spends nothing on it.
    expect(Date.now() - started, 'the teardown waited on a watchdog that was gone').toBeLessThan(
      5000,
    );
    expect(r.status).toBe(143);
    await waitForDead(victim, 10000);
    expect(fs.existsSync(block.done)).toBe(true);
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
    expect(names(pool)).toEqual(['.format']);
  }, 60_000);
});

describe('D26 the descriptors a wrapped command sees', () => {
  it("a caller's own descriptor 3 reaches the command, and fd 9 is run's alone", async () => {
    const pool = freshPool();
    const seen = out(pool, 'caller-fd3');
    const fd = fs.openSync(seen, 'w', 0o600);
    // `run` keeps its own stderr on a descriptor of its own, so that the shell's job
    // notices cannot land on the caller's, and it used descriptor 3 - which is a
    // descriptor a caller may well be using. This hands the tool a descriptor 3 of
    // the caller's own, opened on a file, and the command writes to it: what lands in
    // the file is the command's own writing, not the tool's.
    const cmd = [
      'sh',
      '-c',
      'printf "%s\\n" "through three" >&3; printf "%s\\n" "through nine" >&9 || printf "%s\\n" "nine closed" >&3',
    ];
    const gate = startBin(['run', 'lane', '--', ...cmd], {
      env: { ...TM, GATE_LOCK_DIR: pool },
      cwd: wtDir(pool, 'wt0'),
      fd3: fd,
    });
    const r = await gate.done;
    fs.closeSync(fd);
    expect(r.status, JSON.stringify(r.stderr)).toBe(0);
    // The caller's fd 3 is the command's fd 3, and the one descriptor `run` does not
    // pass through is its own (the README says which).
    expect(fs.readFileSync(seen, 'utf8')).toBe('through three\nnine closed\n');
    expect(names(pool)).toEqual(['.format']);
  }, 60_000);
});

describe('a probe like the one that hung for 77 minutes', () => {
  it('D10 around a command that ignores TERM, a run ends by itself: it exits inside the grace, and no lock outlives it', async () => {
    const pool = freshPool();
    const slot = path.join(pool, 'gate.lock');
    // The shape that hung: `timeout 30 gate-lock run lane -- <a command that
    // ignores TERM>`, with the command taking its own slot away so the loop
    // stops it. Which internal path answers depends on whether the loop or the
    // command is first to notice, so the test says what must always be true: the
    // run ends by itself, well inside the budget, says the lock was lost or that
    // it could not give it back, kills the command and leaves the pool as it
    // found it.
    //
    // The deadline `timeout 30` used to enforce is enforced from node instead:
    // macOS ships no GNU `timeout`, and a test must not depend on one. A run that
    // needs this signal is a run that did not end by itself, and that is what the
    // first assertion below says.
    const block = blocker(pool, 'deaf', { ignoreTerm: true, pre: 'rm -rf "$2"', args: [slot] });
    const status = out(pool, 'probe-status');
    const gate = startBin(['run', '--status-file', status, 'lane', '--', ...block.cmd], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_SLOTS: '1',
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
      },
      cwd: wtDir(pool, 'wt0'),
    });
    let neededTheSignal = false;
    const timer = setTimeout(() => {
      neededTheSignal = true;
      gate.child.kill('SIGTERM');
    }, 30000);
    let r;
    try {
      r = await gate.done;
    } finally {
      clearTimeout(timer);
    }
    expect(neededTheSignal).toBe(false);
    expect(r.signal).toBe(null);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lock lost|FAILED to release the lock/);
    expect(fs.readFileSync(status, 'utf8')).toBe('tool:2\n');
    // The command is dead and the pool is as it was: no slot for the next
    // caller to reclaim, and no transient left in the pool.
    expect(fs.existsSync(`${block.dir}/done`)).toBe(false);
    expect(names(pool)).toEqual(['.format']);
    const pid = Number(fs.readFileSync(`${block.dir}/ready`, 'utf8'));
    expect(track(pid)).toBe(pid);
    await waitForDead(pid, 10000);
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
    expect(r.stderr, JSON.stringify(r.stderr)).toBe('');
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
  it('D10 a wedged loop is KILLed on request, is not restarted for it, and the slot decides: the command status stands', async () => {
    const pool = freshPool();
    const wedge = path.join(scratchOf(pool), 'loop-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const trace = path.join(scratchOf(pool), 'trace.log');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_TEST_MODE: '1',
        GATE_LOCK_TEST_LOOP_WEDGE: wedge,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    await up(block);
    // The loop is parked where it reads no stop file - and no in-flight marker, since
    // it is not inside a refresh - so the cleanup's three asks are not enough and the
    // supervisor has to KILL it. Two things follow. Restart-once (D10) is for an
    // unrequested death: a KILL during the cleanup must not start a second loop that
    // would be KILLed again. And the KILL is not evidence about the lock - the loop was
    // wedged, not the lock lost - so the run reads the slot before the release, finds
    // it still its own, and answers the command's own status with a line saying the
    // supervisor was hard stopped. This used to be answered 2 with "lock lost": that
    // was the teardown's own KILL being read as proof, which is what made a run whose
    // command finished perfectly claim it had lost a lock it held and released.
    //
    // The trace is what says which of the two ways to that verdict was taken: the
    // supervisor KILLs a loop that will not stop, and finds one that stopped. Without
    // this assertion the test passes on either, so a change that moved the verdict onto
    // the other path would not be noticed here.
    block.release();
    const r = await gate.done;
    expect(r.status, traceText(trace)).toBe(0);
    expect(r.stderr, traceText(trace)).toContain('stopped the hard way');
    expect(r.stderr, traceText(trace)).not.toContain('lock lost');
    expect(beatPids(r.stdout), 'one loop, not a restart and a second loop').toHaveLength(1);
    expect(names(pool), traceText(trace)).toEqual(['.format']);
    expect(traceText(trace), traceText(trace)).toMatch(
      new RegExp(`KILLs loop ${beatPids(r.stdout)[0]}, no refresh in flight`),
    );
  });

  it('D10 a supervisor waiting on a loop that went quiet stops the command when its run is KILLed', async () => {
    const pool = freshPool();
    const wedge = path.join(scratchOf(pool), 'loop-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const trace = path.join(scratchOf(pool), 'trace.log');
    // Deaf to TERM, so nothing but a KILL ends it: if the supervisor is not watching,
    // nothing ends it at all, and that is the whole point of this test.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_TEST_LOOP_WEDGE: wedge,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    await up(block);
    await until(() => beatPids(out).length > 0, 10000);
    const loop = beatPids(out)[0];
    // Three seconds without a word from the loop is what takes the supervisor out of
    // its watch and onto the wait for a loop that is still live - the shape this test
    // is about. Nothing has asked the supervisor to stop, so it is on the stale path
    // alone, and the wait it used to enter there reads nothing at all: not its stop
    // file, not its run's pid.
    await untilTraced(() => /stops waiting for a quiet loop/.test(traceText(trace)), trace, 20000);
    gate.child.kill('SIGKILL');
    // With the run gone, the supervisor is what stops the command: TERM, the grace,
    // KILL. It can only do that if it is still watching for the run, which is what the
    // KILL before the wait is for.
    await untilGone(block.pid(), 20000);
    expect(stopped(block.pid()), 'the command outlived the run that held its slot').toBe(true);
    await untilGone(loop, 10000);
    expect(stopped(loop), 'the wedged loop outlived the run').toBe(true);
    expect(stopped(gate.child.pid)).toBe(true);
    expect(traceText(trace), traceText(trace)).toMatch(
      new RegExp(`KILLs loop ${loop} rather than waiting for a live one`),
    );
  }, 90_000);

  it('D10 the teardown waits for a supervisor that is about to KILL its own loop', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const trace = path.join(scratchOf(pool), 'trace.log');
    // Deaf to TERM, so the run is still waiting for its command while the supervisor
    // does its own waiting - and a long grace, because that is what makes the two
    // budgets differ: the supervisor waits grace + 13 passes for a refresh it will not
    // cut short, while the teardown's own budget for the same wait used to be a fixed
    // twenty-five seconds. At a grace of sixteen the supervisor is still four passes
    // from KILLing its loop when the teardown gave up on it and KILLed it instead,
    // which leaves that loop behind with a heartbeat child of it under it, still
    // holding its staged beat beside the slot. The wait below is generous because the
    // supervisor's own pace is not ours to fix: a pass of its watch takes a second
    // when the host is idle and several when it is loaded, and what this test is about
    // is who gives up first, not how long either of them takes.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '16',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
      },
    });
    // The refresh is parked at the rename with its in-flight marker published, which
    // is what makes the supervisor wait rather than KILL: a refresh in flight is never
    // cut short (C41, R7).
    await waitForFile(hook.seam);
    gate.child.kill('SIGTERM');
    try {
      // The supervisor ends its loop itself. `run` KILLs a helper only as a last
      // resort, and with both budgets derived from the same grace it never gets there
      // first - so this line is the supervisor's, and it is the only evidence that it
      // was.
      await untilTraced(
        () => /KILLs loop \d+ after \d+ seconds with a refresh in flight/.test(traceText(trace)),
        trace,
        240000,
      );
      const r = await gate.done;
      expect(r.status, traceText(trace)).toBe(143);
      expect(r.stderr, `${JSON.stringify(r.stderr)}\n${traceText(trace)}`).toBe('');
      expect(r.stdout, traceText(trace)).toContain('released by lane');
      // And that the supervisor finished on its own account, which is the thing this
      // test exists to pin: a `run` that had KILLed it would say 137 and none of this.
      // Read after the run has ended, because that is when the last of the supervisor's
      // own lines is in the file.
      expect(traceText(trace), traceText(trace)).toMatch(
        /exits unproven: a stop was requested and the loop ended 137/,
      );
      // The loop was KILLed with a refresh of its own in flight, and the heartbeat
      // under it was KILLed with it - one signal, both pids, because the loop is this
      // supervisor's child and the heartbeat is the loop's. That is what makes this an
      // exact reading rather than a poll, and the seam is still parked throughout: a
      // heartbeat that outlived the loop would still be sitting on its staged beat at
      // this point, for as long as it takes whatever it is waiting for to answer. A
      // KILL runs no trap, so nothing of its own would have taken that file away; the
      // run's sweep does, because the pid is dead by the time it looks - which is the
      // second of the three closes on that window, and the only one left when the loop
      // itself was KILLed.
      expect(names(pool), traceText(trace)).toEqual(['.format']);
    } finally {
      hook.release();
    }
  }, 300_000);

  it('D10 a loop with a heartbeat in flight is ended before the supervisor asks whether its run is gone', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const tmpRoot = scratchOf(pool);
    const trace = path.join(tmpRoot, 'trace.log');
    // Deaf to TERM, so the only thing that can stop the command is the supervisor's
    // orphaned tail - which is exactly the path this test drives.
    const block = blocker(pool, 'deaf', { ignoreTerm: true });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
        GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
      },
    });
    // A live view of the run's stdout, from before anything can be waited for: the
    // heartbeat line is out before the first handshake can be waiting.
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    // The refresh is parked at the rename, so the loop is inside a `wait` on a live
    // heartbeat, and it has published that heartbeat's pid beside itself.
    await waitForFile(hook.seam);
    const dir = path.join(tmpRoot, `gate-lock-run.${gate.child.pid}`);
    await until(() => fs.readFileSync(path.join(dir, 'beat-child'), 'utf8').trim() !== '', 10000);
    const heartbeat = Number(fs.readFileSync(path.join(dir, 'beat-child'), 'utf8').trim());
    expect(heartbeat).toBeGreaterThan(0);
    const loop = beatPids(out)[0] ?? 0;
    expect(loop, traceText(trace)).toBeGreaterThan(0);
    expect(parentOf(loop), 'the loop is the supervisor’s child').toBeGreaterThan(0);
    // The run is KILLed while its supervisor is still watching a loop that is not
    // saying anything - a heartbeat hung on I/O, and a caller that gives up on the
    // run. That is the production shape, and the only one in which the question the
    // supervisor asks on its way out ("is my run still there?") comes back no: the
    // answer it takes then ends in an `exit`, and whatever is still running at that
    // point is what would be left behind.
    gate.child.kill('SIGKILL');
    await untilTraced(() => /stops waiting for a quiet loop/.test(traceText(trace)), trace, 90000);
    // The loop and the heartbeat under it are gone, and the command is stopped by the
    // supervisor's tail - which cannot happen at all unless the loop was ended first.
    await untilGone(heartbeat, 15000);
    await untilGone(loop, 15000);
    expect(stopped(heartbeat), 'a heartbeat outlived the supervisor that owned it').toBe(true);
    expect(stopped(loop), 'a loop outlived the supervisor that owned it').toBe(true);
    await untilGone(block.pid(), 20000);
    expect(stopped(block.pid()), 'the command outlived a run that was KILLed').toBe(true);
    expect(traceText(trace), traceText(trace)).toMatch(/stopping command \d+: run \d+ is gone/);
  }, 150_000);

  it('D10 a loop KILLed with a heartbeat in flight leaves no pid behind for the next loop to signal', async () => {
    const pool = freshPool();
    const hook = beatHook(pool);
    const tmpRoot = scratchOf(pool);
    const trace = path.join(tmpRoot, 'trace.log');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
        GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
      },
    });
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    // The refresh is parked at the rename, so the loop is waiting on a heartbeat of its
    // own and has published that heartbeat's pid beside itself.
    await waitForFile(hook.seam);
    const dir = path.join(tmpRoot, `gate-lock-run.${gate.child.pid}`);
    await until(() => fs.readFileSync(path.join(dir, 'beat-child'), 'utf8').trim() !== '', 10000);
    const heartbeat = Number(fs.readFileSync(path.join(dir, 'beat-child'), 'utf8').trim());
    expect(heartbeat).toBeGreaterThan(0);
    const loop = beatPids(out)[0] ?? 0;
    const supervisor = parentOf(loop);
    // The watch ends with the loop still live, so the supervisor ends it - and this is
    // the moment after the reap, where a pid of a heartbeat that is now dead and
    // reaped must be gone from the file. Restart-once is about to start a new loop, and
    // a new loop's own KILL reads that file: a pid left there is a pid the kernel is
    // free to have given to somebody else.
    await untilTraced(() => /sees loop \d+ status 137/.test(traceText(trace)), trace, 90000);
    const left = fs.existsSync(path.join(dir, 'beat-child'))
      ? fs.readFileSync(path.join(dir, 'beat-child'), 'utf8').trim()
      : '';
    expect(left, 'a heartbeat pid outlived the heartbeat').not.toBe(String(heartbeat));
    await untilGone(heartbeat, 15000);
    expect(stopped(heartbeat), 'the heartbeat under a KILLed loop is still running').toBe(true);
    block.release();
    hook.release();
    const r = await gate.done;
    expect(r.status, traceText(trace)).toBe(0);
    expect(names(pool), traceText(trace)).toEqual(['.format']);
    expect(stopped(supervisor), 'the supervisor outlived its run').toBe(true);
  }, 150_000);

  it('D10 a supervisor that publishes progress and never finishes is given up on: the teardown ends within the cap', async () => {
    const pool = freshPool();
    const tmpRoot = scratchOf(pool);
    const trace = path.join(tmpRoot, 'trace.log');
    const hook = beatHook(pool);
    // A seam that keeps this supervisor counting and never leaving its watch: the shape
    // `run`'s wait cannot tell from progress. A short grace keeps the cap it is held to
    // small enough to wait for - the cap is the grace plus eighteen, so twenty of
    // anything here. The refresh is parked at the rename as well, because an in-flight
    // marker is what keeps this wait on the budget the cap is there for: without it the
    // shorter quiet bound would end the wait first and say nothing about progress.
    const stuck = path.join(tmpRoot, 'sup-progress');
    fs.writeFileSync(stuck, 'counting\n');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: {
        ...TM,
        GATE_LOCK_HEARTBEAT_SECONDS: '1',
        GATE_LOCK_TEST_KILL_GRACE: '2',
        GATE_LOCK_TEST_SUP_PROGRESS: stuck,
        GATE_LOCK_TEST_PAUSE_BEFORE_BEAT_RENAME: hook.seam,
        GATE_LOCK_TEST_TRACE: trace,
        GATE_LOCK_TEST_TMP_ROOT: tmpRoot,
      },
    });
    // A live view of the run's stdout, from before anything can be waited for.
    let out = '';
    gate.child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d;
    });
    await waitForFile(hook.seam);
    // The loop is the supervisor's child and the supervisor is the run's.
    const loop = beatPids(out)[0] ?? 0;
    const supervisor = parentOf(loop);
    expect(parentOf(supervisor), `the supervisor is a child of the run: ${out}`).toBe(
      gate.child.pid,
    );
    block.release();
    try {
      // The run finishes anyway: the command is done, and the supervisor that will not
      // end is ended by the teardown's own cap on how many times it may be given the
      // benefit of the doubt. Without that cap on the resets this wait never ends.
      await untilGone(gate.child.pid, 120000);
      expect(stopped(gate.child.pid), 'the run never finished').toBe(true);
      expect(stopped(supervisor), 'a supervisor that never ends outlived the run').toBe(true);
      // Which bound ended it, in the trace: with the reset cap gone this wait is ended
      // by the seconds instead, and says so.
      expect(traceText(trace), traceText(trace)).toMatch(
        new RegExp(`gives up on the helper ${supervisor}: published \\d+ times without finishing`),
      );
    } finally {
      hook.release();
    }
    // The loop was under that supervisor and is an orphan now; it is waiting on the
    // heartbeat the seam was holding, and both end when the seam goes. The heartbeat
    // removes its staged beat as it wakes, which is a moment before the loop has seen
    // it end - so the loop is waited for rather than assumed.
    await until(() => stagedBeats(pool).length === 0, 20000);
    await untilGone(loop, 20000);
    expect(names(pool), 'the pool holds the marker and nothing else').toEqual(['.format']);
    expect(stopped(loop), 'a loop outlived the supervisor that was KILLed').toBe(true);
  }, 180_000);

  it('D10 a supervisor that will not be stopped at all is KILLed, and the slot decides: the command status stands', async () => {
    const pool = freshPool();
    const wedge = path.join(scratchOf(pool), 'sup-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_TEST_SUP_WEDGE: wedge, GATE_LOCK_HEARTBEAT_SECONDS: '1' },
    });
    await up(block);
    block.release();
    // The supervisor is parked where it hears nothing, so the only way to stop it is
    // the KILL the stop-file protocol falls back to, and its status is 137. A helper
    // stopped the hard way is proof of nothing: the slot is read before the release,
    // and this one is still this run's - owner, pid, worktree - so the run answers
    // the command's own status. It says on stderr that the supervisor was hard
    // stopped, because that is worth an operator knowing.
    const r = await gate.done;
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('stopped the hard way');
    expect(r.stderr).not.toContain('lock lost');
    expect(r.stdout).toContain('released by lane');
    expect(names(pool)).toEqual(['.format']);
    // Nothing of the run's outlives it, and the KILLed supervisor's loop is gone
    // too: a loop that outlived the run would keep refreshing the beat.
    await waitForDead(block.pid(), 5000);
  }, 60_000);

  it('D10 a supervisor KILLed at cleanup whose slot is gone is a lost lock, not a 0', async () => {
    const pool = freshPool();
    const wedge = path.join(scratchOf(pool), 'sup-wedge');
    fs.writeFileSync(wedge, 'wedged\n');
    const slot = path.join(pool, 'gate.lock');
    // The same hard stop, with the other evidence: the command takes its own slot
    // away, so nothing is left to verify. The table's unproven row is settled by the
    // slot rather than by the status, and here the slot is not this run's - so the run
    // is lost, answers 2, and says which of the two it is.
    const block = blocker(pool, 'thief', { pre: 'rm -rf "$2"', args: [slot] });
    const gate = startRun(pool, 'lane', block.cmd, {
      env: { ...TM, GATE_LOCK_TEST_SUP_WEDGE: wedge, GATE_LOCK_HEARTBEAT_SECONDS: '1' },
    });
    await up(block);
    block.release();
    const r = await gate.done;
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('lock lost');
    expect(r.stderr).toContain('no longer this run');
    expect(r.stderr).not.toContain('the lock was lost while the command ran');
    expect(names(pool)).toEqual(['.format']);
  }, 60_000);
});

describe('D21 the file recording the slot path', () => {
  it('the run records its slot path outside the pool and leaves neither there nor beside it', async () => {
    const pool = freshPool();
    const block = blocker(pool);
    const gate = startRun(pool, 'lane', block.cmd);
    await up(block);
    // Nothing of run's own is published in the pool: the slot path was recorded in a
    // private directory, which the acquire wrote through D21's own rules. A staged
    // beat beside the slot is the one name that is not run's - it is a refresh in
    // flight - so it is counted and named rather than listed.
    const held = heldListing(pool);
    expect(held.held, `pool: ${held.listing}`).toEqual(['.format', 'gate.lock']);
    expect(held.staged.length, `staged beats: ${held.listing}`).toBeLessThanOrEqual(1);
    block.release();
    expect((await gate.done).status).toBe(0);
    // The exact listing, `.format` included. A staged beat is the tool's own name
    // pattern beside the slot and would mean a refresh was cut off mid-rename -
    // which the cleanup no longer does, because the loop is asked to stop and
    // waits for its own refresh (C41) instead of being KILLed through it.
    expect(names(pool), `pool: ${names(pool)}`).toEqual(['.format']);
    expect(stagedBeats(pool), 'no staged beat is left in the pool').toEqual([]);
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
