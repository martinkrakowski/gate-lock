import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_FILES, checkPack } from '../scripts/pack-check.js';
import { REPO_ROOT, buildEnv, freshPool, scratchOf } from './harness.js';

const payload = (paths) => JSON.stringify([{ files: paths.map((path) => ({ path })) }]);

describe('scripts/pack-check', () => {
  it('accepts exactly the expected list, in any order', () => {
    expect(checkPack(payload([...EXPECTED_FILES].reverse())).ok).toBe(true);
  });
  it('reports a missing file', () => {
    const r = checkPack(payload(EXPECTED_FILES.slice(1)));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([EXPECTED_FILES[0]]);
  });
  it('reports an extra file', () => {
    const r = checkPack(payload([...EXPECTED_FILES, 'test/harness.js']));
    expect(r.ok).toBe(false);
    expect(r.extra).toEqual(['test/harness.js']);
  });
  it('runs as a script from a path containing a space', () => {
    const root = path.join(scratchOf(freshPool()), 'with space');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const f of [
      'package.json',
      'README.md',
      'LICENSE',
      'src/index.js',
      'src/index.d.ts',
      'bin/gate-lock',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, f), path.join(root, f));
    }
    const script = path.join(root, 'scripts', 'pack-check.js');
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'pack-check.js'), script);
    const r = spawnSync('node', [script], { cwd: root, env: buildEnv(), encoding: 'utf8' });
    expect(r.stdout).toBe('npm pack file list ok\n');
    expect(r.status).toBe(0);
  });
});
