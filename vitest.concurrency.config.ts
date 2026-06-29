import { defineConfig } from 'vitest/config'

// WS1 merge-gate concurrency harness config. Runs ONLY the tests/concurrency/** suite,
// which require a REAL ephemeral Postgres (booted by scripts/run-concurrency-harness.sh)
// with DATABASE_URL already in the process env before vitest starts. Never point this at
// a shared/prod DB — the cases create and tear down real rows under contention.
//
// Single-fork, non-parallel: each case manages its OWN postgres connections via raceN and
// runs a ~30× flakiness loop, so files must not fight each other for the same cluster.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    include: ['tests/concurrency/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Force serial execution: one file at a time, one fork, no worker parallelism. The
    // races deliberately contend at the DB layer; we do not want vitest also interleaving
    // unrelated suites against the same ephemeral cluster.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
})
