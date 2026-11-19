/** Transcript lines in the shapes Claude Code and Codex write them. */

export const iso = (ms: number): string => new Date(ms).toISOString()

export const claudeUser = (text: string, at: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text }, uuid: `u${at}` })

export const claudeSays = (text: string, at: number): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }] } })

export const claudeTool = (id: string, name: string, input: Record<string, unknown>, at: number): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })

export const claudeResult = (id: string, output: string, at: number, isError = false): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, ...(isError ? { is_error: true } : {}) }] } })

const item = (it: Record<string, unknown>, at: number): string =>
  JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: it } })

export const codexUser = (text: string, at: number): string => item({ type: 'UserMessage', content: [{ type: 'text', text }] }, at)
export const codexSays = (text: string, at: number): string => item({ type: 'AgentMessage', content: [{ type: 'Text', text }], phase: 'final' }, at)
export const codexRun = (command: string, exit: number, output: string, at: number): string =>
  item({ type: 'CommandExecution', command: ['powershell.exe', '-Command', command], exit_code: exit, status: exit ? 'failed' : 'completed', aggregated_output: output }, at)
export const codexChange = (path: string, at: number): string => item({ type: 'FileChange', changes: { [path]: { type: 'update', unified_diff: '@@' } }, status: 'completed' }, at)

export const lines = (...l: string[]): string => `${l.join('\n')}\n`
