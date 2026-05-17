import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    setupFiles: ['./tests/integration/test-env.ts'],
    // Run serially so DB state doesn't bleed across tests in teardown
    // Files run in parallel; within each file tests run serially (DB state is per-describe)
    poolOptions: { threads: { singleThread: false } },
  },
})
