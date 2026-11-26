import { Terminal } from '@xterm/xterm'
import { expect, test } from 'vitest'
import { keepsScreenOnClear } from '../../src/renderer/nodes/terminalOptions'

/** What a fresh ConPTY shell sends first, as captured from cmd.exe: clear the screen, go home, then paint it. */
const CONPTY_START = '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;cmd.exe\x07\x1b[?25h\x1b[?25l\x1b[3;1HC:\\work>\x1b[?25h'
/** A terminal's restored output and the divider (lifecycle.ts restoreSeed), as a restart or reopen seeds it. */
const SEED = 'npm test\r\n  PASS  src/a.test.ts\r\n  FAIL  src/b.test.ts\r\n\x1b[?1049l\x1b[?25h\x1b[0m\r\n\x1b[2m--- the old process ended; this is a new shell ---\x1b[0m\r\n'

const lines = async (kind: 'terminal' | 'run' | 'claude'): Promise<string[]> => {
  const term = new Terminal({ rows: 10, cols: 60, allowProposedApi: true, scrollOnEraseInDisplay: keepsScreenOnClear(kind) })
  await new Promise<void>((done) => term.write(SEED + CONPTY_START, done))
  const b = term.buffer.active
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
}

// Restored output was painted over: the new shell's first frame clears the screen, which held all of a short output.
test('a terminal or run keeps its restored output and the divider above the new shell', async () => {
  for (const kind of ['terminal', 'run'] as const) {
    const text = (await lines(kind)).join('\n')
    expect(text).toContain('FAIL  src/b.test.ts')
    expect(text).toContain('--- the old process ended; this is a new shell ---')
    expect(text).toContain('C:\\work>')
  }
})

test('an agent window is left as it was: its program draws its own screen', () => {
  expect(keepsScreenOnClear('claude')).toBe(false)
})
