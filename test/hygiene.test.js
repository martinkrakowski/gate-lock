// GL2b: hygiene - the janitor (D16, the `clean` subcommand), the lane label
// (D14) and the H7 release pause. Nothing here is proved by timing: ages are
// set with utimes and every window is parked on a test-mode pause seam.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  listing,
  releaseHook,
  scratchOf,
  setAge,
  startBin,
  waitForFile,
  writeSlot,
  writeTransient,
} from './harness.js';
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

/** `clean` against `pool`, with `extra` environment. */
const clean = (pool, extra = {}) => sub(pool, ['clean'], undefined, { env: extra });

/** An old (700s) transient of a process that is really dead. */
function deadTransient(pool, name, age = 700) {
  const p = name.includes('.reclaim.')
    ? writeSlot(pool, name, {
        owner: 'aside',
        pid: deadPid(),
        beat: nowS(),
        worktree: '/x',
        project: 'x',
      })
    : writeTransient(pool, name.replace('<pid>', String(deadPid())));
  if (age !== null) setAge(p, age);
  return p;
}

describe('D16 the janitor pass', () => {
  it('clean on a pool with nothing to remove exits 0 and says nothing', () => {
    const pool = freshPool();
    const before = listing(pool);
    expect(clean(pool)).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(listing(pool)).toEqual(before);
  });

  it('D16 an old transient of a dead process is removed, one line per removal', () => {
    const pool = freshPool();
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>');
    const beat = deadTransient(pool, 'gate.lock.1.beatnew.<pid>');
    const mark = deadTransient(pool, '.format.tmp.<pid>');
    const r = clean(pool);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    // One line per removal, whatever order the pass walks the pool in.
    expect(lines.sort()).toEqual(
      [cand, beat, mark].map((n) => `gate-lock: janitor: removed ${path.basename(n)}`).sort(),
    );
    expect(names(pool)).toEqual(['.format']);
  });

  it('D16 the age boundary is the stale threshold itself', () => {
    const now = nowS();
    // The clock is pinned two hours back, so the reference file's mtime is
    // exactly `now - 7800` and the two candidates' mtimes are set to exactly
    // that and to one second later: whatever the real clock does meanwhile,
    // the first is at the stale threshold and the second is not yet (F35).
    const env = { ...TM, GATE_LOCK_TEST_NOW: String(now - 7200) };
    const old = freshPool();
    const young = freshPool();
    const at = deadTransient(old, 'gate.lock.cand.<pid>', null);
    fs.utimesSync(at, new Date((now - 7800) * 1000), new Date((now - 7800) * 1000));
    const notYet = deadTransient(young, 'gate.lock.cand.<pid>', null);
    fs.utimesSync(notYet, new Date((now - 7799) * 1000), new Date((now - 7799) * 1000));
    expect(clean(old, env).stdout).toBe(`gate-lock: janitor: removed ${path.basename(at)}\n`);
    expect(clean(young, env)).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(notYet)).toBe(true);
  });

  it('D16 a transient of a live process is never removed, however old', () => {
    const pool = freshPool();
    const cand = writeTransient(pool, `gate.lock.cand.${livePid()}`);
    const beat = writeTransient(pool, `gate.lock.beatnew.${livePid()}`);
    setAge(cand, 86400);
    setAge(beat, 86400);
    const r = clean(pool);
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(names(pool).sort()).toEqual(
      ['.format', path.basename(beat), path.basename(cand)].sort(),
    );
  });

  it('D16 a reclaim aside needs F40 to call what it holds not alive as well', () => {
    // Held by a live pid with a fresh beat: the aside stays.
    const alive = freshPool();
    const liveName = `gate.lock.reclaim.${deadPid()}.1`;
    writeSlot(alive, liveName, {
      owner: 'gone',
      pid: livePid(),
      beat: nowS(),
      started: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(alive, liveName), 3600);
    expect(clean(alive)).toMatchObject({ status: 0, stdout: '' });
    expect(names(alive)).toContain(liveName);

    // Held by a dead pid: gone.
    const corpse = freshPool();
    const corpseName = `gate.lock.reclaim.${deadPid()}.1`;
    writeSlot(corpse, corpseName, {
      owner: 'gone',
      pid: deadPid(),
      beat: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(corpse, corpseName), 3600);
    expect(clean(corpse).stdout).toBe(`gate-lock: janitor: removed ${corpseName}\n`);
    expect(names(corpse)).toEqual(['.format']);

    // Held by a live pid whose beat is stale: gone.
    const silent = freshPool();
    const silentName = `gate.lock.reclaim.${deadPid()}.1`;
    writeSlot(silent, silentName, {
      owner: 'gone',
      pid: livePid(),
      beat: nowS() - 700,
      started: nowS() - 700,
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(silent, silentName), 3600);
    expect(clean(silent).stdout).toBe(`gate-lock: janitor: removed ${silentName}\n`);
    expect(names(silent)).toEqual(['.format']);
  });

  it('D16 an aside whose reclaimer is still alive is not removed even when what it holds is dead', () => {
    const pool = freshPool();
    const name = `gate.lock.reclaim.${livePid()}.1`;
    writeSlot(pool, name, {
      owner: 'gone',
      pid: deadPid(),
      beat: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(pool, name), 3600);
    expect(clean(pool)).toMatchObject({ status: 0, stdout: '' });
    expect(names(pool)).toEqual(['.format', name]);
  });

  it('D16 nothing that is not a transient of a canonical slot is removed', () => {
    const pool = freshPool();
    const dead = deadPid();
    // A held slot with a dead holder: not a transient, never removed.
    seed(pool, 'gate.lock', { owner: 'corpse', pid: dead });
    // Transients of a non-canonical slot name (F19, F21).
    writeTransient(pool, `gate.lock.007.cand.${dead}`);
    writeTransient(pool, `gate.lock.64.reclaim.${dead}.1`);
    // Names that only look like transients.
    fs.mkdirSync(path.join(pool, 'gate.lock.cand'), { mode: 0o700 });
    writeTransient(pool, `gate.lock.cand.x${dead}`);
    fs.mkdirSync(path.join(pool, `gate.lock.cand.0`), { mode: 0o700 });
    fs.mkdirSync(path.join(pool, `gate.lock.reclaim.${dead}`), { mode: 0o700 });
    // Something that is not a lock at all.
    fs.writeFileSync(path.join(pool, 'notes'), 'hello\n');
    fs.mkdirSync(path.join(pool, 'subdir'), { mode: 0o700 });
    for (const n of names(pool)) setAge(path.join(pool, n), 3600);
    const before = listing(pool);
    const r = clean(pool);
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(listing(pool)).toEqual(before);
    expect(readSlot(pool, 'gate.lock').owner).toBe('corpse');
  });

  it('D16 a transient that is a symlink is never deleted through', () => {
    const pool = freshPool();
    const victim = path.join(scratchOf(pool), 'victim');
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(path.join(victim, 'precious'), 'do not delete\n');
    const victimFile = path.join(scratchOf(pool), 'precious-file');
    fs.writeFileSync(victimFile, 'do not delete\n');
    const old = new Date(Date.now() - 86400_000);
    const links = [
      path.join(pool, `gate.lock.cand.${deadPid()}`),
      path.join(pool, `gate.lock.reclaim.${deadPid()}.1`),
    ];
    for (const link of links) {
      fs.symlinkSync(victim, link);
      fs.lutimesSync(link, old, old);
    }
    // The staged-file families are judged the same way.
    const beat = path.join(pool, `gate.lock.beatnew.${deadPid()}`);
    fs.symlinkSync(victimFile, beat);
    fs.lutimesSync(beat, old, old);
    const mark = path.join(pool, `.format.tmp.${deadPid()}`);
    fs.symlinkSync(victimFile, mark);
    fs.lutimesSync(mark, old, old);
    const r = clean(pool);
    expect(r).toMatchObject({ status: 0, stdout: '' });
    for (const link of [...links, beat, mark])
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(names(victim)).toEqual(['precious']);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('do not delete\n');
  });

  it('D16 a transient that is not ours is not removed (slot-uid seam)', () => {
    const pool = freshPool();
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>');
    const beat = deadTransient(pool, 'gate.lock.beatnew.<pid>');
    const r = clean(pool, { ...TM, GATE_LOCK_TEST_SLOT_UID: '65534' });
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(cand)).toBe(true);
    expect(fs.existsSync(beat)).toBe(true);
    // Without the seam the same transients are removed, so the check is not a
    // filter that hides everything.
    expect(clean(pool).stdout.split('\n').filter(Boolean).sort()).toEqual(
      [cand, beat].map((n) => `gate-lock: janitor: removed ${path.basename(n)}`).sort(),
    );
    expect(names(pool)).toEqual(['.format']);
  });

  it('D16 an aside whose holder is replaced while it is being read survives', async () => {
    const pool = freshPool();
    const name = `gate.lock.reclaim.${deadPid()}.1`;
    // Judged not alive at first read: the holder is a corpse.
    writeSlot(pool, name, {
      owner: 'gone',
      pid: deadPid(),
      beat: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(pool, name), 3600);
    const hook = path.join(scratchOf(pool), 'hook-contents');
    const { done } = startBin(['clean'], {
      env: {
        GATE_LOCK_DIR: pool,
        ...TM,
        GATE_LOCK_TEST_PAUSE_AFTER_JANITOR_CONTENTS: hook,
      },
    });
    await waitForFile(hook);
    // While the janitor is deciding on the corpse, the holder at the aside name
    // is replaced by a live, fresh one (a reclaimer restoring a slot, say).
    fs.rmSync(path.join(pool, name), { recursive: true });
    writeSlot(pool, name, {
      owner: 'live',
      pid: livePid(),
      beat: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(pool, name), 3600);
    const holder = readSlot(pool, name);
    // Later entries park at the same seam; let them through.
    const timer = setInterval(() => releaseHook(hook), 50);
    const r = await done;
    clearInterval(timer);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Judged on the generation it read, twice: nothing was removed.
    expect(readSlot(pool, name)).toEqual(holder);
  });

  it('D16 an aside replaced by a symlink while it is being read is not deleted through', async () => {
    const pool = freshPool();
    const name = `gate.lock.reclaim.${deadPid()}.1`;
    writeSlot(pool, name, {
      owner: 'gone',
      pid: deadPid(),
      beat: nowS(),
      worktree: '/x',
      project: 'x',
    });
    setAge(path.join(pool, name), 3600);
    const victim = path.join(scratchOf(pool), 'victim');
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(path.join(victim, 'precious'), 'do not delete\n');
    const hook = path.join(scratchOf(pool), 'hook-contents');
    const { done } = startBin(['clean'], {
      env: {
        GATE_LOCK_DIR: pool,
        ...TM,
        GATE_LOCK_TEST_PAUSE_BEFORE_JANITOR_REMOVE: hook,
      },
    });
    await waitForFile(hook);
    // The name becomes a link to a directory of ours while the janitor is
    // deciding: the provenance judged at the start of the entry no longer holds.
    fs.rmSync(path.join(pool, name), { recursive: true });
    fs.symlinkSync(victim, path.join(pool, name));
    setAge(victim, 3600);
    const timer = setInterval(() => releaseHook(hook), 50);
    const r = await done;
    clearInterval(timer);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.lstatSync(path.join(pool, name)).isSymbolicLink()).toBe(true);
    expect(names(victim)).toEqual(['precious']);
  });

  it('D16 an unusable TMPDIR falls back to the temp root, so the pass still runs', () => {
    const pool = freshPool();
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>');
    // TMPDIR names a regular file, so it cannot hold the age reference: the
    // pass falls back to the temp root instead of giving up (the pool resolver
    // makes the same move).
    const notADir = path.join(scratchOf(pool), 'not-a-dir');
    fs.writeFileSync(notADir, 'x\n');
    const r = clean(pool, { TMPDIR: notADir, ...TM });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`gate-lock: janitor: removed ${path.basename(cand)}\n`);
    expect(fs.existsSync(cand)).toBe(false);
  });

  it('D16 a TMPDIR that is neither ours nor sticky is not trusted, and a trusted one is', () => {
    const untrusted = freshPool();
    const untrustedCand = deadTransient(untrusted, 'gate.lock.cand.<pid>');
    const trusted = freshPool();
    const trustedCand = deadTransient(trusted, 'gate.lock.cand.<pid>');
    // A temp directory nobody can write in: the reference cannot be created
    // there, so a pass that used it would remove nothing at all.
    const readOnly = path.join(scratchOf(trusted), 'ro-tmp');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    const fallback = path.join(scratchOf(trusted), 'fallback');
    fs.mkdirSync(fallback, { mode: 0o700 });

    // Trusted (ours): used as it is, the reference cannot be made, nothing goes.
    expect(
      clean(trusted, {
        TMPDIR: readOnly,
        GATE_LOCK_TEST_TMP_ROOT: fallback,
        ...TM,
      }),
    ).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(trustedCand)).toBe(true);

    // Not ours (the seam) and not sticky: not trusted, so the pass falls back
    // to the temp root, where the reference can be made, and removes it. The
    // directory it was pointed at cannot hold a reference either, so this
    // cannot pass by having used it.
    const loose = path.join(scratchOf(untrusted), 'loose');
    fs.mkdirSync(loose, { mode: 0o500 });
    const otherRoot = path.join(scratchOf(untrusted), 'fallback');
    fs.mkdirSync(otherRoot, { mode: 0o700 });
    const r = clean(untrusted, {
      TMPDIR: loose,
      GATE_LOCK_TEST_TMP_ROOT: otherRoot,
      ...TM,
      GATE_LOCK_TEST_TMP_UID: '65534',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`gate-lock: janitor: removed ${path.basename(untrustedCand)}\n`);
    fs.chmodSync(readOnly, 0o700);
    fs.chmodSync(loose, 0o700);
  });

  it('D16 a reference that is replaced before it is trusted removes nothing', async () => {
    const pool = freshPool();
    // Young: not a threshold old, so only a reference that lies about the age
    // could take it.
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>', 100);
    const tmp = path.join(scratchOf(pool), 'tmp');
    fs.mkdirSync(tmp, { mode: 0o700 });
    const hook = path.join(scratchOf(pool), 'hook-ref');
    const victim = path.join(scratchOf(pool), 'old-file');
    fs.writeFileSync(victim, 'x\n');
    const old = new Date(Date.now() - 86400_000);
    fs.utimesSync(victim, old, old);
    for (const [title, replace, leftBehind] of [
      [
        'a symlink',
        (ref) => {
          fs.rmSync(ref, { force: true });
          fs.symlinkSync(victim, ref);
        },
        false,
      ],
      [
        'a directory',
        (ref) => {
          fs.rmSync(ref, { force: true });
          fs.mkdirSync(ref, { mode: 0o700 });
        },
        // rm -f never removes a directory, so the plant is left where it is.
        true,
      ],
    ]) {
      // The creator is parked between creating and trusting its reference: the
      // window a replaced reference would come through.
      const { child, done } = startBin(['clean'], {
        env: {
          GATE_LOCK_DIR: pool,
          TMPDIR: tmp,
          ...TM,
          GATE_LOCK_TEST_PAUSE_AFTER_JANITOR_REF: hook,
        },
      });
      await waitForFile(hook);
      const ref = path.join(tmp, `.gate-lock-janitor.${child.pid}`);
      expect(fs.existsSync(ref)).toBe(true);
      replace(ref);
      releaseHook(hook);
      const r = await done;
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout, title).toBe('');
      // The young transient is untouched, and the reference we did not create
      // is gone when it is our own link, left alone when it is a directory.
      expect(fs.existsSync(cand), title).toBe(true);
      expect(fs.existsSync(ref), title).toBe(leftBehind);
    }
  });

  it('D16 a candidate that vanishes mid-creation is retried, not reported as an unwritable pool', async () => {
    const pool = freshPool();
    const hook = path.join(scratchOf(pool), 'hook-cand');
    const pid = livePid();
    const { child, done } = startAcquire(pool, 'lane', pid, {
      env: {
        ...TM,
        GATE_LOCK_SLOTS: '1',
        GATE_LOCK_TEST_PAUSE_AFTER_CANDIDATE_MKDIR: hook,
      },
    });
    await waitForFile(hook);
    // The pid-recycle race the janitor note describes: another process judged
    // this candidate's pid dead (a pid that was not yet this one) and removed
    // it. The pool is perfectly writable.
    const cand = path.join(pool, `gate.lock.cand.${child.pid}`);
    expect(fs.existsSync(cand)).toBe(true);
    fs.rmSync(cand, { recursive: true });
    // Later passes park at the same seam; let them through.
    const timer = setInterval(() => releaseHook(hook), 50);
    const r = await done;
    clearInterval(timer);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('acquired by lane');
    expect(readSlot(pool, 'gate.lock')).toMatchObject({ owner: 'lane', pid: String(pid) });
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('D16 the pass runs at the start of acquire and never on status', () => {
    const pool = freshPool();
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>');
    // status is read-only (C27): the transient is untouched and unlisted.
    const st = sub(pool, ['status']);
    expect(st.status).toBe(0);
    expect(st.stdout).toBe(
      `free: ${pool}/gate.lock is not held\nslots: 0/1 live, 0 stale, pool ${pool}, format 1\n`,
    );
    expect(fs.existsSync(cand)).toBe(true);
    // The next acquire runs the pass before it takes a slot.
    const pid = livePid();
    const r = acquire(pool, 'lane', pid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      `gate-lock: janitor: removed ${path.basename(cand)}\ngate-lock: acquired by lane pid ${pid} at ${pool}/gate.lock\n`,
    );
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });

  it('D16 when no age reference can be made at all, nothing is removed', () => {
    const pool = freshPool();
    const cand = deadTransient(pool, 'gate.lock.cand.<pid>');
    // Neither the temp directory nor the fallback root can hold the reference:
    // without an age to compare, the pass removes nothing at all, which is the
    // safe answer.
    const readOnly = path.join(scratchOf(pool), 'ro');
    const alsoReadOnly = path.join(scratchOf(pool), 'ro-root');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    fs.mkdirSync(alsoReadOnly, { mode: 0o500 });
    const r = clean(pool, {
      TMPDIR: readOnly,
      GATE_LOCK_TEST_TMP_ROOT: alsoReadOnly,
      ...TM,
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(fs.existsSync(cand)).toBe(true);
    fs.chmodSync(readOnly, 0o700);
    fs.chmodSync(alsoReadOnly, 0o700);
  });

  it('clean takes no arguments', () => {
    const pool = freshPool();
    const r = sub(pool, ['clean', 'extra']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^gate-lock: [^\n]+\nusage: gate-lock /);
  });
});

describe('D14 the lane label', () => {
  it('a printable ASCII label of at most 128 bytes is accepted', () => {
    const pool = freshPool();
    const lane = 'lane with spaces & punctuation! #$%*+-=/\\"\'`~^';
    expect(acquire(pool, lane, livePid(), { cwd: wtDir(pool, 'wt-a') }).status).toBe(0);
    expect(readSlot(pool, 'gate.lock').owner).toBe(lane);
    const exact = 'x'.repeat(128);
    expect(
      acquire(pool, exact, livePid(), { env: { GATE_LOCK_SLOTS: '2' }, cwd: wtDir(pool, 'wt-b') })
        .status,
    ).toBe(0);
    expect(readSlot(pool, 'gate.lock.1').owner).toBe(exact);
  });

  it('D14 a label of 129 bytes is refused and nothing is taken', () => {
    const pool = freshPool();
    const r = acquire(pool, 'y'.repeat(129), livePid());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('at most 128 bytes');
    expect(r.stderr).toContain('129');
    expect(names(pool)).toEqual(['.format']);
  });

  it.each([
    ['a newline', 'lane\nsecond'],
    ['a tab', 'lane\tsecond'],
    ['a carriage return', 'lane\rsecond'],
    ['an escape byte', 'lane\u001bsecond'],
    ['a non-ASCII letter', 'lané'],
    ['a lone high byte', 'lane\u0080'],
  ])('D14 a label with %s is refused', (_title, lane) => {
    const pool = freshPool();
    const r = acquire(pool, lane, livePid());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('printable ASCII');
    // The message is one line, whatever the label contained.
    expect(r.stderr).toMatch(/^gate-lock: [^\n]*\n$/);
    expect(names(pool)).toEqual(['.format']);
  });

  it('D14 a refused label reclaims nothing and is reported before the caller-pid refusal', () => {
    const pool = freshPool();
    // A slot the loop would reclaim: a label refusal happens before the loop.
    seed(pool, 'gate.lock', { owner: 'corpse', pid: deadPid() });
    const r = acquire(pool, 'bad\nlabel', livePid());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('printable ASCII');
    expect(r.stdout).toBe('');
    expect(readSlot(pool, 'gate.lock').owner).toBe('corpse');
    // The label is an argument check, so it is reported before the missing
    // caller pid as well (C1's spirit: the configuration and the invocation).
    const noPid = sub(pool, ['acquire', 'bad\nlabel']);
    expect(noPid.status).toBe(2);
    expect(noPid.stderr).toContain('printable ASCII');
  });
});

describe('H7 before-release', () => {
  it('H7 a release parks after the owner/pid check with the slot renamed aside, and finishes on resume', async () => {
    const pool = freshPool();
    const pid = livePid();
    const wt = wtDir(pool);
    expect(acquire(pool, 'lane', pid, { cwd: wt }).status).toBe(0);
    const hook = path.join(scratchOf(pool), 'hook-release');
    const { child, done } = startBin(['release', 'lane'], {
      env: {
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(pid),
        ...TM,
        GATE_LOCK_TEST_PAUSE_BEFORE_RELEASE: hook,
      },
      cwd: wt,
    });
    await waitForFile(hook);
    // D12: the slot was renamed aside and is verified, not removed yet.
    expect(names(pool)).toEqual(['.format', `gate.lock.reclaim.${child.pid}.rel`]);
    expect(readSlot(pool, `gate.lock.reclaim.${child.pid}.rel`).owner).toBe('lane');
    releaseHook(hook);
    const r = await done;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`gate-lock: released by lane (${pool}/gate.lock)\n`);
    expect(names(pool)).toEqual(['.format']);
  });

  it('H7 a refused release never parks', async () => {
    const pool = freshPool();
    const wt = wtDir(pool);
    expect(acquire(pool, 'lane', livePid(), { cwd: wt }).status).toBe(0);
    const hook = path.join(scratchOf(pool), 'hook-release');
    // Pinned to the holder's slot with a stranger's pid: refused (C15), and
    // the pause is after the owner/pid check, so it is never reached.
    const { done } = startBin(['release', 'lane'], {
      env: {
        GATE_LOCK_DIR: pool,
        GATE_LOCK_CALLER_PID: String(livePid()),
        GATE_LOCK_SLOT_PATH: `${pool}/gate.lock`,
        ...TM,
        GATE_LOCK_TEST_PAUSE_BEFORE_RELEASE: hook,
      },
      cwd: wt,
    });
    const r = await done;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('release refused');
    // The pause is after the check, so a refused release never reaches it.
    expect(fs.existsSync(hook)).toBe(false);
    expect(names(pool)).toEqual(['.format', 'gate.lock']);
  });
});
