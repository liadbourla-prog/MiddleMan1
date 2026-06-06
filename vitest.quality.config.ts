import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/quality/**/*.test.ts'],
    setupFiles: ['tests/quality/env-setup.ts'],
    // Live Pro calls (generation + judge) per scenario, each wrapped in quota
    // backoff-retry — a throttled scenario can wait minutes before succeeding.
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
})
