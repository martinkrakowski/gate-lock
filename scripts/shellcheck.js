// Runs shellcheck on bin/gate-lock when shellcheck is installed.
// CI installs it, so a missing binary is only tolerated outside CI.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../bin/gate-lock', import.meta.url));
const probe = spawnSync('shellcheck', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  if (process.env.CI) {
    console.error('shellcheck is required in CI but was not found');
    process.exit(1);
  }
  console.log('shellcheck not installed; skipping');
  process.exit(0);
}
const run = spawnSync('shellcheck', ['--shell=sh', target], { stdio: 'inherit' });
process.exit(run.status ?? 1);
