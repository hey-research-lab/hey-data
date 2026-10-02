import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
