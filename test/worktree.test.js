// GL2b: one gate per worktree (F55-F56, F56a-c, F60, D14's label is in
// hygiene.test.js) - spec section 6.F (T51-T58) and the same-worktree races
// (R5, R11). Every window is parked on a test-mode pause seam.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listing, releaseHook, scratchOf, waitForFile } from './harness.js';
import {
  TM,
  acquire,
  deadPid,
  freshPool,
  livePid,
  names,
  nowS,
  path,
  readSlot,
  seed,
  startAcquire,
  sub,
  wtDir,
} from './slots.js';

const SIX = ['beat', 'owner', 'pid', 'project', 'started', 'worktree'];
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** The worktree identity `acquire` resolves for `cwd`: a plain directory. */
const wt0 = (pool) => wtDir(pool, 'wt0');

describe('T51 a second gate in the same worktree is refused', () => {
  it.skipIf(!HAS_GIT)(
    'T51 a subdirectory of the same git worktree is refused 75 naming same worktree, the holder, its slot and the root (not the subdirectory)',
    () => {
      const pool = freshPool();
      const root = wtDir(pool, 'my-repo');
      expect(spawnSync('git', ['init', '-q', root], { encoding: 'utf8' }).status).toBe(0);
      const deep = path.join(root, 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      const holder = livePid();
      // Slot count 2, so the second acquirer wins a slot and is then refused by
      // the same-worktree rule rather than by an ordinary busy.
      expect(
        acquire(pool, 'holder', holder, { cwd: deep, env: { GATE_LOCK_SLOTS: '2' } }).status,
      ).toBe(0);
      // F28: the identity written by the holder is the repository root.
      expect(readSlot(pool, 'gate.lock')).toMatchObject({ worktree: root, project: 'my-repo' });

      const other = path.join(root, 'c');
      fs.mkdirSync(other, { recursive: true });
      const r = acquire(pool, 'second', livePid(), { cwd: other, env: { GATE_LOCK_SLOTS: '2' } });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('busy');
      expect(r.stderr).toContain('same worktree');
      expect(r.stderr).toContain('holder');
      expect(r.stderr).toContain(String(holder));
      expect(r.stderr).toContain(`${pool}/gate.lock`);
      expect(r.stderr).toContain(root);
      expect(r.stderr).not.toContain(other);
      // The refused acquirer left no slot, and the holder is exactly as found.
      expect(r.stdout).toBe('');
      expect(names(pool)).toEqual(['.format', 'gate.lock']);
      expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
      expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'holder', pid: String(holder) });
    },
  );

  it('T52 two acquires from two different plain directories both succeed and record their own directory', () => {
    const pool = freshPool();
    const a = wtDir(pool, 'dir-a');
    const b = wtDir(pool, 'dir-b');
    const pa = livePid();
    expect(acquire(pool, 'lane-a', pa, { cwd: a, env: { GATE_LOCK_SLOTS: '2' } }).status).toBe(0);
    const pb = livePid();
    const r = acquire(pool, 'lane-b', pb, { cwd: b, env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(0);
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ worktree: a, owner: 'lane-a' });
    expect(readSlot(pool, 'gate.lock.1')).toMatchObject({ worktree: b, owner: 'lane-b' });
  });
});

