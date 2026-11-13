import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // ~39 suites boot an in-process PGlite DB and apply every migration in
    // beforeAll: a fixed cold-start cost that can pass the 10s default under
    // load (parallel runs, busy CI runners). Boot cost, not a hang — test
    // timeouts stay at the default.
    hookTimeout: 30_000,
  },
});
