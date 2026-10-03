// GL1: variables, counts and budgets (spec 6.I, V3-V20, D5, D22). Every test
// runs in the poison-default env with an explicit fresh pool; the processor
// count is pinned through the test seam (H12).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshPool, listing } from './harness.js';
import { TM, accepted, cfg, refusal } from './cfg.js';

const NPROC = 'GATE_LOCK_TEST_NPROC';

/** Run configuration against a fresh pool, 24 processors unless `nproc` says otherwise. */
function run(env = {}, { nproc = '24' } = {}) {
  const pool = freshPool({ create: false });
  const r = cfg({ ...TM, [NPROC]: nproc, GATE_LOCK_DIR: pool, ...env });
  return { r, pool };
}
const ok = (env, opts) => accepted(run(env, opts).r);

describe('T82 GATE_HOST_SLOTS alone is the count (V3-V6, V10)', () => {
  it('T82 6 and 006 accepted, empty accepted (the project count decides)', () => {
    expect(ok({ GATE_HOST_SLOTS: '6', GATE_LOCK_SLOTS: '6' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '006', GATE_LOCK_SLOTS: '6' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '' })).toBe(true);
  });

  it('T82 0, 65 and x are refused naming GATE_HOST_SLOTS', () => {
    for (const v of ['0', '65', 'x']) {
      refusal(run({ GATE_HOST_SLOTS: v }).r, 'GATE_HOST_SLOTS');
    }
  });

  it('V3 a non-number names the variable, "must be a number of slots" and the value as given', () => {
    for (const v of ['x', '4.5', '-1', ' 4', '4 ', '0x4', '+4', '1e1']) {
      for (const name of ['GATE_HOST_SLOTS', 'GATE_LOCK_SLOTS']) {
        const env =
          name === 'GATE_HOST_SLOTS' ? { [name]: v, GATE_LOCK_SLOTS: undefined } : { [name]: v };
        const r = refusal(run(env).r, `gate-lock: ${name} must be a number of slots`);
        expect(r.stderr).toContain(`'${v}'`);
      }
    }
  });

  it('V5 over 64 is exactly "<prefix><name> must be at most 64 slots: <value as given>"', () => {
    for (const [v, name] of [
      ['65', 'GATE_HOST_SLOTS'],
      ['065', 'GATE_HOST_SLOTS'],
      ['100', 'GATE_HOST_SLOTS'],
      ['99999999999999999999', 'GATE_HOST_SLOTS'],
      ['000000000000000000000000000100', 'GATE_HOST_SLOTS'],
      ['065', 'GATE_LOCK_SLOTS'],
      ['123456789012345678901234567890', 'GATE_LOCK_SLOTS'],
    ]) {
      const env =
        name === 'GATE_HOST_SLOTS' ? { [name]: v, GATE_LOCK_SLOTS: undefined } : { [name]: v };
      const { r } = run(env);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe(`gate-lock: ${name} must be at most 64 slots: ${v}\n`);
    }
  });

  it('V5 zero in any spelling is exactly "<name> must be at least one slot: <value as given>"', () => {
    for (const v of ['0', '00', '000', '0000000000000000000000']) {
      const { r } = run({ GATE_HOST_SLOTS: v, GATE_LOCK_SLOTS: undefined });
      expect(r.status).toBe(2);
      expect(r.stderr).toBe(`gate-lock: GATE_HOST_SLOTS must be at least one slot: ${v}\n`);
    }
  });

  it('V4/V5 exactly 64 and 064 are accepted', () => {
    expect(ok({ GATE_HOST_SLOTS: '64', GATE_LOCK_SLOTS: '64' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '064', GATE_LOCK_SLOTS: '64' }, { nproc: '64' })).toBe(true);
    expect(ok({ GATE_LOCK_SLOTS: '064' })).toBe(true);
  });

  it('V6 a refused count leaves no slot behind (only the marker)', () => {
    const { r, pool } = run({ GATE_HOST_SLOTS: '65' });
    expect(r.status).toBe(2);
    expect(listing(pool, { modes: false })).toEqual(['.format']);
  });

  it('D22 an empty GATE_LOCK_SLOTS is unset (V8)', () => {
    expect(ok({ GATE_LOCK_SLOTS: '' })).toBe(true);
    expect(ok({ GATE_LOCK_SLOTS: '', GATE_HOST_SLOTS: '5' })).toBe(true);
  });

  it('V8 GATE_LOCK_SLOTS is parsed on its own first: a non-count is refused whatever the host says', () => {
    refusal(
      run({ GATE_LOCK_SLOTS: 'x', GATE_HOST_SLOTS: '6' }).r,
      'GATE_LOCK_SLOTS must be a number of slots',
    );
    refusal(
      run({ GATE_LOCK_SLOTS: '0', GATE_HOST_WORKERS: '4' }).r,
      'GATE_LOCK_SLOTS must be at least one slot',
    );
  });

  it('V12 with no host variable the project count (default 1) stands', () => {
    expect(ok({ GATE_LOCK_SLOTS: '7' })).toBe(true);
    expect(ok({ GATE_LOCK_SLOTS: undefined })).toBe(true);
  });
});