describe('F56 the scan is over every other slot, in either direction (R11)', () => {
  it('T53 / R11a a live holder in a HIGHER slot blocks: slot 0 is given back, the holder is untouched', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    const holder = livePid();
    seed(pool, 'gate.lock.1', { owner: 'high-holder', pid: holder, worktree: wt, project: 'wt0' });
    const before = listing(pool);
    const r = acquire(pool, 'low', livePid(), { env: { GATE_LOCK_SLOTS: '1' } });
    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('high-holder');
    expect(r.stderr).toContain(String(holder));
    expect(r.stderr).toContain(`${pool}/gate.lock.1`);
    // The slot it won is gone again, and the higher slot is exactly as found.
    expect(names(pool)).toEqual(['.format', 'gate.lock.1']);
    expect(listing(pool)).toEqual(before);
  });

  it('R11b a live holder in a LOWER slot blocks: the slot it won is given back', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock', { owner: 'low-holder', pid: livePid(), worktree: wt, project: 'wt0' });
    const before = listing(pool);
    const r = acquire(pool, 'rival', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('low-holder');
    expect(r.stderr).toContain(`${pool}/gate.lock `);
    // It won slot 1 and gave it back; only the holder's slot is left.
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(listing(pool)).toEqual(before);
  });

  it('F56 the scan reaches slots beyond the configured count', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock.5', {
      owner: 'far-holder',
      pid: livePid(),
      worktree: wt,
      project: 'wt0',
    });
    const r = acquire(pool, 'low', livePid(), { env: { GATE_LOCK_SLOTS: '1' } });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('far-holder');
    expect(r.stderr).toContain(`${pool}/gate.lock.5`);
    expect(names(pool)).toEqual(['.format', 'gate.lock.5']);
  });

  it('R11c a holder that appeared between two acquires blocks the second, in a later slot than the first', () => {
    const pool = freshPool();
    const a = wtDir(pool, 'dir-a');
    const b = wtDir(pool, 'dir-b');
    const env = { GATE_LOCK_SLOTS: '3' };
    expect(acquire(pool, 'first', livePid(), { cwd: a, env }).status).toBe(0);
    expect(acquire(pool, 'other-worktree', livePid(), { cwd: b, env }).status).toBe(0);
    const before = listing(pool);
    // A second gate in the first worktree, with its own pid, wins the free slot
    // 2 and is refused there, naming the holder that appeared after the first
    // acquire - which is in a lower-numbered slot, so the scan had to look down.
    const r = acquire(pool, 'second-gate', livePid(), { cwd: a, env });
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('first');
    expect(r.stderr).toContain(a);
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    expect(listing(pool)).toEqual(before);
  });

  it('F56c two same-worktree acquirers that both won a slot both yield: 75 each, neither runs', async () => {
    const pool = freshPool();
    const scan = path.join(scratchOf(pool), 'hook-scan');
    const back = path.join(scratchOf(pool), 'hook-back');
    const env = { ...TM, GATE_LOCK_SLOTS: '2' };
    const hooks = (who) => ({
      ...env,
      GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_SCAN: `${scan}.${who}`,
      GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_GIVE_BACK: `${back}.${who}`,
    });
    // Each acquirer parks after winning its own slot, then again between its
    // scan (which finds the rival) and the give-back, on its own two hook
    // files: both scans therefore read a held rival before either removal, so
    // the double yield is the test's interleaving, not a timing accident.
    const a = startAcquire(pool, 'lane-a', livePid(), { env: hooks('a') });
    await waitForFile(`${scan}.a`);
    const b = startAcquire(pool, 'lane-b', livePid(), { env: hooks('b') });
    await waitForFile(`${scan}.b`);
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane-a');
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('lane-b');
    releaseHook(`${scan}.a`);
    await waitForFile(`${back}.a`);
    releaseHook(`${scan}.b`);
    await waitForFile(`${back}.b`);
    // Both have scanned and both still hold their slot: neither has run.
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane-a');
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('lane-b');
    releaseHook(`${back}.a`);
    releaseHook(`${back}.b`);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    for (const r of [ra, rb]) {
      expect(r.status).toBe(75);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('same worktree');
    }
    expect(ra.stderr).toContain('lane-b');
    expect(rb.stderr).toContain('lane-a');
    expect(names(pool)).toEqual(['.format']);
  });

  it('F56c two acquirers parked before their scan never both run', async () => {
    const pool = freshPool();
    const scan = path.join(scratchOf(pool), 'hook-scan');
    const env = { ...TM, GATE_LOCK_SLOTS: '2' };
    // Each acquirer parks after winning its own slot, before its scan, on its
    // own hook file. Whichever yields first gives its slot back, so the other
    // may then find no rival and run: the guarantee is that they never both
    // run, not that both yield.
    const a = startAcquire(pool, 'lane-a', livePid(), {
      env: { ...env, GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_SCAN: `${scan}.a` },
    });
    await waitForFile(`${scan}.a`);
    const b = startAcquire(pool, 'lane-b', livePid(), {
      env: { ...env, GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_SCAN: `${scan}.b` },
    });
    await waitForFile(`${scan}.b`);
    expect(readSlot(pool, 'gate.lock').owner).toBe('lane-a');
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('lane-b');
    releaseHook(`${scan}.a`);
    releaseHook(`${scan}.b`);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    const ran = [ra, rb].filter((r) => r.status === 0);
    const yielded = [ra, rb].filter((r) => r.status === 75);
    expect(ran.length).toBeLessThanOrEqual(1);
    expect(yielded.length).toBeGreaterThanOrEqual(1);
    for (const r of yielded) expect(r.stderr).toContain('same worktree');
    for (const r of ran) expect(r.stdout).toContain('acquired by');
    expect(names(pool).filter((n) => n !== '.format')).toHaveLength(ran.length);
  });
});

