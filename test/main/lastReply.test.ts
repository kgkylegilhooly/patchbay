import { expect, test, vi } from 'vitest'
import type { TranscriptMessage } from '../../src/core/transcript/read'
import { memoryStore } from '../control/fakes'

vi.mock('electron', () => ({ clipboard: { writeText: () => undefined }, ipcMain: { handle: () => undefined } }))
const { copyLastReply, lastReplyOf } = await import('../../src/main/lastReply')

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const agent = (over: Record<string, unknown> = {}) => ({ ...box, id: 'a', kind: 'claude', title: 'Parser tests', cwd: 'C:\\w', prompt: '', sessionId: 's', transcriptPath: 'C:\\t.jsonl', after: [], ...over }) as never

test("the last reply is the agent's latest answer, not a Codex note on the way or an empty message", () => {
  const messages: TranscriptMessage[] = [
    { role: 'user', text: 'Fix it' },
    { role: 'assistant', text: 'Done: **3 tests** pass.\n\n- a\n- b' },
    { role: 'assistant', text: "I'll check the docs too.", commentary: true },
    { role: 'assistant', text: '   ' },
    { role: 'user', text: 'Thanks' }
  ]
  expect(lastReplyOf(messages)).toBe('Done: **3 tests** pass.\n\n- a\n- b')
  expect(lastReplyOf([{ role: 'user', text: 'hi' }])).toBeNull()
})

test('copying writes the reply as written, and says why when there is none', async () => {
  const written: string[] = []
  const write = (t: string) => void written.push(t)
  const read = async () => [{ role: 'assistant' as const, text: 'All green.' }]
  expect(await copyLastReply(memoryStore([agent()]), 'a', write, read)).toEqual({ ok: true, chars: 10 })
  expect(written).toEqual(['All green.'])

  expect(await copyLastReply(memoryStore([agent({ transcriptPath: null })]), 'a', write, read)).toEqual({ ok: false, reason: 'Parser tests has no conversation yet.' })
  expect(await copyLastReply(memoryStore([agent()]), 'a', write, async () => [])).toEqual({ ok: false, reason: "Parser tests hasn't replied yet." })
  expect(await copyLastReply(memoryStore([agent()]), 'a', write, async () => Promise.reject(new Error('gone')))).toEqual({ ok: false, reason: "Couldn't read the conversation of Parser tests." })
  expect(await copyLastReply(memoryStore([]), 'a', write, read)).toEqual({ ok: false, reason: 'That window is not an agent.' })
  expect(written).toHaveLength(1)
})
