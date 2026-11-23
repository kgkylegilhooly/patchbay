import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readMessagesTailAndMore } from '../../src/core/transcript/read'
import { CONVERSATION_MAX, CONVERSATION_PAGE, conversationLimit, earlierRow } from '../../src/shared/conversation'

let dir: string
let n = 0
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay pages '))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const line = (i: number) =>
  JSON.stringify(i % 2 ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] } } : { type: 'user', message: { role: 'user', content: `ask ${i}` } })
/** A file of its own each time, so the reader's cache of one test's file can't answer another's. */
function transcript(count: number, padding = 0): string {
  const file = join(dir, `t${n++}.jsonl`)
  const pad = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { text: 'x'.repeat(padding) } }] } })
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    if (padding) lines.push(pad)
    lines.push(line(i))
  }
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('reading a long conversation a page at a time', () => {
  test('says there are earlier messages when it shows only the last page', async () => {
    const file = transcript(600, 3000)
    const page = await readMessagesTailAndMore(file, 200)
    expect(page.messages).toHaveLength(200)
    expect(page.messages[0].text).toBe('ask 400')
    expect(page.earlier).toBe(true)
  })

  test('each page more reaches further back, and the whole says there is nothing before it', async () => {
    const file = transcript(600, 3000)
    await readMessagesTailAndMore(file, 200)
    const two = await readMessagesTailAndMore(file, 400)
    expect(two.messages).toHaveLength(400)
    expect(two.messages[0].text).toBe('ask 200')
    expect(two.earlier).toBe(true)
    const all = await readMessagesTailAndMore(file, 600)
    expect(all.messages[0].text).toBe('ask 0')
    expect(all.earlier).toBe(false)
    const more = await readMessagesTailAndMore(file, 800)
    expect(more.messages).toHaveLength(600)
    expect(more.earlier).toBe(false)
  })

  test('a short conversation has nothing earlier, read fresh or from what was kept', async () => {
    const file = transcript(50)
    expect((await readMessagesTailAndMore(file, 200)).earlier).toBe(false)
    expect((await readMessagesTailAndMore(file, 200)).earlier).toBe(false)
    appendFileSync(file, line(50) + '\n')
    const grown = await readMessagesTailAndMore(file, 200)
    expect(grown.messages).toHaveLength(51)
    expect(grown.earlier).toBe(false)
  })

  test('a conversation that grows past the page starts having earlier messages', async () => {
    const file = transcript(200)
    expect((await readMessagesTailAndMore(file, 200)).earlier).toBe(false)
    appendFileSync(file, line(200) + '\n')
    const grown = await readMessagesTailAndMore(file, 200)
    expect(grown.messages.at(-1)?.text).toBe('ask 200')
    expect(grown.earlier).toBe(true)
  })
})

describe('conversation limits', () => {
  test('a window asks for whole pages, within bounds', () => {
    expect(conversationLimit(undefined)).toBe(CONVERSATION_PAGE)
    expect(conversationLimit('400')).toBe(CONVERSATION_PAGE)
    expect(conversationLimit(NaN)).toBe(CONVERSATION_PAGE)
    expect(conversationLimit(5)).toBe(CONVERSATION_PAGE)
    expect(conversationLimit(400.7)).toBe(400)
    expect(conversationLimit(1e9)).toBe(CONVERSATION_MAX)
  })

  test('the top row: show earlier, the start, or nothing for a short chat', () => {
    expect(earlierRow(200, true)).toEqual({ text: 'Earlier messages · showing the last 200', more: true })
    expect(earlierRow(600, false)).toEqual({ text: 'This is the start of the conversation.', more: false })
    expect(earlierRow(12, false)).toBeNull()
    expect(earlierRow(CONVERSATION_MAX, true)?.more).toBe(false)
  })
})
