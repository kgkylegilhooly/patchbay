import { afterEach, expect, test, vi } from 'vitest'
import { createSubagentWatcher, type WatchedParent } from '../../src/main/subagents/watcher'

afterEach(() => vi.useRealTimers())

// A window that starts a turn after a quiet spell: its first subagent's card came up to 8 s late, as the watcher kept
// the slowest pace until its own next look, though the status change had already brought it a look.
test('a status change that finds a window busy brings the looks back to every second at once', async () => {
  vi.useFakeTimers()
  let busy = false
  let looks = 0
  // Ended as soon as it's busy, so a look never reaches the disk, which fake time can't wait for. The pace is the same.
  const parents = (): WatchedParent[] => (looks++, [{ nodeId: 'a', transcriptPath: 'C:\nowhere\s.jsonl', busy, exited: busy }])
  const watcher = createSubagentWatcher({ parents, push: () => {}, everyMs: 1000 })
  try {
    // Quiet for a while: the looks slow to one every 8 s.
    await vi.advanceTimersByTimeAsync(60_000)
    const quiet = looks
    await vi.advanceTimersByTimeAsync(8_000)
    expect(looks - quiet).toBe(1)
    // The window goes to work, and the status change asks for a look (setup.ts).
    busy = true
    await watcher.tick()
    const after = looks
    await vi.advanceTimersByTimeAsync(3_000)
    expect(looks - after).toBeGreaterThanOrEqual(2)
  } finally {
    watcher.close()
  }
})
