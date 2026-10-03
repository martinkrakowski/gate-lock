// GL1: pool directory rules (spec 6.H, F1-F20), the .format marker (F11-F17, D2,
// D23), pool resolution (D1), the umask and the test-mode gate (D20).
// Every test runs in the poison-default env with an explicit pool unless it is
// about pool resolution itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIN, buildEnv, freshPool, listing, runBin, scratchOf, startBin } from './harness.js';
import { TM, UID, accepted, cfg, mkdirMode, modeOf, poolIn, refusal } from './cfg.js';

const ABSENT = { create: false };

describe('T70 pool creation and the marker', () => {
  it('T70 a missing pool is created 0700 with .format holding 1, whatever the umask', () => {
    const pool = freshPool(ABSENT);
    const r = spawnSync('sh', ['-c', 'umask 000; exec sh "$0" "$@"', BIN, 'status'], {
      env: buildEnv({ GATE_LOCK_DIR: pool }),
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('gate-lock: not implemented yet\n');
    expect(modeOf(pool)).toBe('0700');
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    expect(listing(pool, { modes: true })).toEqual(['0600 .format']);
    expect(fs.readdirSync(pool).filter((n) => n.startsWith('.format'))).toEqual(['.format']);
  });

  it('T70 the pool is created 0700 under the harness umask too (D23)', () => {
    const pool = freshPool(ABSENT);
    expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
    expect(modeOf(pool)).toBe('0700');
  });

  it('T71 an existing .format holding 1 is accepted silently and not rewritten', () => {
    const pool = freshPool();
    const marker = path.join(pool, '.format');
    fs.writeFileSync(marker, '1\n');
    fs.chmodSync(marker, 0o664);
    const before = fs.statSync(marker);
    fs.utimesSync(marker, 1000, 1000);
    expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
    const after = fs.statSync(marker);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(1000000);
    expect(modeOf(marker)).toBe('0664');
    expect(fs.readFileSync(marker, 'utf8')).toBe('1\n');
    expect(fs.readdirSync(pool)).toEqual(['.format']);
  });

  it('F13 trailing newlines are trimmed on read: 1, 1+LF and 1+LF+LF are all accepted', () => {
    for (const bytes of ['1', '1\n', '1\n\n\n']) {
      const pool = freshPool();
      fs.writeFileSync(path.join(pool, '.format'), bytes);
      expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
    }
  });

  it('T72 a .format holding 2, or empty, is refused naming the value; the pool keeps only .format', () => {
    for (const [bytes, shown] of [
      ['2\n', '2'],
      ['', 'nothing'],
      ['\n', 'nothing'],
    ]) {
      const pool = freshPool();
      fs.writeFileSync(path.join(pool, '.format'), bytes);
      const r = refusal(cfg({ GATE_LOCK_DIR: pool }), 'lock format', 'this gate speaks 1', shown);
      expect(r.stderr).toContain(`GATE_LOCK_DIR=${pool}`);
      expect(fs.readdirSync(pool)).toEqual(['.format']);
      expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe(bytes);
    }
  });

  it('F13 any value but exactly 1 is refused: "1 ", "11", "01", "1\\nx", a directory, unreadable', () => {
    const odd = ['1 \n', '11\n', '01\n', '1\nx\n', 'x', '1\r\n'];
    for (const bytes of odd) {
      const pool = freshPool();
      fs.writeFileSync(path.join(pool, '.format'), bytes);
      refusal(cfg({ GATE_LOCK_DIR: pool }), 'lock format', 'this gate speaks 1');
    }
    const asDir = freshPool();
    fs.mkdirSync(path.join(asDir, '.format'));
    refusal(cfg({ GATE_LOCK_DIR: asDir }), 'lock format', 'nothing', 'this gate speaks 1');
    const unreadable = freshPool();
    const m = path.join(unreadable, '.format');
    fs.writeFileSync(m, '1\n');
    fs.chmodSync(m, 0o000);
    refusal(cfg({ GATE_LOCK_DIR: unreadable }), 'lock format', 'nothing');
    fs.chmodSync(m, 0o600);
  });

  it('F13 a dangling .format symlink is refused and not followed', () => {
    const pool = freshPool();
    fs.symlinkSync(path.join(scratchOf(pool), 'nowhere'), path.join(pool, '.format'));
    refusal(cfg({ GATE_LOCK_DIR: pool }), 'lock format', 'nothing');
    expect(fs.existsSync(path.join(scratchOf(pool), 'nowhere'))).toBe(false);
  });

  it('F13 the bytes must be exactly 1 and newlines: a NUL anywhere is refused (command substitution drops NULs)', () => {
    for (const bytes of ['1\0\n', '\0', '1\0', '\0\n1\n', '\x001\n', '1\n\0\n']) {
      const pool = freshPool();
      fs.writeFileSync(path.join(pool, '.format'), Buffer.from(bytes, 'latin1'));
      refusal(cfg({ GATE_LOCK_DIR: pool }), 'lock format', 'this gate speaks 1');
    }
  });

  it('F13 a FIFO at .format is refused without hanging (the type is checked before any read)', () => {
    const pool = freshPool();
    const made = spawnSync('mkfifo', [path.join(pool, '.format')]);
    expect(made.status).toBe(0);
    const r = runBin(['status'], { env: { GATE_LOCK_DIR: pool }, timeout: 10000 });
    refusal(r, 'lock format', 'nothing');
  });

  it('N1 a pool we cannot write to reports the failed publish, not a wrong format', () => {
    if (UID === 0) return;
    const pool = freshPool();
    fs.chmodSync(pool, 0o500);
    try {
      const r = refusal(cfg({ GATE_LOCK_DIR: pool }), 'could not publish the .format marker', pool);
      expect(r.stderr).toContain('temp write or hard link failed');
      expect(r.stderr).not.toContain('lock format');
    } finally {
      fs.chmodSync(pool, 0o700);
    }
  });

  it('F13 a symlink to a valid marker is refused: only a regular file can say 1', () => {
    const pool = freshPool();
    const real = path.join(scratchOf(pool), 'real-marker');
    fs.writeFileSync(real, '1\n');
    fs.symlinkSync(real, path.join(pool, '.format'));
    refusal(cfg({ GATE_LOCK_DIR: pool }), 'lock format', 'nothing');
  });

  it('F17 the marker is published before the stale-threshold and count checks', () => {
    const pool = freshPool(ABSENT);
    refusal(cfg({ GATE_LOCK_DIR: pool, GATE_LOCK_STALE_SECONDS: 'x' }), 'GATE_LOCK_STALE_SECONDS');
    expect(listing(pool, { modes: false })).toEqual(['.format']);
  });

  it('D2 a leftover .format.tmp.<pid> is not touched by configuration', () => {
    const pool = freshPool();
    fs.writeFileSync(path.join(pool, '.format.tmp.999999'), '1\n');
    expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
    expect(fs.readdirSync(pool).sort()).toEqual(['.format', '.format.tmp.999999']);
  });

  it('T93 (config part, F15) racing acquirers into an absent pool leave one .format and no temp', async () => {
    for (let round = 0; round < 4; round++) {
      const pool = freshPool(ABSENT);
      const runs = Array.from({ length: 6 }, () =>
        startBin(['status'], { env: { GATE_LOCK_DIR: pool } }),
      );
      const results = await Promise.all(runs.map((x) => x.done));
      for (const r of results) expect(r.stderr).toBe('gate-lock: not implemented yet\n');
      expect(listing(pool, { modes: false })).toEqual(['.format']);
      expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    }
  });
});

describe('T73-T80 pool directory refusals', () => {
  it('T73 a pool owned by someone else is refused: names GATE_LOCK_DIR, owned by uid, not the parent', () => {
    const pool = freshPool();
    const r = refusal(
      cfg({
        ...TM,
        GATE_LOCK_DIR: pool,
        GATE_LOCK_TEST_UID: '65534',
        GATE_LOCK_TEST_PARENT_UID: UID,
      }),
      `GATE_LOCK_DIR=${pool}`,
      'owned by uid 65534',
    );
    expect(r.stderr).not.toMatch(/parent/);
    expect(fs.readdirSync(pool)).toEqual([]);
  });

  it('H10/H11 the pool-uid seam also moves the parent unless the parent seam pins it', () => {
    const pool = freshPool();
    const r = refusal(cfg({ ...TM, GATE_LOCK_DIR: pool, GATE_LOCK_TEST_UID: '65534' }));
    expect(r.stderr).toContain("GATE_LOCK_DIR's parent");
    expect(r.stderr).toContain('owned by uid 65534');
    expect(fs.readdirSync(pool)).toEqual([]);
  });

  it('T74 a group-writable (0775) or world-writable (0777) pool is refused, left empty', () => {
    for (const mode of [0o775, 0o777, 0o770, 0o702]) {
      const pool = freshPool();
      fs.chmodSync(pool, mode);
      refusal(
        cfg({ GATE_LOCK_DIR: pool }),
        'neither group- nor world-writable',
        `GATE_LOCK_DIR=${pool}`,
      );
      expect(fs.readdirSync(pool)).toEqual([]);
    }
  });

  it('F8 an existing 0755 leaf owned by us is accepted (only group/other WRITE is refused)', () => {
    const pool = freshPool();
    fs.chmodSync(pool, 0o755);
    expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
  });

  it('F8 a leaf that is a regular file is refused', () => {
    const { pool } = poolIn();
    fs.mkdirSync(path.dirname(pool), { recursive: true });
    fs.writeFileSync(pool, 'x');
    refusal(cfg({ GATE_LOCK_DIR: pool }), `GATE_LOCK_DIR=${pool}`, 'directory');
  });

  it('T75 a symlinked pool is refused naming GATE_LOCK_DIR=<link> and "not a symlink"; target left empty', () => {
    const { pool, scratch } = poolIn();
    const target = mkdirMode(path.join(scratch, 'target'));
    fs.symlinkSync(target, pool);
    refusal(cfg({ GATE_LOCK_DIR: pool }), `GATE_LOCK_DIR=${pool} is`, 'not a symlink');
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('T75 a relative pool path is refused naming the value and "must be an absolute path"', () => {
    const { scratch } = poolIn();
    for (const rel of ['pool', './pool', 'a/b']) {
      const r = refusal(cfg({ GATE_LOCK_DIR: rel }), rel, 'must be an absolute path');
      expect(r.status).toBe(2);
    }
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('F6 a relative pool (even one that resolves to a real dir from cwd) creates nothing', () => {
    const { scratch } = poolIn();
    const r = runBin(['status'], { env: { GATE_LOCK_DIR: 'pool' }, cwd: scratch });
    refusal(r, 'must be an absolute path');
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('T76 a path that is not plain is refused before anything is created', () => {
    const { scratch } = poolIn();
    const link = path.join(scratch, 'link');
    const real = mkdirMode(path.join(scratch, 'real'));
    fs.symlinkSync(real, link);
    const spellings = [
      `${link}//pool`,
      `${link}/./pool`,
      `${link}/../pool`,
      `${scratch}//pool`,
      `${scratch}/./pool`,
      `${scratch}/real/../pool`,
      `${scratch}/pool/.`,
      `${scratch}/pool/..`,
      `${scratch}/pool/./`,
      `//${scratch.slice(1)}/pool`,
    ];
    for (const s of spellings) {
      refusal(cfg({ GATE_LOCK_DIR: s }), 'plain absolute path');
    }
    expect(fs.readdirSync(real)).toEqual([]);
    expect(fs.readdirSync(scratch).sort()).toEqual(['link', 'real']);
  });

  it('T76 a symlinked ancestor is refused naming the component, "is a symlink", and the pwd -P hint', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    const below = mkdirMode(path.join(real, 'below'));
    const link = path.join(scratch, 'link');
    fs.symlinkSync(real, link);
    const r = refusal(
      cfg({ GATE_LOCK_DIR: `${link}/below/pool` }),
      `${link} is a symlink`,
      'pwd -P',
    );
    expect(r.stderr).toContain('physical');
    expect(fs.readdirSync(below)).toEqual([]);
    expect(fs.readdirSync(real)).toEqual(['below']);
  });

  it('T76 a real nested pool two levels down is accepted with a marker', () => {
    const { scratch } = poolIn();
    const nested = mkdirMode(path.join(scratch, 'a', 'b'));
    const pool = path.join(nested, 'pool');
    expect(accepted(cfg({ GATE_LOCK_DIR: pool }))).toBe(true);
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
  });

  it('F5 a symlink at the very top of the chain (an alias of a directory above) is refused', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    mkdirMode(path.join(real, 'x', 'y'));
    fs.symlinkSync(real, path.join(scratch, 'alias'));
    const r = refusal(
      cfg({ GATE_LOCK_DIR: `${scratch}/alias/x/y/pool` }),
      `${scratch}/alias is a symlink`,
    );
    expect(r.stderr).toContain('pwd -P');
    expect(fs.readdirSync(path.join(real, 'x', 'y'))).toEqual([]);
  });

  it('T77 an alias to a real directory is refused with the hint; the resolved path is accepted', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    mkdirMode(path.join(real, 'sub'));
    const alias = path.join(scratch, 'alias');
    fs.symlinkSync(real, alias);
    refusal(cfg({ GATE_LOCK_DIR: `${alias}/sub/pool` }), 'is a symlink', 'pwd -P');
    expect(fs.readdirSync(path.join(real, 'sub'))).toEqual([]);
    expect(accepted(cfg({ GATE_LOCK_DIR: `${real}/sub/pool` }))).toBe(true);
  });

  it('T78 a symlinked pool cannot hide behind trailing slashes', () => {
    const { pool, scratch } = poolIn();
    const target = mkdirMode(path.join(scratch, 'target'));
    fs.symlinkSync(target, pool);
    for (const slashes of ['', '/', '//']) {
      const r = refusal(
        cfg({ GATE_LOCK_DIR: `${pool}${slashes}` }),
        `GATE_LOCK_DIR=${pool} is`,
        'not a symlink',
      );
      expect(r.status).toBe(2);
    }
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('T79 trailing slashes are reduced away; the root is refused as not a pool', () => {
    const pool = freshPool();
    for (const slashes of ['', '/', '//', '///']) {
      expect(accepted(cfg({ GATE_LOCK_DIR: `${pool}${slashes}` }))).toBe(true);
    }
    for (const root of ['/', '//', '///']) {
      refusal(cfg({ GATE_LOCK_DIR: root }), 'not the filesystem root');
    }
  });

  it('T80 a parent writable by group or others is refused and the pool is not created', () => {
    for (const mode of [0o775, 0o777, 0o770, 0o707]) {
      const { pool, scratch } = poolIn();
      fs.chmodSync(scratch, mode);
      refusal(
        cfg({ GATE_LOCK_DIR: pool }),
        `GATE_LOCK_DIR's parent ${scratch}`,
        'not writable by group or others',
      );
      expect(fs.existsSync(pool)).toBe(false);
    }
  });

  it('T80 a foreign-owned parent (parent uid seam 65534) is refused and the pool is not created', () => {
    const { pool, scratch } = poolIn();
    refusal(
      cfg({ ...TM, GATE_LOCK_DIR: pool, GATE_LOCK_TEST_PARENT_UID: '65534' }),
      `GATE_LOCK_DIR's parent ${scratch}`,
      'owned by uid 65534',
    );
    expect(fs.existsSync(pool)).toBe(false);
  });

  it('T80 a symlinked parent is refused naming the parent; an ordinary 0700 parent is accepted', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    const parentLink = path.join(scratch, 'parent-link');
    fs.symlinkSync(real, parentLink);
    refusal(cfg({ GATE_LOCK_DIR: `${parentLink}/pool` }), `GATE_LOCK_DIR's parent ${parentLink}`);
    expect(fs.readdirSync(real)).toEqual([]);
    expect(accepted(cfg({ GATE_LOCK_DIR: `${real}/pool` }))).toBe(true);
    expect(fs.existsSync(path.join(real, 'pool', '.format'))).toBe(true);
  });

  it('F4 a missing parent is refused (the tool never creates parents)', () => {
    const { scratch } = poolIn();
    const pool = path.join(scratch, 'missing', 'pool');
    refusal(cfg({ GATE_LOCK_DIR: pool }), `GATE_LOCK_DIR's parent ${scratch}/missing`);
    expect(fs.existsSync(path.join(scratch, 'missing'))).toBe(false);
  });

  it('F4 a parent that is a regular file is refused', () => {
    const { scratch } = poolIn();
    fs.writeFileSync(path.join(scratch, 'file'), 'x');
    refusal(cfg({ GATE_LOCK_DIR: `${scratch}/file/pool` }), `parent ${scratch}/file`);
  });

  it('F4 a pool directly under the root is refused through the parent rule', () => {
    if (UID === 0) return; // root owns "/"
    refusal(cfg({ GATE_LOCK_DIR: '/gate-lock-test-pool' }), "GATE_LOCK_DIR's parent /");
    expect(fs.existsSync('/gate-lock-test-pool')).toBe(false);
  });

  it('F4 the system temp directory (sticky, world-writable) is refused as a parent', () => {
    const r = refusal(
      cfg({ GATE_LOCK_DIR: '/tmp/gate-lock-test-direct-pool' }),
      "GATE_LOCK_DIR's parent /tmp",
    );
    expect(r.status).toBe(2);
    expect(fs.existsSync('/tmp/gate-lock-test-direct-pool')).toBe(false);
  });

  it('T110 the poison default pool is refused and creates nothing', () => {
    refusal(runBin(['status']), "GATE_LOCK_DIR's parent");
    expect(fs.existsSync('/nonexistent-gate-lock-poison')).toBe(false);
  });
});

// Non-recursive cleanup: marker, pool, intermediate; ENOENT and ENOTEMPTY are fine.
function removeSmokePool(pool, inter) {
  for (const undo of [
    () => fs.unlinkSync(path.join(pool, '.format')),
    () => fs.rmdirSync(pool),
    () => fs.rmdirSync(inter),
  ]) {
    try {
      undo();
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
    }
  }
}

describe('D1 pool resolution when GATE_LOCK_DIR is unset or empty', () => {
  const bareEnv = (extra) => ({
    GATE_LOCK_DIR: undefined,
    XDG_RUNTIME_DIR: undefined,
    TMPDIR: undefined,
    ...extra,
  });

  // Every test that needs the /tmp fallback root gives it a per-test scratch (S3).
  const withRoot = (root, extra) => bareEnv({ ...TM, GATE_LOCK_TEST_TMP_ROOT: root, ...extra });

  it('D1 XDG_RUNTIME_DIR valid: the pool is $XDG_RUNTIME_DIR/gate-lock, TMPDIR is untouched', () => {
    const xdg = scratchOf(freshPool(ABSENT));
    const tmp = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(bareEnv({ XDG_RUNTIME_DIR: xdg, TMPDIR: tmp })))).toBe(true);
    expect(modeOf(path.join(xdg, 'gate-lock'))).toBe('0700');
    expect(fs.readFileSync(path.join(xdg, 'gate-lock', '.format'), 'utf8')).toBe('1\n');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('D1 XDG_RUNTIME_DIR with trailing slashes is reduced and accepted', () => {
    const xdg = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(bareEnv({ XDG_RUNTIME_DIR: `${xdg}//` })))).toBe(true);
    expect(fs.existsSync(path.join(xdg, 'gate-lock', '.format'))).toBe(true);
  });

  it('T81 an EMPTY pool variable behaves as unset (D1 supersedes pool-less mode)', () => {
    const xdg = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(bareEnv({ GATE_LOCK_DIR: '', XDG_RUNTIME_DIR: xdg })))).toBe(true);
    expect(fs.existsSync(path.join(xdg, 'gate-lock', '.format'))).toBe(true);
  });

  it('D1 XDG unset, TMPDIR set: the pool is <TMPDIR>/gate-lock-<uid>/pool, both 0700', () => {
    const tmp = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(bareEnv({ TMPDIR: tmp })))).toBe(true);
    const inter = path.join(tmp, `gate-lock-${UID}`);
    expect(modeOf(inter)).toBe('0700');
    expect(modeOf(path.join(inter, 'pool'))).toBe('0700');
    expect(fs.readFileSync(path.join(inter, 'pool', '.format'), 'utf8')).toBe('1\n');
    expect(fs.readdirSync(tmp)).toEqual([`gate-lock-${UID}`]);
  });

  it('D1 TMPDIR is resolved physically: a symlinked TMPDIR gets its intermediate in the target', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    const link = path.join(scratch, 'link');
    fs.symlinkSync(real, link);
    expect(accepted(cfg(bareEnv({ TMPDIR: link })))).toBe(true);
    expect(fs.existsSync(path.join(real, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
  });

  it('D1 an invalid XDG_RUNTIME_DIR is ignored, never an error, in each way', () => {
    const { scratch } = poolIn();
    const good = mkdirMode(path.join(scratch, 'good'), 0o700);
    const loose = mkdirMode(path.join(scratch, 'loose'), 0o755);
    const tight = mkdirMode(path.join(scratch, 'tight'), 0o500);
    const group = mkdirMode(path.join(scratch, 'group'), 0o770);
    const file = path.join(scratch, 'file');
    fs.writeFileSync(file, 'x');
    const link = path.join(scratch, 'link');
    fs.symlinkSync(good, link);
    const cases = {
      relative: 'xdg-relative',
      missing: path.join(scratch, 'missing'),
      file,
      'mode 0755': loose,
      'mode 0500': tight,
      'mode 0770': group,
      'is a symlink': link,
      'symlinked component': `${link}/..`,
      'not plain //': `${scratch}//good`,
      'not plain .': `${scratch}/./good`,
      'not plain ..': `${scratch}/loose/../good`,
      'foreign owner': good,
    };
    for (const [why, xdg] of Object.entries(cases)) {
      const tmp = mkdirMode(path.join(scratch, `tmp-${why.replace(/\W/g, '_')}`));
      const env = bareEnv({ XDG_RUNTIME_DIR: xdg, TMPDIR: tmp });
      if (why === 'foreign owner')
        Object.assign(env, TM, { GATE_LOCK_TEST_UID: '65534', GATE_LOCK_TEST_PARENT_UID: '65534' });
      const r = cfg(env);
      if (why === 'foreign owner') {
        // the seam makes the whole tool expect another uid, so the intermediate is refused
        refusal(r, 'GATE_LOCK_DIR');
        continue;
      }
      expect(accepted(r), `${why}: ${r.stderr}`).toBe(true);
      expect(fs.existsSync(path.join(tmp, `gate-lock-${UID}`, 'pool', '.format')), why).toBe(true);
    }
    expect(fs.readdirSync(good)).toEqual([]);
    expect(fs.existsSync(path.join(loose, 'gate-lock'))).toBe(false);
    expect(fs.existsSync(path.join(group, 'gate-lock'))).toBe(false);
  });

  it('D1 an XDG_RUNTIME_DIR reached through a symlinked ancestor is ignored', () => {
    const { scratch } = poolIn();
    const real = mkdirMode(path.join(scratch, 'real'));
    mkdirMode(path.join(real, 'run'), 0o700);
    const link = path.join(scratch, 'link');
    fs.symlinkSync(real, link);
    const tmp = mkdirMode(path.join(scratch, 'tmp'));
    expect(accepted(cfg(bareEnv({ XDG_RUNTIME_DIR: `${link}/run`, TMPDIR: tmp })))).toBe(true);
    expect(fs.existsSync(path.join(real, 'run', 'gate-lock'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
  });

  it('D1 a relative XDG_RUNTIME_DIR that exists from the working directory is still ignored', () => {
    const { scratch } = poolIn();
    mkdirMode(path.join(scratch, 'run'), 0o700);
    const tmp = mkdirMode(path.join(scratch, 'tmp'));
    const r = runBin(['status'], {
      env: bareEnv({ XDG_RUNTIME_DIR: 'run', TMPDIR: tmp }),
      cwd: scratch,
    });
    expect(accepted(r)).toBe(true);
    expect(fs.existsSync(path.join(scratch, 'run', 'gate-lock'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, `gate-lock-${UID}`, 'pool'))).toBe(true);
  });

  it('D1 both unset: the pool is under the fallback root (a scratch, via GATE_LOCK_TEST_TMP_ROOT)', () => {
    const root = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(withRoot(root)))).toBe(true);
    const inter = path.join(root, `gate-lock-${UID}`);
    expect(modeOf(inter)).toBe('0700');
    expect(modeOf(path.join(inter, 'pool'))).toBe('0700');
    expect(fs.readFileSync(path.join(inter, 'pool', '.format'), 'utf8')).toBe('1\n');
  });

  it('S3 the TMP_ROOT seam is inert outside test mode (warned and ignored)', () => {
    const root = scratchOf(freshPool(ABSENT));
    const tmp = scratchOf(freshPool(ABSENT));
    const r = cfg(bareEnv({ GATE_LOCK_TEST_TMP_ROOT: root, TMPDIR: tmp }));
    expect(r.stderr).toMatch(/^gate-lock: warning: .*GATE_LOCK_TEST_TMP_ROOT/);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
  });

  it('D1 an unusable TMPDIR (missing, relative, a file) falls back to the root', () => {
    const { scratch } = poolIn();
    const root = mkdirMode(path.join(scratch, 'root'));
    fs.writeFileSync(path.join(scratch, 'file'), 'x');
    for (const tmp of [path.join(scratch, 'nope'), 'relative-tmp', path.join(scratch, 'file')]) {
      const r = cfg(withRoot(root, { TMPDIR: tmp }));
      expect(accepted(r), `${tmp}: ${r.stderr}`).toBe(true);
      expect(fs.existsSync(path.join(root, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
    }
    expect(fs.readdirSync(scratch).sort()).toEqual(['file', 'root']);
  });

  it('S1 a TMPDIR that is neither ours nor sticky is not trusted: silent fallback to the root', () => {
    if (UID === 0) return; // root owns everything
    const root = scratchOf(freshPool(ABSENT));
    for (const untrusted of ['/usr', '/etc']) {
      if (!fs.existsSync(untrusted)) continue;
      const r = cfg(withRoot(root, { TMPDIR: untrusted }));
      expect(accepted(r), `${untrusted}: ${r.stderr}`).toBe(true);
      expect(fs.existsSync(path.join(untrusted, `gate-lock-${UID}`))).toBe(false);
      expect(fs.existsSync(path.join(root, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
    }
  });

  it('S1 a TMPDIR we own is trusted even at 0777 (owner is enough, sticky or not)', () => {
    const { scratch } = poolIn();
    const root = mkdirMode(path.join(scratch, 'root'));
    const tmp = mkdirMode(path.join(scratch, 'open'), 0o777);
    expect(accepted(cfg(withRoot(root, { TMPDIR: tmp })))).toBe(true);
    expect(fs.existsSync(path.join(tmp, `gate-lock-${UID}`, 'pool', '.format'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('S3 smoke: with no seam the default root is the real physical /tmp, and a sticky TMPDIR is trusted', () => {
    // The only test that touches the real /tmp/gate-lock-<uid>. Cleanup is never
    // recursive: marker, then pool, then the intermediate, only when this test
    // created it; ENOENT and ENOTEMPTY (another run, another shell) are fine.
    const inter = path.join(fs.realpathSync('/tmp'), `gate-lock-${UID}`);
    const pool = path.join(inter, 'pool');
    const existed = fs.existsSync(inter);
    try {
      expect(accepted(cfg(bareEnv()))).toBe(true);
      // /tmp is sticky and not ours, so it is trusted as TMPDIR: the pool lands there,
      // not in the (empty) fallback root.
      const root = scratchOf(freshPool(ABSENT));
      expect(accepted(cfg(withRoot(root, { TMPDIR: '/tmp' })))).toBe(true);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(fs.existsSync(pool)).toBe(true);
      try {
        expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
      } catch (err) {
        // only a concurrent run's cleanup may have removed it (the tool itself verified it)
        if (err.code !== 'ENOENT' || !existed) throw err;
      }
    } finally {
      if (!existed) removeSmokePool(pool, inter);
    }
  });

  it('D1 an intermediate pre-created by someone else is refused with exit 2 naming GATE_LOCK_DIR', () => {
    const { scratch } = poolIn();
    const make = {
      'wrong mode 0755': (p) => mkdirMode(p, 0o755),
      'wrong mode 0777': (p) => mkdirMode(p, 0o777),
      'mode 0500': (p) => mkdirMode(p, 0o500),
      'regular file': (p) => fs.writeFileSync(p, 'x'),
      'symlink to a 0700 dir': (p) => fs.symlinkSync(mkdirMode(`${p}-target`), p),
    };
    for (const [why, build] of Object.entries(make)) {
      const tmp = mkdirMode(path.join(scratch, `t-${why.replace(/\W/g, '_')}`));
      const inter = path.join(tmp, `gate-lock-${UID}`);
      build(inter);
      refusal(cfg(bareEnv({ TMPDIR: tmp })), 'GATE_LOCK_DIR', inter);
      expect(fs.existsSync(path.join(inter, 'pool')), why).toBe(false);
    }
  });

  it('D1 an intermediate owned by another uid (seam) is refused naming GATE_LOCK_DIR', () => {
    const tmp = scratchOf(freshPool(ABSENT));
    const inter = path.join(tmp, `gate-lock-${UID}`);
    mkdirMode(inter);
    const r = refusal(
      cfg(bareEnv({ ...TM, TMPDIR: tmp, GATE_LOCK_TEST_UID: '65534' })),
      'GATE_LOCK_DIR',
      'uid 65534',
      'owned by another user',
      'set GATE_LOCK_DIR to a directory you own',
    );
    expect(r.stderr).not.toContain('remove');
    expect(fs.readdirSync(inter)).toEqual([]);
  });

  it('D1 an existing, correct intermediate and pool are reused', () => {
    const tmp = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg(bareEnv({ TMPDIR: tmp })))).toBe(true);
    const marker = path.join(tmp, `gate-lock-${UID}`, 'pool', '.format');
    fs.utimesSync(marker, 1000, 1000);
    expect(accepted(cfg(bareEnv({ TMPDIR: tmp })))).toBe(true);
    expect(fs.statSync(marker).mtimeMs).toBe(1000000);
  });

  it('D1 an explicit GATE_LOCK_DIR wins over a valid XDG_RUNTIME_DIR and TMPDIR', () => {
    const pool = freshPool(ABSENT);
    const xdg = scratchOf(freshPool(ABSENT));
    const tmp = scratchOf(freshPool(ABSENT));
    expect(accepted(cfg({ GATE_LOCK_DIR: pool, XDG_RUNTIME_DIR: xdg, TMPDIR: tmp }))).toBe(true);
    expect(fs.existsSync(path.join(pool, '.format'))).toBe(true);
    expect(fs.readdirSync(xdg)).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('D1 the derived pool is judged like any other: a group-writable default pool is refused', () => {
    const xdg = scratchOf(freshPool(ABSENT));
    const pool = path.join(xdg, 'gate-lock');
    mkdirMode(pool, 0o775);
    refusal(cfg(bareEnv({ XDG_RUNTIME_DIR: xdg })), 'neither group- nor world-writable', pool);
  });
});

describe('D20 test-mode gate', () => {
  it('D20 outside test mode a set seam is ignored with a one-line warning naming it', () => {
    const pool = freshPool();
    const r = cfg({ GATE_LOCK_DIR: pool, GATE_LOCK_TEST_UID: '65534' });
    const lines = r.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^gate-lock: warning: .*GATE_LOCK_TEST_UID.*GATE_LOCK_TEST_MODE=1/);
    expect(`${lines[1]}\n`).toBe('gate-lock: not implemented yet\n');
    expect(r.status).toBe(2);
  });

  it('D20 only the value 1 enables test mode', () => {
    for (const mode of ['0', 'true', 'yes', '11', ' 1', '1 ', '']) {
      const pool = freshPool();
      const r = cfg({
        GATE_LOCK_DIR: pool,
        GATE_LOCK_TEST_MODE: mode,
        GATE_LOCK_TEST_UID: '65534',
        GATE_LOCK_TEST_PARENT_UID: '65534',
      });
      expect(r.stderr, `mode ${JSON.stringify(mode)}`).toMatch(/^gate-lock: warning: /);
      expect(r.stderr).toContain('not implemented yet');
      expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
    }
  });

  it('D20 in test mode the seam is honoured and there is no warning', () => {
    const pool = freshPool();
    const r = cfg({
      ...TM,
      GATE_LOCK_DIR: pool,
      GATE_LOCK_TEST_UID: '65534',
      GATE_LOCK_TEST_PARENT_UID: UID,
    });
    expect(r.stderr).not.toMatch(/warning/);
    expect(r.stderr).toContain('owned by uid 65534');
  });

  it('D20 an empty seam variable is inert and silent outside test mode', () => {
    const pool = freshPool();
    const r = cfg({ GATE_LOCK_DIR: pool, GATE_LOCK_TEST_UID: '', GATE_LOCK_TEST_NPROC: '' });
    expect(accepted(r)).toBe(true);
  });

  it('D20 an empty seam variable is inert in test mode', () => {
    const pool = freshPool();
    const r = cfg({
      ...TM,
      GATE_LOCK_DIR: pool,
      GATE_LOCK_TEST_UID: '',
      GATE_LOCK_TEST_PARENT_UID: '',
    });
    expect(accepted(r)).toBe(true);
  });

  it('D20 --format and --version exit before the seam check: nothing on stderr', () => {
    for (const args of [['--format'], ['--version']]) {
      const r = runBin(args, { env: { GATE_LOCK_TEST_UID: '65534' } });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).not.toMatch(/warning/);
    }
  });

  it('D20 workers warns about an ignored seam on stderr only, in one line', () => {
    const r = runBin(['workers'], { env: { GATE_LOCK_TEST_UID: '65534' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      'gate-lock: warning: ignoring GATE_LOCK_TEST_UID (test seams need GATE_LOCK_TEST_MODE=1)\n',
    );
  });
});

describe('D23 umask and explicit modes', () => {
  it('D23 source-level guard: the script text sets umask 077 (behaviour is covered by T70)', () => {
    const text = fs.readFileSync(BIN, 'utf8');
    expect(text).toMatch(/^umask 077$/m);
  });
});

describe('D1 refusals on a derived pool still point at GATE_LOCK_DIR', () => {
  it('F8/F13 a bad default pool or marker says to set GATE_LOCK_DIR', () => {
    const xdg = scratchOf(freshPool(ABSENT));
    const env = { GATE_LOCK_DIR: undefined, XDG_RUNTIME_DIR: xdg, TMPDIR: undefined };
    const pool = path.join(xdg, 'gate-lock');
    mkdirMode(pool, 0o775);
    refusal(cfg(env), pool, 'set GATE_LOCK_DIR');
    fs.chmodSync(pool, 0o700);
    fs.writeFileSync(path.join(pool, '.format'), '2\n');
    refusal(cfg(env), 'lock format', 'set GATE_LOCK_DIR');
  });
});