describe('V7 GATE_HOST_WORKERS parsing', () => {
  it('V7 non-digits and zero are refused naming the variable', () => {
    for (const v of ['x', '4.5', '-1', ' 4', '0x4']) {
      refusal(
        run({ GATE_HOST_WORKERS: v }).r,
        'GATE_HOST_WORKERS must be a number of workers',
        `'${v}'`,
      );
    }
    for (const v of ['0', '00', '0000']) {
      refusal(
        run({ GATE_HOST_WORKERS: v }).r,
        `GATE_HOST_WORKERS must be at least one worker: ${v}`,
      );
    }
  });

  it('V7 three or more digits are accepted as at least one, with no arithmetic (and not bounded by 64)', () => {
    for (const v of ['100', '999', '100000000000000000000', '0000000000000000000000000100']) {
      const { r } = run({ GATE_HOST_WORKERS: v, GATE_LOCK_SLOTS: '1' });
      expect(accepted(r), `${v}: ${r.stderr}`).toBe(true);
    }
  });

  it('V7/V11 a 64-bit-wrapping worker count is not arithmetic: 2^64+1 must not read as 1', () => {
    for (const v of ['18446744073709551617', '9223372036854775808', '4294967297']) {
      const { r } = run({ GATE_HOST_WORKERS: v, GATE_LOCK_SLOTS: '1' });
      expect(accepted(r), `${v}: ${r.stderr}`).toBe(true);
    }
  });

  it('V7 a worker count above the processor count is not refused by the lock tool', () => {
    expect(ok({ GATE_HOST_WORKERS: '48', GATE_LOCK_SLOTS: '1' })).toBe(true);
  });

  it('D22 an empty GATE_HOST_WORKERS is unset (F10)', () => {
    expect(ok({ GATE_HOST_WORKERS: '', GATE_HOST_SLOTS: '', GATE_LOCK_SLOTS: '1' })).toBe(true);
  });
});

