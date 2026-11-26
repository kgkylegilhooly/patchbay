import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { TranscriptMessage } from '../../src/core/transcript/read'
import { conversationMarkdown, createConversationSaver, revealTranscript } from '../../src/main/conversation'
import { memoryStore } from '../control/fakes'

// F28: what an agent and the person said, kept as a Markdown file, and the raw transcript one click away.
const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const agent = (over: Record<string, unknown> = {}) => ({ ...box, id: 'a', kind: 'claude', title: 'Parser tests', cwd: 'C:\\w', prompt: '', sessionId: 's', transcriptPath: 'C:\\t.jsonl', after: [], ...over }) as never
const at = new Date(2026, 10, 26, 9, 5)

const said: TranscriptMessage[] = [
  { role: 'user', text: 'Fix the parser' },
  { role: 'assistant', text: "I'll run the tests first.", commentary: true },
  { role: 'assistant', text: 'Done: **3 tests** pass.\n' },
  { role: 'assistant', text: '   ' }
]

test('the Markdown names the window, its folder and when, then each message under who said it', () => {
  expect(conversationMarkdown({ title: 'Parser tests', cwd: 'C:\\w', agent: 'claude' }, said, at)).toBe(
    [
      '# Parser tests',
      '',
      'Conversation with Claude Code in `C:\\w`, saved from Patchbay on 2026-11-26 09:05.',
      '',
      '## You',
      '',
      'Fix the parser',
      '',
      '## Claude Code (on the way)',
      '',
      "I'll run the tests first.",
      '',
      '## Claude Code',
      '',
      'Done: **3 tests** pass.',
      ''
    ].join('\n')
  )
  expect(conversationMarkdown({ title: 'x', cwd: 'C:\\w', agent: 'codex' }, said, at)).toContain('## Codex\n')
})

function saver(over: { pick?: string | null; read?: () => Promise<TranscriptMessage[]>; nodes?: never[] } = {}) {
  const writes: { path: string; text: string; exclusive: boolean }[] = []
  const asked: string[] = []
  const save = createConversationSaver({
    store: memoryStore(over.nodes ?? [agent()]),
    home: 'C:\\Users\\me',
    system: ['C:\\Windows'],
    now: () => at,
    read: over.read ?? (async () => said),
    async pickFile(defaultPath) {
      asked.push(defaultPath)
      return over.pick === undefined ? 'C:\\w\\notes\\parser.md' : over.pick
    },
    async writeFile(path, text, exclusive) {
      writes.push({ path, text, exclusive })
    }
  })
  return { save, writes, asked }
}

test("saving asks where, starting in the agent's folder, and writes the Markdown there", async () => {
  const s = saver()
  expect(await s.save('a')).toEqual({ ok: true, path: 'C:\\w\\notes\\parser.md', messages: 3 })
  expect(s.asked).toEqual([join('C:\\w', 'parser-tests-conversation.md')])
  expect(s.writes).toHaveLength(1)
  expect(s.writes[0]).toMatchObject({ path: 'C:\\w\\notes\\parser.md', exclusive: false })
  expect(s.writes[0].text).toMatch(/^# Parser tests\n/)
})

test('a name typed without .md gets it, and then never replaces a file the dialog did not ask about', async () => {
  const s = saver({ pick: 'C:\\w\\parser' })
  expect(await s.save('a')).toMatchObject({ ok: true, path: 'C:\\w\\parser.md' })
  expect(s.writes[0].exclusive).toBe(true)
})

test('it says why when there is nothing to save, the person cancels, or the place is not allowed', async () => {
  expect(await saver({ nodes: [agent({ transcriptPath: null })] }).save('a')).toEqual({ ok: false, reason: 'Parser tests has no conversation yet.' })
  expect(await saver({ nodes: [agent({ kind: 'terminal' })] }).save('a')).toEqual({ ok: false, reason: 'That window is not an agent.' })
  expect(await saver({ read: async () => [] }).save('a')).toEqual({ ok: false, reason: 'Parser tests has no messages to save yet.' })
  expect(await saver({ read: async () => Promise.reject(new Error('gone')) }).save('a')).toEqual({ ok: false, reason: "Couldn't read the conversation of Parser tests." })
  const cancelled = saver({ pick: null })
  expect(await cancelled.save('a')).toEqual({ ok: false, cancelled: true, reason: 'Not saved.' })
  expect(cancelled.writes).toEqual([])
  const system = saver({ pick: 'C:\\Windows\\x.md' })
  expect((await system.save('a')).ok).toBe(false)
  expect(system.writes).toEqual([])
})

test('Reveal transcript shows the file in Explorer, or says why not', () => {
  const shown: string[] = []
  const reveal = (p: string) => void shown.push(p)
  expect(revealTranscript(memoryStore([agent()]), 'a', reveal, () => true)).toEqual({ ok: true })
  expect(shown).toEqual(['C:\\t.jsonl'])
  expect(revealTranscript(memoryStore([agent()]), 'a', reveal, () => false)).toEqual({ ok: false, reason: 'The transcript of Parser tests is no longer on disk.' })
  expect(revealTranscript(memoryStore([agent({ transcriptPath: null })]), 'a', reveal, () => true)).toEqual({ ok: false, reason: 'Parser tests has no conversation yet.' })
  expect(shown).toHaveLength(1)
})
