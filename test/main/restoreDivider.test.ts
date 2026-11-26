import { Terminal } from '@xterm/xterm'
import { expect, test } from 'vitest'
import { restoreSeed, RUN_DIVIDER } from '../../src/main/lifecycle'

const screen = async (data: string): Promise<string[]> => {
  const term = new Terminal({ rows: 14, cols: 70, allowProposedApi: true })
  await new Promise<void>((done) => term.write(data, done))
  const b = term.buffer.active
  return Array.from({ length: b.length }, (_, i) => (b.getLine(i)?.translateToString(true) ?? '').trimEnd()).filter(Boolean)
}

/** A shell's saved output as the scene captured it: no full-screen program, the cursor on the last prompt. */
const SHELL = 'you@patchbay /tmp/w\r\n$ echo short-output-77\r\nshort-output-77\r\nyou@patchbay /tmp/w\r\n$ '

// The divider was written over the second line: leaving a full-screen program also put the cursor back where it was
// saved, the top left when none had run.
test('the divider follows the saved output, after its last line', async () => {
  expect(await screen(restoreSeed('terminal', SHELL)!)).toEqual([
    'you@patchbay /tmp/w',
    '$ echo short-output-77',
    'short-output-77',
    'you@patchbay /tmp/w',
    '$',
    '--- the old process ended; this is a new shell ---'
  ])
  expect(await screen(`${SHELL}${RUN_DIVIDER}`)).toContain('$ echo short-output-77')
})

test('output saved while a full-screen program ran still comes back to the shell it left, then the divider', async () => {
  const seeded = await screen(restoreSeed('terminal', '$ vim notes.md\r\n\x1b[?1049h\x1b[Hvim screen\x1b[10;1H~')!)
  expect(seeded).toEqual(['$ vim notes.md', '--- the old process ended; this is a new shell ---'])
})
