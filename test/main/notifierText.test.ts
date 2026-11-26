import { afterEach, expect, test, vi } from 'vitest'
import { createNotifier, headline } from '../../src/main/notifier'

afterEach(() => {
  vi.useRealTimers()
})

// F40: a notification that says what happened, so it's worth reading without clicking through.
test('a finished turn says the first line of the reply, and a wait says what is asked', async () => {
  const show = vi.fn()
  const notifier = createNotifier({
    show,
    windowFocused: () => false,
    titleOf: (id) => id,
    reveal: () => {},
    detail: async (id, status) => (status === 'idle' ? 'Added the tests; all 42 pass.' : id === 'asks' ? 'Bash: npm publish' : null)
  })
  notifier.notify('done', 'idle')
  notifier.notify('asks', 'needs-you')
  notifier.notify('plain', 'needs-you')
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(3))
  expect(show.mock.calls.map((c) => c[0].body)).toEqual(['Finished: Added the tests; all 42 pass.', 'Needs you: Bash: npm publish', 'Needs you.'])
})

test('a detail that fails or takes too long leaves the plain words, and the chime never waits for it', async () => {
  vi.useFakeTimers()
  const show = vi.fn()
  const alert = vi.fn()
  const notifier = createNotifier({
    show,
    alert,
    windowFocused: () => false,
    titleOf: (id) => id,
    reveal: () => {},
    detail: (id) => (id === 'broken' ? Promise.reject(new Error('no transcript')) : new Promise<string>(() => {}))
  })
  notifier.notify('broken', 'idle')
  notifier.notify('slow', 'needs-you')
  expect(alert).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(show.mock.calls.map((c) => c[0].body).sort()).toEqual(['Finished its turn.', 'Needs you.'])
})

test('a reply becomes one plain line: Markdown marks and code left out, cut at a word', () => {
  expect(headline('## Done\n\nAll **tests** pass.')).toBe('Done')
  expect(headline('```\nnpm test\n```\n- Fixed `parseDate` for _UTC_ input')).toBe('Fixed parseDate for UTC input')
  expect(headline('> quoted   line\twith  spaces')).toBe('quoted line with spaces')
  expect(headline('word '.repeat(60))).toMatch(/^(word ){20,}word…$/)
  expect(headline('word '.repeat(60))?.length).toBeLessThanOrEqual(141)
  expect(headline('```\nonly code\n```')).toBeNull()
  expect(headline('   ')).toBeNull()
})
