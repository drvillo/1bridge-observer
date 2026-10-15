import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/scale.benchmark.ts'], testTimeout: 600_000 },
})
