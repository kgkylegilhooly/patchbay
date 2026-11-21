import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { lastLines, readAllMessages, readMessages, readMessagesTail, readTranscript, readTranscriptAsync, stripAnsi } from '../../src/core/transcript/read'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay transcript '))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const user = (content: unknown, extra: object = {}) => ({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra })
const assistant = (content: unknown, extra: object = {}) => ({
  type: 'assistant',
  isSidechain: false,
  message: { role: 'assistant', content },
  ...extra
})
const text = (t: string) => ({ type: 'text', text: t })

function fixture(lines: Array<object | string>): string {
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return file
}

test('readTranscript reads a Codex rollout from its events, without the duplicate items or system text', () => {
  const event = (type: string, message: string) => ({ timestamp: 't', type: 'event_msg', payload: { type, message } })
  const item = (role: string, t: string) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: t }] } })
  const file = fixture([
    { timestamp: 't', type: 'session_meta', payload: { id: 's' } },
    item('developer', 'SYSTEM TEXT'),
    item('user', 'fix the bug'),
    event('user_message', 'fix the bug'),
    event('token_count', ''),
    event('agent_message', 'Fixed it.'),
    item('assistant', 'Fixed it.')
  ])
  expect(readTranscript(file)).toBe('[user]\nfix the bug\n\n[assistant]\nFixed it.\n')
  expect(readTranscript(file, 1)).toBe('[assistant]\nFixed it.\n')
})

test('readTranscript returns user and assistant text from a fixture and honors tail', () => {
  const file = fixture([
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
    user('first question'),
    assistant([{ type: 'thinking', thinking: 'SECRET THOUGHT' }]),
    assistant([text('first answer')]),
    user('second question'),
    assistant([text('second answer')])
  ])
  expect(readTranscript(file)).toBe(
    '[user]\nfirst question\n\n[assistant]\nfirst answer\n\n[user]\nsecond question\n\n[assistant]\nsecond answer\n'
  )
  expect(readTranscript(file, 2)).toBe('[user]\nsecond question\n\n[assistant]\nsecond answer\n')
})

test('readTranscript leaves out tool traffic, thinking, meta and subagent lines', () => {
  const file = fixture([
    user('keep me'),
    assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'SECRET' } }]),
    user([{ type: 'tool_result', tool_use_id: 't', content: 'TOOL OUTPUT' }]),
    user([text('META')], { isMeta: true }),
    assistant([text('SUBAGENT')], { isSidechain: true }),
    user('<command-name>/clear</command-name>'),
    user('<local-command-stdout>LOCAL</local-command-stdout>')
  ])
  expect(readTranscript(file)).toBe('[user]\nkeep me\n')
})

test('readTranscript ignores other line types that also carry a message role', () => {
  // Real transcripts hold api-request-blob lines whose message has role user or assistant.
  const file = fixture([
    { type: 'api-request-blob', message: { role: 'user', content: [text('SYSTEM PROMPT COPY')] } },
    assistant([text('real')])
  ])
  expect(readTranscript(file)).toBe('[assistant]\nreal\n')
})

test('readTranscript skips a malformed final line', () => {
  const file = fixture([assistant([text('complete')]), '{"type":"assistant","message":{"ro'])
  expect(readTranscript(file)).toBe('[assistant]\ncomplete\n')
})

test('readTranscript returns nothing for a transcript with no messages', () => {
  expect(readTranscript(fixture([{ type: 'mode', mode: 'x' }]))).toBe('')
})

test('readTranscript throws for a missing file so the caller can say the transcript is gone', () => {
  expect(() => readTranscript(join(dir, 'gone.jsonl'))).toThrow(/ENOENT/)
})

test('stripAnsi removes colors, cursor moves, titles and stray control characters', () => {
  const raw = '\x1b]0;my title\x07\x1b[?25l\x1b[1;32mgreen\x1b[0m\r\n\x1b[2Knext\x1b(B\ttabbed\x08\r\n'
  expect(stripAnsi(raw)).toBe('green\nnext\ttabbed\n')
})

test('lastLines keeps the final lines and ignores trailing blank ones', () => {
  expect(lastLines('a\nb\nc\n\n', 2)).toBe('b\nc\n')
  expect(lastLines('a\nb\n')).toBe('a\nb\n')
})

