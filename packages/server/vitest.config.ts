import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-socket suites with 40ms phase clocks are contention-sensitive:
    // parallel test files starve each other's timers on small CI runners.
    fileParallelism: false,
  },
});
