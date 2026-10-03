// Asserts that `npm pack` would publish exactly the expected files.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_FILES = [
  'LICENSE',
  'README.md',
  'bin/gate-lock',
  'package.json',
  'src/index.d.ts',
  'src/index.js',
];

/** Compare an `npm pack --dry-run --json` payload against the expected list. */
export function checkPack(json, expected = EXPECTED_FILES) {
  const files = JSON.parse(json)[0]
    .files.map((f) => f.path)
    .sort();
  const want = [...expected].sort();
  const missing = want.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !want.includes(f));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const run = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(run.stderr);
    process.exit(1);
  }
  const result = checkPack(run.stdout);
  if (!result.ok) {
    console.error('npm pack file list mismatch');
    console.error(`  missing: ${result.missing.join(', ') || '-'}`);
    console.error(`  extra:   ${result.extra.join(', ') || '-'}`);
    process.exit(1);
  }
  console.log('npm pack file list ok');
}