describe('T83 slot derivation (V11)', () => {
  const derive = [
    ['24', '4', 6],
    ['24', '5', 4],
    ['3', '4', 1],
    ['24', '1', 24],
    ['200', '1', 64],
    ['16', '16', 1],
  ];
  for (const [nproc, workers, slots] of derive) {
    it(`T83 ${nproc} processors and ${workers} workers give ${slots} slots`, () => {
      const env = (n) => ({
        GATE_HOST_WORKERS: workers,
        GATE_LOCK_WORKERS: workers,
        GATE_LOCK_SLOTS: String(n),
      });
      expect(ok(env(slots), { nproc })).toBe(true);
      if (slots < 64) {
        const above = refusal(
          run(env(slots + 1), { nproc }).r,
          'GATE_LOCK_SLOTS',
          `GATE_HOST_WORKERS=${workers}`,
        );
        expect(above.stderr).toContain(String(slots));
      }
      if (slots > 1) {
        refusal(
          run(env(slots - 1), { nproc }).r,
          'GATE_LOCK_SLOTS',
          `GATE_HOST_WORKERS=${workers}`,
        );
      }
    });
  }

  it('T83 zero in the one-slot case is refused as not a count, before any comparison', () => {
    const r = refusal(
      run({ GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '4', GATE_LOCK_SLOTS: '0' }, { nproc: '3' })
        .r,
      'GATE_LOCK_SLOTS must be at least one slot: 0',
    );
    expect(r.stderr).not.toMatch(/GATE_HOST_WORKERS/);
  });

  it('V11 leading zeros on the processor count are a spelling; nine or more digits are clamped', () => {
    expect(ok({ GATE_HOST_WORKERS: '4', GATE_LOCK_SLOTS: '6' }, { nproc: '0024' })).toBe(true);
    expect(
      ok({ GATE_HOST_WORKERS: '1', GATE_LOCK_SLOTS: '64' }, { nproc: '99999999999999999999' }),
    ).toBe(true);
    expect(
      ok({ GATE_HOST_WORKERS: '1', GATE_LOCK_SLOTS: '64' }, { nproc: '000000000000000000024' }),
    ).toBe(false);
  });

  it('H12 an empty processor seam is inert: the real query answers', () => {
    expect(ok({ GATE_HOST_WORKERS: '1', GATE_LOCK_SLOTS: undefined }, { nproc: '' })).toBe(true);
  });

  it('V11 a 64-bit-wrapping processor count is clamped, not wrapped: 2^64+1 is not 1 processor', () => {
    for (const nproc of ['18446744073709551617', '4294967297', '999999999', '1000000000']) {
      expect(ok({ GATE_HOST_WORKERS: '1', GATE_LOCK_SLOTS: '64' }, { nproc }), nproc).toBe(true);
    }
  });

  it('V11 derivation with no project count simply succeeds', () => {
    expect(ok({ GATE_HOST_WORKERS: '4', GATE_LOCK_SLOTS: undefined })).toBe(true);
  });

  it('T86 a non-numeric processor count refuses the derivation naming the query and "derive a slot count"', () => {
    // an empty seam is inert (the real query answers), so it is not in this list
    for (const nproc of ['x', '4.5', '-1', ' 4']) {
      const { r } = run({ GATE_HOST_WORKERS: '4', GATE_LOCK_SLOTS: '1' }, { nproc });
      refusal(
        r,
        'GATE_HOST_WORKERS=4',
        'getconf _NPROCESSORS_ONLN',
        'derive a slot count',
        'GATE_HOST_SLOTS',
      );
    }
  });
});

describe('T85 the budget check (V13)', () => {
  it('T85 6 slots with 4 workers on 24 processors is accepted; GATE_HOST_SLOTS=24 alone is accepted silently', () => {
    expect(
      ok({
        GATE_HOST_SLOTS: '6',
        GATE_HOST_WORKERS: '4',
        GATE_LOCK_WORKERS: '4',
        GATE_LOCK_SLOTS: '6',
      }),
    ).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '24', GATE_LOCK_SLOTS: '24' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '64', GATE_LOCK_SLOTS: '64' }, { nproc: '8' })).toBe(true);
  });

  it('T85 7 and 4 are refused (28 over 24); 6 and 5 are refused (30 over 24)', () => {
    for (const [s, w] of [
      ['7', '4'],
      ['6', '5'],
      ['25', '1'],
      ['1', '25'],
    ]) {
      refusal(
        run({ GATE_HOST_SLOTS: s, GATE_HOST_WORKERS: w, GATE_LOCK_WORKERS: w, GATE_LOCK_SLOTS: s })
          .r,
        `GATE_HOST_SLOTS=${s}`,
        `GATE_HOST_WORKERS=${w}`,
        '24 processors',
      );
    }
  });

  it('T85 the boundary is exact: slots times workers equal to the processors is accepted', () => {
    expect(ok({ GATE_HOST_SLOTS: '3', GATE_HOST_WORKERS: '8', GATE_LOCK_SLOTS: '3' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '4', GATE_HOST_WORKERS: '8', GATE_LOCK_SLOTS: '4' })).toBe(false);
  });

  it('V13 a huge worker digit string cannot overflow the arithmetic: it is refused, not accepted', () => {
    refusal(
      run({ GATE_HOST_SLOTS: '2', GATE_HOST_WORKERS: '99999999999999999999', GATE_LOCK_SLOTS: '2' })
        .r,
      'GATE_HOST_SLOTS=2',
      '24 processors',
    );
  });

  it('T85 a non-numeric processor count refuses with the query, the pair and "checked against"', () => {
    const r = refusal(
      run({ GATE_HOST_SLOTS: '6', GATE_HOST_WORKERS: '4', GATE_LOCK_SLOTS: '6' }, { nproc: 'x' }).r,
      'getconf _NPROCESSORS_ONLN',
      'GATE_HOST_SLOTS=6 with GATE_HOST_WORKERS=4',
      'checked against',
    );
    expect(r.stderr).not.toContain('derive');
  });

  it('V14 GATE_HOST_SLOTS alone does not consult the processor count at all', () => {
    expect(ok({ GATE_HOST_SLOTS: '6', GATE_LOCK_SLOTS: '6' }, { nproc: 'x' })).toBe(true);
  });
});