describe('F56a the same-worktree scan applies the liveness rule and nothing stricter', () => {
  it('T54 a dead or a stale same-worktree holder in the slot the loop reclaims does not block', () => {
    const dead = freshPool();
    const wtDead = wt0(dead);
    seed(dead, 'gate.lock', {
      owner: 'corpse',
      pid: deadPid(),
      worktree: wtDead,
      project: 'wt0',
    });
    const rd = acquire(dead, 'live', livePid());
    expect(rd.status).toBe(0);
    expect(rd.stdout).toContain('reclaiming');
    expect(readSlot(dead, 'gate.lock')).toMatchObject({ owner: 'live', worktree: wtDead });

    const stale = freshPool();
    const wtStale = wt0(stale);
    const now = nowS();
    seed(stale, 'gate.lock', {
      owner: 'silent',
      pid: livePid(),
      beat: now - 700,
      started: now - 700,
      worktree: wtStale,
      project: 'wt0',
    });
    const rs = acquire(stale, 'live', livePid());
    expect(rs.status).toBe(0);
    expect(rs.stdout).toContain('stale');
    expect(readSlot(stale, 'gate.lock')).toMatchObject({ owner: 'live', worktree: wtStale });
  });

  it('T55 the same corpse in another slot the loop never visits does not block, and is not reclaimed', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock.1', { owner: 'corpse', pid: deadPid(), worktree: wt, project: 'wt0' });
    const corpse = listing(path.join(pool, 'gate.lock.1'));
    const r = acquire(pool, 'live', livePid());
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('reclaiming');
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'live', worktree: wt });
    // The corpse is still there, untouched, and no aside was left behind.
    expect(listing(path.join(pool, 'gate.lock.1'))).toEqual(corpse);
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
  });

  it('F56a a live pid with a stale beat does not block either', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    const now = nowS();
    seed(pool, 'gate.lock.1', {
      owner: 'silent',
      pid: livePid(),
      beat: now - 700,
      started: now - 700,
      worktree: wt,
      project: 'wt0',
    });
    const r = acquire(pool, 'live', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(0);
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'live' });
    expect(readSlot(pool, 'gate.lock.1').owner).toBe('silent');
  });

  it('F40 / F56a a dead pid with a fresh beat does not block either', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    // The loop never visits slot 1, so the corpse is never reclaimed: only the
    // liveness rule in the scan keeps it from blocking.
    seed(pool, 'gate.lock.1', {
      owner: 'fresh-corpse',
      pid: deadPid(),
      worktree: wt,
      project: 'wt0',
    });
    const before = listing(path.join(pool, 'gate.lock.1'));
    const r = acquire(pool, 'live', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'live' });
    expect(listing(path.join(pool, 'gate.lock.1'))).toEqual(before);
  });

  it('F56a a rival that turned over between the reads is not read as one (a confirmed snapshot)', async () => {
    const pool = freshPool();
    const wt = wt0(pool);
    // A live, fresh holder in our worktree: exactly what the scan must catch.
    seed(pool, 'gate.lock.1', { owner: 'rival', pid: livePid(), worktree: wt, project: 'wt0' });
    const hook = path.join(scratchOf(pool), 'hook-confirm');
    const { done } = startAcquire(pool, 'mine', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_SLOTS: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_CONFIRM: hook,
      },
    });
    await waitForFile(hook);
    // The scan has read slot 1's worktree and parked before it confirms. The
    // holder releases and another worktree takes the name in that window.
    const replacementPid = livePid();
    fs.rmSync(path.join(pool, 'gate.lock.1'), { recursive: true });
    seed(pool, 'gate.lock.1', {
      owner: 'other-worktree',
      pid: replacementPid,
      worktree: wtDir(pool, 'elsewhere'),
      project: 'elsewhere',
    });
    const replacement = readSlot(pool, 'gate.lock.1');
    releaseHook(hook);
    const r = await done;
    // The rival is gone: the caller is not blocked by a half-read slot, and the
    // slot it won is not given back.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by mine');
    expect(r.stderr).toBe('');
    expect(readSlot(pool, 'gate.lock.1')).toEqual(replacement);
    expect(names(pool).sort()).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
  });

  it('F56a a rival that stayed is still caught after the confirming read', async () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock.1', { owner: 'rival', pid: livePid(), worktree: wt, project: 'wt0' });
    const hook = path.join(scratchOf(pool), 'hook-confirm');
    const { done } = startAcquire(pool, 'mine', livePid(), {
      env: {
        ...TM,
        GATE_LOCK_SLOTS: '2',
        GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_CONFIRM: hook,
      },
    });
    await waitForFile(hook);
    const rival = readSlot(pool, 'gate.lock.1');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('rival');
    expect(readSlot(pool, 'gate.lock.1')).toEqual(rival);
    expect(names(pool)).toEqual(['.format', 'gate.lock.1']);
  });

  it('T57 a holder with no worktree file (four files) never blocks', () => {
    const pool = freshPool();
    const now = nowS();
    seed(pool, 'gate.lock', { owner: 'four-file', beat: now, started: now }, { files: 4 });
    expect(names(path.join(pool, 'gate.lock'))).toEqual(['beat', 'owner', 'pid', 'started']);
    const r = acquire(pool, 'live', livePid(), { env: { GATE_LOCK_SLOTS: '2' } });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(readSlot(pool, 'gate.lock.1')).toMatchObject({ owner: 'live' });
    expect(names(path.join(pool, 'gate.lock'))).toEqual(['beat', 'owner', 'pid', 'started']);
  });
});

