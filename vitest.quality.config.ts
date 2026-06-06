import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/quality/**/*.test.ts'],
    setupFiles: ['tests/quality/env-setup.ts'],
    // Live Pro calls (generation + judge) per scenario — generous timeouts.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