describe('T87-T89 disagreement and worker agreement (V9, V15, V16, V17)', () => {
  it('T87 a project count of 3 beside GATE_HOST_SLOTS=6 is refused; the pool holds only .format', () => {
    const { r, pool } = run({
      GATE_HOST_SLOTS: '6',
      GATE_HOST_WORKERS: '4',
      GATE_LOCK_WORKERS: '4',
      GATE_LOCK_SLOTS: '3',
    });
    refusal(r, 'GATE_LOCK_SLOTS=3', 'GATE_HOST_SLOTS=6', pool);
    expect(listing(pool, { modes: false })).toEqual(['.format']);
  });

  it('V15 with no host count (V12) the project count is the pool count and there is nothing to disagree with', () => {
    expect(ok({ GATE_LOCK_SLOTS: '3' })).toBe(true);
  });

  it('V15 numerically equal spellings agree', () => {
    expect(ok({ GATE_HOST_SLOTS: '06', GATE_LOCK_SLOTS: '6' })).toBe(true);
    expect(ok({ GATE_HOST_SLOTS: '6', GATE_LOCK_SLOTS: '006' })).toBe(true);
  });

  it('T88 a project worker cap of 3 against the host 4 is refused naming both; 4 and 4 with slots 6 is fine', () => {
    refusal(
      run({ GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '3', GATE_LOCK_SLOTS: '6' }).r,
      'GATE_LOCK_WORKERS=3',
      'GATE_HOST_WORKERS=4',
      'one decision',
    );
    expect(ok({ GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '4', GATE_LOCK_SLOTS: '6' })).toBe(true);
  });

  it('T89 04 beside 4 is one cap; 3 beside 4 is refused; host 04 beside project 4 is accepted', () => {
    const r = run({ GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '04', GATE_LOCK_SLOTS: '6' }).r;
    expect(accepted(r)).toBe(true);
    refusal(
      run({ GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '3', GATE_LOCK_SLOTS: '6' }).r,
      'GATE_LOCK_WORKERS',
      'GATE_HOST_WORKERS',
    );
    expect(ok({ GATE_HOST_WORKERS: '04', GATE_LOCK_WORKERS: '4', GATE_LOCK_SLOTS: '6' })).toBe(
      true,
    );
  });

  it('V9 huge equal-by-number spellings agree with no arithmetic', () => {
    expect(
      ok({
        GATE_HOST_WORKERS: '000100000000000000000000',
        GATE_LOCK_WORKERS: '100000000000000000000',
        GATE_LOCK_SLOTS: '1',
      }),
    ).toBe(true);
    refusal(
      run({
        GATE_HOST_WORKERS: '100000000000000000000',
        GATE_LOCK_WORKERS: '100000000000000000001',
        GATE_LOCK_SLOTS: '1',
      }).r,
      'GATE_LOCK_WORKERS=100000000000000000001',
    );
  });

  it('D22 an EMPTY GATE_LOCK_WORKERS is refused (never falls through), with or without a host value', () => {
    for (const host of [undefined, '', '4']) {
      const r = run({ GATE_LOCK_WORKERS: '', GATE_HOST_WORKERS: host, GATE_LOCK_SLOTS: '1' }).r;
      refusal(r, 'GATE_LOCK_WORKERS must be a positive whole number', "got ''", 'GATE_LOCK_SLOTS');
    }
  });

  it('D22 an unusable GATE_LOCK_WORKERS (0, x, 4.5, spaces, 0x4, -1) is refused even with no host value', () => {
    for (const v of ['0', 'x', '4.5', ' 4 ', '0x4', '-1', '00']) {
      refusal(
        run({ GATE_LOCK_WORKERS: v, GATE_HOST_WORKERS: undefined, GATE_LOCK_SLOTS: '1' }).r,
        'GATE_LOCK_WORKERS must be a positive whole number',
        `got '${v}'`,
      );
    }
  });

  it('V9 a valid GATE_LOCK_WORKERS alone (no host value) is accepted and not compared to the processors', () => {
    expect(ok({ GATE_LOCK_WORKERS: '4', GATE_HOST_WORKERS: undefined, GATE_LOCK_SLOTS: '1' })).toBe(
      true,
    );
    expect(
      ok({ GATE_LOCK_WORKERS: '48', GATE_HOST_WORKERS: undefined, GATE_LOCK_SLOTS: '1' }),
    ).toBe(true);
  });

  it('V16 order: stale threshold, then worker agreement, then counts, then budget, then disagreement', () => {
    const bad = { GATE_LOCK_STALE_SECONDS: '5' };
    const workers = { GATE_HOST_WORKERS: '4', GATE_LOCK_WORKERS: '3' };
    const count = { GATE_HOST_SLOTS: '65' };
    const budget = { GATE_HOST_SLOTS: '7', GATE_HOST_WORKERS: '4' };
    const disagree = { GATE_HOST_SLOTS: '6', GATE_LOCK_SLOTS: '5' };
    expect(refusal(run({ ...bad, ...workers, ...count }).r).stderr).toContain(
      'GATE_LOCK_STALE_SECONDS',
    );
    expect(refusal(run({ ...workers, ...count }).r).stderr).toContain('GATE_LOCK_WORKERS=3');
    expect(
      refusal(
        run({ ...budget, GATE_HOST_SLOTS: '65', GATE_LOCK_WORKERS: '4', GATE_LOCK_SLOTS: '5' }).r,
      ).stderr,
    ).toContain('GATE_HOST_SLOTS must be at most 64');
    expect(
      refusal(run({ ...budget, GATE_LOCK_SLOTS: '1', GATE_LOCK_WORKERS: '4' }).r).stderr,
    ).toContain('24 processors');
    expect(refusal(run({ ...disagree }).r).stderr).toContain('does not match');
  });

  it('V17 the host count wins in a pool: a disagreeing project count is refused, not obeyed', () => {
    const r = refusal(
      run({ GATE_HOST_SLOTS: '2', GATE_LOCK_SLOTS: '9' }).r,
      'GATE_LOCK_SLOTS=9',
      'GATE_HOST_SLOTS=2',
    );
    expect(r.stderr).toContain('does not match');
  });
});