describe('R5 / T56 the give-back is conditional (F60)', () => {
  it('T56 a contender that took the won name in the give-back window keeps its slot; the refusal is unchanged', async () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock.1', {
      owner: 'high-holder',
      pid: livePid(),
      worktree: wt,
      project: 'wt0',
    });
    const holderBefore = readSlot(pool, 'gate.lock.1');
    const hook = path.join(scratchOf(pool), 'hook-give-back');
    const { done } = startAcquire(pool, 'low', livePid(), {
      env: { ...TM, GATE_LOCK_TEST_PAUSE_BEFORE_SAME_WORKTREE_GIVE_BACK: hook },
    });
    await waitForFile(hook);
    // Parked with the slot won: the scan has found the rival, nothing is printed.
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    expect(readSlot(pool, 'gate.lock').owner).toBe('low');
    // A contender judges the (dead, giving-back) acquirer's slot reclaimable and takes the name.
    const taker = livePid();
    fs.rmSync(path.join(pool, 'gate.lock'), { recursive: true });
    seed(pool, 'gate.lock', { owner: 'contender', pid: taker, worktree: wt, project: 'wt0' });
    const contender = readSlot(pool, 'gate.lock');
    releaseHook(hook);
    const r = await done;
    // The refusal answer the caller gets is unchanged (R5).
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('same worktree');
    expect(r.stderr).toContain('high-holder');
    expect(readSlot(pool, 'gate.lock')).toEqual(contender);
    expect(readSlot(pool, 'gate.lock.1')).toEqual(holderBefore);
    // Nothing was deleted, and no aside was leaked by the aborted give-back.
    expect(names(pool)).toEqual(['.format', 'gate.lock', 'gate.lock.1']);
    expect(names(path.join(pool, 'gate.lock'))).toEqual(SIX);
  });
});

describe('F56b a same-worktree refusal writes no output file and takes nothing', () => {
  it('T58 the refused caller leaves no slot and no slot path; a control run without a rival does write it', () => {
    const pool = freshPool();
    const wt = wt0(pool);
    seed(pool, 'gate.lock', { owner: 'holder', pid: livePid(), worktree: wt, project: 'wt0' });
    const refusedOut = path.join(scratchOf(pool), 'refused-slot');
    const r = sub(pool, ['acquire', 'rival'], livePid(), {
      env: { GATE_LOCK_SLOTS: '2', GATE_LOCK_SLOT_OUT: refusedOut },
    });
    expect(r.status).toBe(75);
    expect(fs.existsSync(refusedOut)).toBe(false);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    expect(readSlot(pool, 'gate.lock').owner).toBe('holder');

    // The control: the same call on a host with no same-worktree holder does
    // write the slot path (C9, D21), so the check above is not vacuous.
    const controlPool = freshPool();
    const controlOut = path.join(scratchOf(controlPool), 'control-slot');
    const c = sub(controlPool, ['acquire', 'rival'], livePid(), {
      env: { GATE_LOCK_SLOT_OUT: controlOut },
    });
    expect(c.status).toBe(0);
    expect(fs.readFileSync(controlOut, 'utf8')).toBe(`${controlPool}/gate.lock\n`);
  });
});

describe('T64 an inherited pin does not divert an acquire (F62, F66)', () => {
  // T64's other half - the wrapped command seeing no pin at all - is about
  // `run`, which is GL3's. What is provable here is that the acquire itself
  // ignores the claim and takes the free slot 0, and that the slot is released.
  it('T64 (the acquire half) acquire takes slot 0 though the inherited pin names slot 1, and the slot is released', () => {
    const pool = freshPool();
    const env = { GATE_LOCK_SLOTS: '2', GATE_LOCK_SLOT_PATH: `${pool}/gate.lock.1` };
    const pid = livePid();
    const r = acquire(pool, 'lane', pid, { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`acquired by lane pid ${pid}`);
    expect(r.stdout).toContain(`${pool}/gate.lock\n`);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
    // The pin is only read by the subcommands that act on a slot, and it names a
    // slot that does not exist, so the release is made by the caller, which
    // knows what it took.
    const rel = sub(pool, ['release', 'lane'], pid);
    expect(rel.status).toBe(0);
    expect(names(pool)).toEqual(['.format']);
  });
});
