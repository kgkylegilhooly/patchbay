import { expect, test } from 'vitest'
import { createApprovals } from '../../src/main/sessions/approvals'
import { sameRequests } from '../../src/renderer/approveAll'

// AP1: "Approve all N" must group only the very same request. Display text names an Edit's or Write's file alone.
function asks(...inputs: Array<[string, Record<string, unknown>]>) {
  const a = createApprovals()
  inputs.forEach(([tool, input], i) => void a.request(`node-${i}`, { tool_name: tool, tool_input: input }))
  return a.pending()
}

test('two different edits, or writes, of one file are not the same request', () => {
  const edits = asks(
    ['Edit', { file_path: 'C:\\app\\config.ts', old_string: 'debug: false', new_string: 'debug: true' }],
    ['Edit', { file_path: 'C:\\app\\config.ts', old_string: "token: ''", new_string: "token: 'sk-live'" }]
  )
  expect(edits[0].detail).toBe(edits[1].detail)
  expect(sameRequests(edits, edits[0])).toHaveLength(1)
  const writes = asks(['Write', { file_path: 'run.ps1', content: 'echo hi' }], ['Write', { file_path: 'run.ps1', content: 'Remove-Item -Recurse C:\\data' }])
  expect(sameRequests(writes, writes[0])).toHaveLength(1)
})

test('commands that differ only past the shown length, or in spacing the display squeezes, are not the same', () => {
  const long = 'x'.repeat(5000)
  expect(sameRequests(...pair(asks(['Bash', { command: `${long} && echo safe` }], ['Bash', { command: `${long} && rm -rf /` }])))).toHaveLength(1)
  expect(sameRequests(...pair(asks(['Bash', { command: 'echo "a  b"' }], ['Bash', { command: 'echo "a b"' }])))).toHaveLength(1)
})

test('the very same request, whatever order its fields came in, still is', () => {
  const same = asks(
    ['Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }],
    ['Edit', { new_string: 'y', file_path: 'a.ts', old_string: 'x' }],
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'npm test' }]
  )
  expect(sameRequests(same, same[0])).toHaveLength(2)
  expect(sameRequests(same, same[2])).toHaveLength(2)
})

const pair = (all: ReturnType<typeof asks>): [ReturnType<typeof asks>, ReturnType<typeof asks>[number]] => [all, all[0]]
