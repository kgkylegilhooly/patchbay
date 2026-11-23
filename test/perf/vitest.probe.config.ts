import { defineConfig } from 'vitest/config'

/** The performance probes in this folder, run on purpose only: they take a while and write results to a file. */
export default defineConfig({
  test: {
    include: ['test/perf/*.probe.ts'],
    environment: 'node',
    fileParallelism: false,
    // One at a time, so the numbers aren't each other's noise.
    sequence: { concurrent: false }
  }
})
