import { describe, expect, it } from 'vitest'
import { patchFiles, transcriptEvents } from '../../src/core/search/transcriptEvents'
import { claudeResult, claudeSays, claudeTool, claudeUser, codexChange, codexRun, codexSays, codexUser, lines } from './fixtures'

const T = Date.UTC(2026, 10, 18, 9, 0)

describe('transcript events', () => {
  it('reads Claude messages, edits and commands with their outcome', () => {
    const { events, partialLastLine } = transcriptEvents(
      lines(
        claudeUser('Fix the parser', T),
        claudeSays('I decided to keep the old API.', T + 1000),
        claudeTool('t1', 'Edit', { file_path: 'C:\\repo\\src\\parse.ts', old_string: 'a', new_string: 'b' }, T + 2000),
        claudeTool('t2', 'Bash', { command: 'npx vitest run' }, T + 3000),
        claudeResult('t2', '1 failed', T + 4000, true),
        JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'duplicate' }] } })
      )
    )
    expect(partialLastLine).toBe(false)
    expect(events).toEqual([
      { kind: 'message', role: 'user', text: 'Fix the parser', at: T },
      { kind: 'message', role: 'assistant', text: 'I decided to keep the old API.', at: T + 1000 },
      { kind: 'edit', path: 'C:\\repo\\src\\parse.ts', at: T + 2000 },
      { kind: 'command', command: 'npx vitest run', ok: false, output: '1 failed', at: T + 3000 }
    ])
  })

  it("reads Codex's current rollout items", () => {
    const { events } = transcriptEvents(lines(codexUser('Add search', T), codexRun('npm test', 0, 'ok', T + 1), codexChange('C:\\repo\\a.ts', T + 2), codexSays('Done.', T + 3)))
    expect(events).toEqual([
      { kind: 'message', role: 'user', text: 'Add search', at: T },
      { kind: 'command', command: 'npm test', ok: true, output: 'ok', at: T + 1 },
      { kind: 'edit', path: 'C:\\repo\\a.ts', at: T + 2 },
      { kind: 'message', role: 'assistant', text: 'Done.', at: T + 3 }
    ])
  })

  it("reads Codex's older form: messages, shell calls with exit codes, and patches", () => {
    const at = new Date(T).toISOString()
    const { events } = transcriptEvents(
      lines(
        JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Old style' } }),
        JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'cargo test'] }) } }),
        JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'test result: ok', metadata: { exit_code: 0 } }) } }),
        JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/lib.rs\n@@\n*** End Patch' } })
      )
    )
    expect(events).toEqual([
      { kind: 'message', role: 'user', text: 'Old style', at: T },
      { kind: 'command', command: 'cargo test', ok: true, output: 'test result: ok', at: T },
      { kind: 'edit', path: 'src/lib.rs', at: T }
    ])
  })

  it('leaves out a last line still being written, and skips a damaged one', () => {
    const whole = claudeUser('first', T)
    const r = transcriptEvents(`${whole}\n{"type":"user","mess\n${claudeSays('second', T + 1)}\n${claudeSays('half', T + 2).slice(0, 30)}`)
    expect(r.events.map((e) => (e.kind === 'message' ? e.text : e.kind))).toEqual(['first', 'second'])
    expect(r.partialLastLine).toBe(true)
  })

  it('counts a final line with no newline as finished when it parses whole', () => {
    const r = transcriptEvents(claudeUser('only', T))
    expect(r.partialLastLine).toBe(false)
    expect(r.events).toHaveLength(1)
  })

  it('lists the files a patch touches', () => {
    expect(patchFiles('*** Add File: a.txt\n+x\n*** Delete File: b.txt\n*** Update File: c/d.ts')).toEqual(['a.txt', 'b.txt', 'c/d.ts'])
  })
})
