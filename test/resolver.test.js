// GL1: the worker-cap resolver (spec 6.J, V21-V28, D22), as the JS export and
// as `gate-lock workers`, checked against one shared table.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMaxWorkers } from '../src/index.js';
import { REPO_ROOT, runBin } from './harness.js';
import { TM } from './cfg.js';

const W = 'GATE_LOCK_WORKERS';
const H = 'GATE_HOST_WORKERS';

// cap: a number, undefined for "no cap", or { refused: [substrings] }.
// Every row runs with 24 processors, through the library and the CLI.
const TABLE = [
  ['T94 nothing set: no cap', {}, undefined],
  ['T95 4 passes through', { [W]: '4' }, 4],
  ['T95 a count equal to the cpu count is accepted', { [W]: '24' }, 24],
  ['V25 a leading zero is a spelling: 04 is 4', { [W]: '04' }, 4],
  ['V25 many leading zeros: 0000024', { [W]: '0000024' }, 24],
  ['T96 0', { [W]: '0' }, { refused: [W, 'must be a positive whole number', "got '0'"] }],
  ['T96 00', { [W]: '00' }, { refused: [W, "got '00'"] }],
  ['T96 -1', { [W]: '-1' }, { refused: [W, "got '-1'"] }],
  ['T96 +4', { [W]: '+4' }, { refused: [W, "got '+4'"] }],
  ['T96 4.5', { [W]: '4.5' }, { refused: [W, "got '4.5'"] }],
  ['T96 1e1', { [W]: '1e1' }, { refused: [W, "got '1e1'"] }],
  [
    'T96/T99 empty (set but empty)',
    { [W]: '' },
    { refused: [W, 'must be a positive whole number', "got ''"] },
  ],
  ['T96 x', { [W]: 'x' }, { refused: [W, "got 'x'"] }],
  ['T96 surrounding spaces', { [W]: ' 4 ' }, { refused: [W, "got ' 4 '"] }],
  ['T96 0x4', { [W]: '0x4' }, { refused: [W, "got '0x4'"] }],
  ['T96 a trailing newline', { [W]: '4\n' }, { refused: [W] }],
  ['T96 a non-ASCII digit', { [W]: '４' }, { refused: [W] }],
  [
    'T97 25 against 24',
    { [W]: '25' },
    { refused: [`${W}=25`, 'above this host', 'available parallelism (24)'] },
  ],
  [
    'V24 a 20-digit value is above, never wrapped',
    { [W]: '99999999999999999999' },
    { refused: [W, 'above this host'] },
  ],
  [
    'V24 a 30-digit value with leading zeros',
    { [W]: '000000000000000000000000000025' },
    { refused: [W, 'above this host'] },
  ],
  ['T98 the host variable is the cap when the project one is unset', { [H]: '4' }, 4],
  ['T98 the project variable wins; they are not compared', { [W]: '2', [H]: '4' }, 2],
  ['V26 not compared: project above host', { [W]: '8', [H]: '4' }, 8],
  ['T100 an empty host variable is unset', { [H]: '' }, undefined],
  ['T100 an empty host variable never displaces the project one', { [W]: '3', [H]: '' }, 3],
  ['T101 host 0', { [H]: '0' }, { refused: [H, 'must be a positive whole number', "got '0'"] }],
  ['T101 host 4.5', { [H]: '4.5' }, { refused: [H, "got '4.5'"] }],
  ['T101 host x', { [H]: 'x' }, { refused: [H, "got 'x'"] }],
  [
    'T101 host 25 against 24',
    { [H]: '25' },
    { refused: [`${H}=25`, 'available parallelism (24)'] },
  ],
  [
    'D22 empty project beside a valid host: refused, never falls through',
    { [W]: '', [H]: '4' },
    { refused: [W, "got ''"] },
  ],
  [
    'D22 unusable project beside a valid host: refused',
    { [W]: 'x', [H]: '4' },
    { refused: [W, "got 'x'"] },
  ],
  ['V22 a valid project value masks a broken host value', { [W]: '3', [H]: 'x' }, 3],
  [
    'V23 the project message points at the project slot variable',
    { [W]: '0' },
    { refused: ['GATE_LOCK_SLOTS', 'host-wide'] },
  ],
  [
    'V23 the host message points at the host slot variable',
    { [H]: '0' },
    { refused: ['GATE_HOST_SLOTS', 'host-wide'] },
  ],
  ['V24 project above cpus with a valid host', { [W]: '25', [H]: '4' }, { refused: [`${W}=25`] }],
];

function viaLibrary(env) {
  try {
    return { value: resolveMaxWorkers(env, 24) };
  } catch (e) {
    return { error: e.message };
  }
}

