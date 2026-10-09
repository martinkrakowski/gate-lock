import { defineConfig } from 'vitest/config';

// Most tests spawn the shell tool several times (each run walks the pool
// directory rules), so loops over many inputs need more than the 5 s default,
// especially on a loaded CI runner.
//
// Under CI every wait in the suite is allowed three times its written deadline
// (test/wait-scale.js), so a test's own limit grows by the same factor: a test
// must not be cut off while a handshake it is entitled to wait for is pending.
const scale =
  Number(process.env.GATE_LOCK_TEST_WAIT_SCALE) >= 1
    ? Number(process.env.GATE_LOCK_TEST_WAIT_SCALE)
    : process.env.CI
      ? 3
      : 1;

export default defineConfig({
  test: { testTimeout: 60000 * scale, hookTimeout: 60000 * scale },
});