test('readMessages gives the same conversation as structured messages, for the chat view', async () => {
  const { readMessages } = await import('../../src/core/transcript/read')
  const file = fixture([user('hello'), assistant([text('hi **there**')]), user('<command-name>/clear</command-name>')])
  expect(readMessages(file)).toEqual([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi **there**' }
  ])
  expect(readMessages(file, 1)).toEqual([{ role: 'assistant', text: 'hi **there**' }])
})

describe('reading only the end of a long transcript', () => {
  const filler = assistant([{ type: 'tool_use', name: 'Read', input: { text: 'x'.repeat(20_000) } }])
  const said = (i: number) => (i % 2 ? assistant([text(`reply ${i}`)]) : user(`ask ${i}`))

  test('gives the same last messages as reading it all, from a file far bigger than what it reads first', async () => {
    const lines: object[] = []
    for (let i = 0; i < 400; i++) lines.push(filler, said(i))
    const file = fixture(lines)
    const whole = readMessages(file, 30)
    expect(await readMessagesTail(file, 30)).toEqual(whole)
    expect(whole.at(-1)?.text).toBe('reply 399')
  })

  test('a conversation with fewer messages than asked for comes back whole, however big its tool output', async () => {
    const file = fixture([user('first'), filler, filler, filler, assistant([text('only reply')])])
    expect(await readMessagesTail(file, 200)).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'only reply' }
    ])
  })

  test('reads what was added since last time, and leaves a line still being written for next time', async () => {
    const file = fixture([user('one'), assistant([text('two')])])
    await readMessagesTail(file, 10)
    appendFileSync(file, `${JSON.stringify(user('three'))}\n${JSON.stringify(assistant([text('fo')])).slice(0, 30)}`)
    expect((await readMessagesTail(file, 10)).map((m) => m.text)).toEqual(['one', 'two', 'three'])
    appendFileSync(file, `${JSON.stringify(assistant([text('four')])).slice(30)}\n`.replace(/^/, ''))
    // The half line written before is completed by what follows it.
    const after = await readMessagesTail(file, 10)
    expect(after.map((m) => m.text)).toEqual(readMessages(file, 10).map((m) => m.text))
  })

  test('a transcript replaced by a shorter one is read afresh', async () => {
    const file = fixture([user('old one'), assistant([text('old two')]), user('old three')])
    await readMessagesTail(file, 10)
    fixture([user('new')])
    expect((await readMessagesTail(file, 10)).map((m) => m.text)).toEqual(['new'])
  })

  test('readTranscriptAsync matches readTranscript, with and without a tail', async () => {
    const file = fixture([user('a'), assistant([text('b')]), user('c')])
    expect(await readTranscriptAsync(file, 2)).toBe(readTranscript(file, 2))
    expect(await readTranscriptAsync(file)).toBe(readTranscript(file))
  })
})

describe('readAllMessages', () => {
  test('a long transcript reads the same a stretch at a time as all at once, with lines that cross stretches', async () => {
    // Over 512 KB each, so lines straddle stretches and some are longer than a stretch.
    const lines = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? user(`u${i} ${'x'.repeat(30_000 * (i % 7))}`) : assistant([text(`a${i} ${'y'.repeat(1000)}`)])))
    lines.splice(10, 0, user('z'.repeat(700 * 1024)))
    const file = fixture(lines)
    expect(await readAllMessages(file)).toEqual(readMessages(file))
  })

  test("the last line counts even without its newline, and a half-written one doesn't", async () => {
    const file = join(dir, 'open.jsonl')
    writeFileSync(file, `${JSON.stringify(user('first'))}\n${JSON.stringify(assistant([text('last')]))}`)
    expect((await readAllMessages(file)).map((m) => m.text)).toEqual(['first', 'last'])
    writeFileSync(file, `${JSON.stringify(user('first'))}\n{"type":"assistant","mess`)
    expect((await readAllMessages(file)).map((m) => m.text)).toEqual(['first'])
  })

  test('lets other work run while it reads', async () => {
    const file = fixture(Array.from({ length: 400 }, (_, i) => assistant([text(`m${i} ${'w'.repeat(4000)}`)])))
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    await readAllMessages(file)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
  })

  test('an empty file has no messages, and a missing one throws', async () => {
    const file = join(dir, 'empty.jsonl')
    writeFileSync(file, '')
    expect(await readAllMessages(file)).toEqual([])
    await expect(readAllMessages(join(dir, 'gone.jsonl'))).rejects.toThrow()
  })
})
