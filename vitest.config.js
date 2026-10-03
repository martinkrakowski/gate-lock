import { defineConfig } from 'vitest/config';

// Most tests spawn the shell tool several times (each run walks the pool
// directory rules), so loops over many inputs need more than the 5 s default,
// especially on a loaded CI runner.
export default defineConfig({
  test: { testTimeout: 60000, hookTimeout: 60000 },
});
