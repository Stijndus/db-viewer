import { defineConfig } from 'vitest/config';

// Tests for the Electron main process (Node environment). Angular tests run via `ng test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.spec.ts'],
    testTimeout: 15_000,
  },
});