describe('T90 stale threshold (V20, F36, D5)', () => {
  it('T90 60 is refused under a pool naming the variable, the value and 600s', () => {
    refusal(run({ GATE_LOCK_STALE_SECONDS: '60' }).r, 'GATE_LOCK_STALE_SECONDS=60', '600s');
  });

  it('T90 600 and above are accepted; unset and empty default to 600', () => {
    for (const v of ['600', '0600', '601', '3600', '0000000000600', '9999999999', undefined, '']) {
      expect(ok({ GATE_LOCK_STALE_SECONDS: v }), String(v)).toBe(true);
    }
  });

  it('F36 non-digits are refused naming the variable', () => {
    for (const v of ['x', '60.5', '-600', ' 600', '600 ', '0x258', '+600', '6e2']) {
      refusal(
        run({ GATE_LOCK_STALE_SECONDS: v }).r,
        'GATE_LOCK_STALE_SECONDS must be a whole number of seconds',
        `'${v}'`,
      );
    }
  });

  it('D5 more than 10 digits (after stripping zeros) is refused with exit 2 naming the variable', () => {
    for (const v of ['12345678901', '99999999999999999999']) {
      refusal(run({ GATE_LOCK_STALE_SECONDS: v }).r, 'GATE_LOCK_STALE_SECONDS');
    }
  });

  it('D5 bounds on a spec-bounded input follow the spec: V7 takes 3+ digits, only stale/heartbeat use the 10-digit guard', () => {
    expect(ok({ GATE_HOST_WORKERS: '99999999999999999999', GATE_LOCK_SLOTS: '1' })).toBe(true);
  });
});

