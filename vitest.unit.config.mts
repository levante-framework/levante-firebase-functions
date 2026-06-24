import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['functions/levante-admin/src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 20000,
  },
});
