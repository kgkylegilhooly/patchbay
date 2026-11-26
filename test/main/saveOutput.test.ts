import { expect, test } from 'vitest'
import { createOutputSaver, outputText } from '../../src/main/saveOutput'
import { memoryStore } from '../control/fakes'

// F43: a build log or a terminal session kept as a text file, without select-all and paste.
const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const shell = (over: Record<string, unknown> = {}) => ({ ...box, id: 't', kind: 'terminal', title: 'Dev shell', cwd: 'C:\\w', ...over }) as never
const run = { ...box, id: 'r', kind: 'run', title: 'npm test', cwd: 'C:\\w', command: 'npm test' } as never
const agent = { ...box, id: 'a', kind: 'claude', title: 'Agent', cwd: 'C:\\w', sessionId: null, transcriptPath: null, after: [] } as never

test('output as plain text: colours and controls gone, a redrawn line kept as its last frame, Windows line ends', () => {
  const raw = '\x1b[32mPASS\x1b[0m src/a.test.ts\r\n' + 'Downloading 10%\rDownloading 55%\rDownloading 100%\r\n' + '\x1b]0;title\x07done   \r\n\r\n\r\n'
  expect(outputText(raw)).toBe('PASS src/a.test.ts\r\nDownloading 100%\r\ndone\r\n')
  expect(outputText('\x1b[2J\x1b[H   \r\n')).toBe('')
  expect(outputText('\r\n\r\n$ ls\r\n\r\n\r\n\r\na.txt\r\n\r\n')).toBe('$ ls\r\n\r\na.txt\r\n')
})

function saver(over: { nodes?: never[]; output?: string; pick?: string | null } = {}) {
  const writes: { path: string; text: string; exclusive: boolean }[] = []
  const asked: string[] = []
  const save = createOutputSaver({
    store: memoryStore(over.nodes ?? [shell(), run, agent]),
    home: 'C:\\Users\\me',
    system: ['C:\\Windows'],
    output: async () => over.output ?? 'hello\r\n',
    async pickFile(defaultPath) {
      asked.push(defaultPath)
      return over.pick === undefined ? 'C:\\w\\logs\\shell.txt' : over.pick
    },
    async writeFile(path, text, exclusive) {
      writes.push({ path, text, exclusive })
    }
  })
  return { save, writes, asked }
}

test('a terminal or run window saves its output where the person picks, as .txt', async () => {
  const s = saver()
  expect(await s.save('t')).toEqual({ ok: true, path: 'C:\\w\\logs\\shell.txt', lines: 1 })
  expect(s.asked).toEqual(['C:\\w\\dev-shell-output.txt'])
  expect(s.writes).toEqual([{ path: 'C:\\w\\logs\\shell.txt', text: 'hello\r\n', exclusive: false }])
  // A name given without .txt gets it, and then never replaces a file the dialog didn't ask about.
  const named = saver({ pick: 'C:\\w\\build' })
  expect(await named.save('r')).toMatchObject({ ok: true, path: 'C:\\w\\build.txt' })
  expect(named.writes[0].exclusive).toBe(true)
})

test('an agent, no output, a cancel or a system folder saves nothing and says why', async () => {
  expect(await saver().save('a')).toMatchObject({ ok: false, reason: 'Only a terminal or run window has output to save.' })
  expect(await saver({ output: '\x1b[0m  \r\n' }).save('t')).toMatchObject({ ok: false, reason: 'Dev shell has no output to save yet.' })
  expect(await saver({ pick: null }).save('t')).toMatchObject({ ok: false, cancelled: true })
  const system = saver({ pick: 'C:\\Windows\\out.txt' })
  expect((await system.save('t')).ok).toBe(false)
  expect(system.writes).toEqual([])
})
