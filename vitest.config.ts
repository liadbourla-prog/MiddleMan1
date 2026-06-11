import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    include: ['tests/**/*.test.ts', 'src/skills/**/*.test.ts', 'src/domain/**/*.test.ts', 'src/routes/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/quality/**'],
  },
})
