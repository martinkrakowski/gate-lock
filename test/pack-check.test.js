import { describe, expect, it } from 'vitest';
import { EXPECTED_FILES, checkPack } from '../scripts/pack-check.js';

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
});
