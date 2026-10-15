import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/poll.benchmark.ts'], testTimeout: 120_000 },
})
