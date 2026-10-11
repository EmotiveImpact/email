import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file shares one real Postgres database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