describe('heartbeat period (D5)', () => {
  it('unset, empty and 1 and up are accepted', () => {
    for (const v of [undefined, '', '1', '60', '0060', '3600']) {
      expect(ok({ GATE_LOCK_HEARTBEAT_SECONDS: v }), String(v)).toBe(true);
    }
  });

  it('0, non-digits and more than 10 digits are refused naming the variable', () => {
    for (const v of ['0', '00', 'x', '1.5', '-1', ' 5', '12345678901']) {
      refusal(run({ GATE_LOCK_HEARTBEAT_SECONDS: v }).r, 'GATE_LOCK_HEARTBEAT_SECONDS');
    }
  });

  it('a bad heartbeat period is a configuration refusal for every subcommand, before the usage check', () => {
    for (const args of [['status'], ['acquire'], ['frobnicate'], []]) {
      const pool = freshPool();
      refusal(
        cfg({ GATE_LOCK_DIR: pool, GATE_LOCK_HEARTBEAT_SECONDS: 'x' }, args),
        'GATE_LOCK_HEARTBEAT_SECONDS',
      );
    }
  });
});

describe('C1/D9 configuration is resolved once, for every subcommand, before the usage check', () => {
  it('C1 a bad stale threshold on a bare acquire is the threshold, not the missing caller pid', () => {
    const pool = freshPool();
    refusal(
      cfg({ GATE_LOCK_DIR: pool, GATE_LOCK_STALE_SECONDS: 'x' }, ['acquire', 'lane']),
      'GATE_LOCK_STALE_SECONDS',
    );
  });

  it('D9 configuration refusals precede the usage error for every subcommand shape', () => {
    for (const args of [[], ['frobnicate'], ['status', 'extra'], ['acquire'], ['run']]) {
      refusal(
        cfg({ GATE_LOCK_DIR: freshPool(), GATE_HOST_SLOTS: '65' }, args),
        'GATE_HOST_SLOTS must be at most 64',
      );
    }
  });

  it('after configuration resolves every subcommand runs on its own terms (usage, caller pid, status, clean, not built yet)', () => {
    for (const args of [
      [],
      ['acquire', 'x'],
      ['status'],
      ['run', 'x', '--', 'true'],
      ['clean'],
      ['frobnicate'],
    ]) {
      const pool = freshPool();
      expect(accepted(cfg({ GATE_LOCK_DIR: pool }, args)), args.join(' ')).toBe(true);
    }
  });

  it('--format, --version and workers do not resolve pool configuration', () => {
    for (const args of [['--format'], ['--version'], ['workers']]) {
      const r = cfg({ GATE_HOST_SLOTS: '65', GATE_LOCK_STALE_SECONDS: 'x' }, args);
      expect(r.status).toBe(0);
    }
    expect(fs.existsSync('/nonexistent-gate-lock-poison')).toBe(false);
  });

  it('F17 a count refusal still leaves the correctly marked pool behind', () => {
    const { r, pool } = run({ GATE_HOST_SLOTS: '65' });
    expect(r.status).toBe(2);
    expect(fs.readFileSync(path.join(pool, '.format'), 'utf8')).toBe('1\n');
  });
});
