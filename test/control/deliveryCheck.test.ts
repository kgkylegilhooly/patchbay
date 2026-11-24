import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { compareDelivered, confirmDelivery, transcriptEnd } from '../../src/main/control/deliveryCheck'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay delivery '))
  file = join(dir, 'session.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const claudeUser = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
const claudeAssistant = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const codexUser = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n'

const long = '[Patchbay message from "Lead" (node l).]\n' + Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + ' THE END'
const timing = { confirmMs: 300, pollMs: 10 }

test('a message that arrived whole matches, whitespace aside', () => {
  expect(compareDelivered(long, long)).toBe('match')
  expect(compareDelivered(long, long.replace(/\n/g, '\r\n').replace(/ /g, '  ') + '\n')).toBe('match')
  expect(compareDelivered('hi', 'hi')).toBe('match')
})

test("a message Claude Code submitted inside its pasted_content tags is whole", () => {
  const wrapped = `\n\n<pasted_content id="ef3a">\n${long}\n</pasted_content id="ef3a">\n`
  expect(compareDelivered(long, wrapped)).toBe('match')
  expect(compareDelivered(long, `\n\n<pasted_content id="ef3a">\n${long.slice(300)}\n</pasted_content id="ef3a">\n`)).toBe('partial')
})

test('a message missing its start or its end is garbled', () => {
  // What Claude Code kept when a full 1024-byte read was dropped: only the tail.
  expect(compareDelivered(long, long.slice(300))).toBe('partial')
  expect(compareDelivered(long, long.slice(0, 200))).toBe('partial')
})

test('some other message is neither', () => {
  expect(compareDelivered(long, 'what are you working on?')).toBe('other')
  expect(compareDelivered('ok', 'okay then')).toBe('other')
})

test('confirmed once the transcript gains the message, ignoring what was there before', async () => {
  writeFileSync(file, claudeUser(long) + claudeAssistant('done'))
  const from = transcriptEnd(file)
  const result = confirmDelivery({ path: file, from, sent: long, timing })
  setTimeout(() => appendFileSync(file, claudeUser(long)), 30)
  expect(await result).toEqual({ result: 'confirmed' })
})

test('garbled when the new message is only the tail of what was sent', async () => {
  writeFileSync(file, '')
  const from = transcriptEnd(file)
  appendFileSync(file, claudeUser(long.slice(400)))
  const result = await confirmDelivery({ path: file, from, sent: long, timing })
  expect(result.result).toBe('garbled')
  expect(result.result === 'garbled' && result.received.startsWith(long.slice(400, 420))).toBe(true)
})

test('unconfirmed when nothing new arrives in time, or only something else', async () => {
  writeFileSync(file, claudeUser(long))
  expect(await confirmDelivery({ path: file, from: transcriptEnd(file), sent: long, timing })).toEqual({ result: 'unconfirmed', reason: 'timeout' })
  const from = transcriptEnd(file)
  appendFileSync(file, claudeUser('the person typed this'))
  expect(await confirmDelivery({ path: file, from, sent: long, timing })).toEqual({ result: 'unconfirmed', reason: 'timeout' })
})

test('unconfirmed straight away without a transcript to read', async () => {
  expect(await confirmDelivery({ path: null, from: null, sent: long, timing })).toEqual({ result: 'unconfirmed', reason: 'no-transcript' })
  expect(transcriptEnd(join(dir, 'missing.jsonl'))).toBeNull()
})

test("a transcript that doesn't exist yet counts from its start once it appears", async () => {
  const later = join(dir, 'later.jsonl')
  const result = confirmDelivery({ path: later, from: transcriptEnd(later), sent: long, timing })
  setTimeout(() => writeFileSync(later, claudeUser(long)), 30)
  expect(await result).toEqual({ result: 'confirmed' })
})

test("Codex's rollout counts too, and a line still being written is read once it's complete", async () => {
  writeFileSync(file, '')
  const from = transcriptEnd(file)
  const line = codexUser(long)
  appendFileSync(file, line.slice(0, 50))
  const result = confirmDelivery({ path: file, from, sent: long, timing })
  setTimeout(() => appendFileSync(file, line.slice(50)), 40)
  expect(await result).toEqual({ result: 'confirmed' })
})

test('a prompt the hook reports damaged is garbled, not left unchecked (review L1)', async () => {
  const heard = () => [long.slice(300)]
  expect(await confirmDelivery({ path: () => null, from: null, sent: long, timing, heard })).toEqual({ result: 'garbled', received: long.slice(300) })
})

test('a transcript replaced mid-check counts only what is added to it, not the history it carries (review L3)', async () => {
  writeFileSync(file, '')
  const forked = join(dir, 'forked.jsonl')
  // The same words were sent before, so the copied history holds them already.
  writeFileSync(forked, claudeUser(long))
  let path = file
  const result = confirmDelivery({ path: () => path, from: transcriptEnd(file), sent: long, timing })
  setTimeout(() => (path = forked), 20)
  expect(await result).toEqual({ result: 'unconfirmed', reason: 'timeout' })
})
