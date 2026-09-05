import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 45_000,
    fileParallelism: false,
  },
});
