import { expect, test } from 'vitest'
import { createApprovals } from '../../src/main/sessions/approvals'

// AP2: approving an Edit or a Write from the strip meant approving a change you couldn't read there: it named the file.
const ask = (tool: string, input: Record<string, unknown>) => {
  const a = createApprovals()
  void a.request('n', { tool_name: tool, tool_input: input })
  return a.pending()[0]
}

test('an Edit shows the lines it takes out and puts in, under the file', () => {
  const p = ask('Edit', { file_path: 'C:\\app\\config.ts', old_string: '  debug: false,\n  port: 80', new_string: '  debug: true,\n  port: 80' })
  expect(p.summary).toBe('C:\\app\\config.ts')
  expect(p.detail).toBe('C:\\app\\config.ts\n-   debug: false,\n-   port: 80\n+   debug: true,\n+   port: 80')
})

test('a Write shows what it writes, a MultiEdit each change, and a NotebookEdit its new cell', () => {
  expect(ask('Write', { file_path: 'run.ps1', content: 'Remove-Item -Recurse C:\\data\r\n' }).detail).toBe('run.ps1\n+ Remove-Item -Recurse C:\\data')
  expect(ask('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).detail).toBe('a.ts\n- a\n+ b\n\n- c\n+ d')
  expect(ask('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)' }).detail).toBe('n.ipynb\n+ print(1)')
})

test('control characters never reach the strip, a long change is cut, and a command reads as before', () => {
  expect(ask('Write', { file_path: 'x.txt', content: 'ok\x1b[2Jhidden\x07' }).detail).toBe('x.txt\n+ ok[2Jhidden')
  expect(ask('Write', { file_path: 'big.txt', content: 'y'.repeat(10_000) }).detail.length).toBe(4000)
  expect(ask('Bash', { command: 'npm   test\n&& echo done' }).detail).toBe('npm test && echo done')
})
