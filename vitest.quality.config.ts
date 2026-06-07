import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/quality/**/*.test.ts'],
    setupFiles: ['tests/quality/env-setup.ts'],
    // Live Pro calls (generation + judge) per scenario, each wrapped in quota
    // backoff-retry — a throttled scenario can wait minutes before succeeding.
    //
    // Retry-budget math (worst case, full 3-sample run under heavy throttling):
    //   Each sample runs two bounded backoff chains, both at base 6000ms × 2^attempt:
    //     generation (GEN_RETRIES=3):     6 + 12 + 24 = 42s of backoff
    //     judge (withQuotaRetry retries=3): 6 + 12 + 24 = 42s of backoff
    //   → ~84s backoff/sample × QUALITY_SAMPLES=3 ≈ 252s, plus per-call latency.
    // 1_200_000 (20 min) leaves ~4× headroom over the backoff budget so a throttled
    // run completes instead of dying at a per-test timeout. The retry counts above
    // are bounded precisely so SAMPLES × (gen + judge backoff) stays well under this.
    testTimeout: 1_200_000,
    hookTimeout: 60_000,
  },
})
