import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { lastLines, readTranscript, stripAnsi } from '../../src/core/transcript/read'

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