function viaCli(env) {
  const r = runBin(['workers'], {
    env: {
      ...TM,
      GATE_LOCK_TEST_NPROC: '24',
      GATE_LOCK_DIR: undefined,
      GATE_LOCK_SLOTS: undefined,
      ...env,
    },
  });
  return r;
}

describe('T94-T101 resolveMaxWorkers and `gate-lock workers` share one table', () => {
  for (const [title, env, want] of TABLE) {
    it(title, () => {
      const lib = viaLibrary(env);
      const cli = viaCli(env);
      if (want !== null && typeof want === 'object') {
        expect(lib.error, 'library refused').toBeTypeOf('string');
        for (const n of want.refused) {
          expect(lib.error).toContain(n);
        }
        expect(cli.status).toBe(2);
        expect(cli.stdout).toBe('');
        expect(cli.stderr).toBe(`gate-lock: ${lib.error}\n`);
      } else {
        expect(lib).toEqual({ value: want });
        expect(cli.status).toBe(0);
        expect(cli.stderr).toBe('');
        expect(cli.stdout).toBe(want === undefined ? '' : `${want}\n`);
      }
    });
  }

  it('the table covers both an accepted and a refused row for each variable (guard against a hollow table)', () => {
    const kinds = new Set(
      TABLE.map(([, env, want]) => `${Object.keys(env).join('+')}:${typeof want}`),
    );
    expect([...kinds].sort()).toEqual(
      [
        ':undefined',
        `${W}:number`,
        `${W}:object`,
        `${W}+${H}:number`,
        `${W}+${H}:object`,
        `${H}:number`,
        `${H}:object`,
        `${H}:undefined`,
      ].sort(),
    );
  });
});

describe('resolveMaxWorkers library behaviour', () => {
  it('T94 defaults its env to process.env and its cpu count to os.availableParallelism()', () => {
    const run = (env) =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { resolveMaxWorkers as r } from './src/index.js'; console.log(JSON.stringify(r() ?? null))",
        ],
        { cwd: REPO_ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
      ).trim();
    expect(run({})).toBe('null');
    expect(run({ [W]: '1' })).toBe('1');
    expect(run({ [H]: '1' })).toBe('1');
  });

  it('a key present with an undefined value counts as absent', () => {
    expect(resolveMaxWorkers({ [W]: undefined, [H]: '3' }, 24)).toBe(3);
    expect(resolveMaxWorkers({ [W]: undefined, [H]: undefined }, 24)).toBeUndefined();
  });

  it('never reads the environment it is not given', () => {
    expect(resolveMaxWorkers({}, 24)).toBeUndefined();
  });

  it('T102 runner wiring: the result is what a runner config puts into maxWorkers', () => {
    // a minimal stand-in for a runner config: maxWorkers is the resolver's result, and
    // JSON drops undefined, so "no cap" leaves the key out. The host variable is cleared
    // while the project one is stubbed (spec T102).
    const wire = (env) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import { resolveMaxWorkers as r } from './src/index.js'; console.log(JSON.stringify({ maxWorkers: r(process.env, 64) }))",
          ],
          { cwd: REPO_ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
        ),
      );
    expect(wire({ [W]: '1' })).toEqual({ maxWorkers: 1 });
    expect(wire({})).toEqual({});
    expect(wire({ [H]: '7' })).toEqual({ maxWorkers: 7 });
    expect(wire({ [W]: '2', [H]: '7' })).toEqual({ maxWorkers: 2 });
  });
});

describe('V28 gate-lock workers', () => {
  it('prints nothing and exits 0 when there is no cap, without touching any pool', () => {
    const r = runBin(['workers']); // the poison pool is in the env; it is never consulted
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('takes no arguments', () => {
    const r = runBin(['workers', 'x'], { env: { [W]: '1' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^gate-lock: usage/);
  });

  it('a non-numeric processor count is refused when a cap needs checking, and ignored when there is no cap', () => {
    const bad = { ...TM, GATE_LOCK_TEST_NPROC: 'x' };
    const r = runBin(['workers'], { env: { ...bad, [W]: '4' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^gate-lock: .*getconf _NPROCESSORS_ONLN/);
    expect(runBin(['workers'], { env: bad })).toMatchObject({ status: 0, stdout: '' });
  });

  it('uses the real processor count when no seam is set', () => {
    const r = runBin(['workers'], { env: { [W]: '1' } });
    expect(r).toMatchObject({ status: 0, stdout: '1\n' });
    const huge = runBin(['workers'], { env: { [W]: '999999' } });
    expect(huge.status).toBe(2);
    expect(huge.stderr).toContain('above this host');
  });

  it('is documented in the .d.ts export list', async () => {
    const fs = await import('node:fs');
    const dts = fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.d.ts'), 'utf8');
    expect(dts).toMatch(/resolveMaxWorkers/);
  });
});
