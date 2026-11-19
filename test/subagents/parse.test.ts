import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentIdOf, emptyProgress, foldLines, parseMeta, subagentTranscriptText } from '../../src/core/subagents/parse'
import { subagentDir } from '../../src/main/subagents/watcher'

const line = (o: unknown): string => `${JSON.stringify(o)}\n`
const prompt = (text: string, at = '2026-11-10T23:28:38.596Z'): string =>
  line({ isSidechain: true, agentId: 'a1', type: 'user', timestamp: at, message: { role: 'user', content: text } })
/** As Claude writes it: one line per content block, each with its message's usage. */
const reply = (id: string, blocks: unknown[], usage: Record<string, number>, at: string, extra = {}): string =>
  blocks.map((b) => line({ isSidechain: true, type: 'assistant', timestamp: at, message: { id, role: 'assistant', content: [b], usage }, ...extra })).join('')

test('the subagents folder sits beside the transcript, named after the session', () => {
  expect(subagentDir(join('C:', 'p', 'abc.jsonl'))).toBe(join('C:', 'p', 'abc', 'subagents'))
  expect(agentIdOf('agent-a22a36442ebc5c96e.jsonl')).toBe('a22a36442ebc5c96e')
  expect(agentIdOf('agent-a22a36442ebc5c96e.meta.json')).toBeNull()
  expect(agentIdOf('agent-../x.jsonl')).toBeNull()
})

test('meta: type, description and finished, as Claude Code 2.1.328 writes them', () => {
  const meta = parseMeta(
    '{"agentType":"general-purpose","isBuiltIn":true,"description":"Review Task 5 (spec + quality)","toolUseId":"toolu_01","spawnDepth":1,"requestShape":"background","model":"sonnet","finished":true}'
  )
  expect(meta).toEqual({ agentType: 'general-purpose', description: 'Review Task 5 (spec + quality)', finished: true, stoppedByUser: false, depth: 1 })
  // Without "finished", it's still running.
  expect(parseMeta('{"agentType":"Explore","description":"x","spawnDepth":2}')).toMatchObject({ finished: false, depth: 2 })
  expect(parseMeta('{"agentType":"Explore","stoppedByUser":true}')).toMatchObject({ stoppedByUser: true })
  // Read mid-write.
  expect(parseMeta('{"agentType":"gen')).toBeNull()
  expect(parseMeta('[]')).toBeNull()
})

test('tool count and tokens match what the parent was told: tools counted per block, tokens per message', () => {
  const usage1 = { input_tokens: 3, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 100 }
  const usage2 = { input_tokens: 1, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 8_000, output_tokens: 542 }
  const text =
    prompt('Review the parser\nMore detail') +
    reply('m1', [{ type: 'thinking' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }], usage1, '2026-11-10T23:29:00.000Z') +
    reply('m2', [{ type: 'text', text: 'Done' }, { type: 'tool_use', name: 'SubagentHandback' }], usage2, '2026-11-10T23:30:15.000Z')
  const p = foldLines(emptyProgress(), text)
  expect(p.tools).toBe(3)
  expect(p.tokens).toBe(88_543)
  expect(p.prompt).toBe('Review the parser')
  expect(p.startedAt).toBe(Date.parse('2026-11-10T23:28:38.596Z'))
  expect(p.lastAt).toBe(Date.parse('2026-11-10T23:30:15.000Z'))
  expect(p.error).toBeUndefined()
})

test('read in pieces, the result is the same; broken and partial lines are skipped', () => {
  const text = prompt('Go') + reply('m1', [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' }], { input_tokens: 5, output_tokens: 5 }, '2026-11-10T23:29:00.000Z')
  const [a, b] = [text.slice(0, text.indexOf('\n') + 1), text.slice(text.indexOf('\n') + 1)]
  const whole = foldLines(emptyProgress(), text)
  const pieces = foldLines(foldLines(emptyProgress(), a), b)
  expect(pieces).toEqual(whole)
  expect(foldLines(emptyProgress(), '{"type":"assis\nnot json\n')).toEqual(emptyProgress())
})

test('an API error as the last reply marks it; a later good reply clears it', () => {
  const failed = reply('e1', [{ type: 'text', text: 'Fable 5.1 requires usage credits.' }], { input_tokens: 0, output_tokens: 0 }, '2026-11-05T00:33:26.435Z', { isApiErrorMessage: true })
  expect(foldLines(emptyProgress(), failed).error).toBe('Fable 5.1 requires usage credits.')
  const recovered = foldLines(foldLines(emptyProgress(), failed), reply('m2', [{ type: 'text', text: 'ok' }], { output_tokens: 3 }, '2026-11-05T00:34:00.000Z'))
  expect(recovered.error).toBeUndefined()
  // Zero usage isn't a reading.
  expect(foldLines(emptyProgress(), failed).tokens).toBeUndefined()
})

test('the transcript reads as prompt, replies and tool calls', () => {
  const text =
    prompt('Find the bug') +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }) +
    reply('m1', [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }], {}, '2026-11-10T23:29:00.000Z') +
    '{"type":"assistant","mess'
  expect(subagentTranscriptText(text)).toBe('[prompt]\nFind the bug\n\n[assistant]\nLooking\n\n[Read] src/a.ts\n')
})
