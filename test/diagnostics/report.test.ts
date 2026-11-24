import { describe, expect, it } from 'vitest'
import { diagnosticsText, hooksText, logTail, memoryLines, redact, sessionHooks, statusCounts, userNameOf, type DiagnosticsInput } from '../../src/core/diagnostics/report'

const HOME = 'C:\\Users\\Kyle Smith'

describe('redact', () => {
  it('hides the home folder in either slash and any case, a name with a space included', () => {
    const text = 'C:\\Users\\Kyle Smith\\AppData\\Roaming\\npm\\claude.cmd and c:/users/kyle smith/.claude/settings.json and C:\\Users\\Kyle Smith'
    expect(redact(text, HOME)).toBe('C:\\Users\\<you>\\AppData\\Roaming\\npm\\claude.cmd and c:/users/<you>/.claude/settings.json and C:\\Users\\<you>')
  })

  it("hides any other user's folder, and Git Bash's form", () => {
    expect(redact('/c/Users/someone/bin and D:\\Users\\other\\x', 'C:\\Users\\me')).toBe('/c/Users/<you>/bin and D:\\Users\\<you>\\x')
  })

  it('hides the user name standing alone, but only a name of 3 letters or more', () => {
    expect(redact('signed in as KGKyl (kgkyl)', 'C:\\Users\\KGKyl')).toBe('signed in as <you> (<you>)')
    expect(redact('the meeting', 'C:\\Users\\me')).toBe('the meeting')
  })

  it('hides tokens and secrets', () => {
    expect(redact('authorization: Bearer abc.def-123', null)).toBe('authorization: Bearer <hidden>')
    expect(redact('PATCHBAY_TOKEN=deadbeef api_key: "x y" password=hunter2', null)).toBe('PATCHBAY_TOKEN=<hidden> api_key: <hidden> password=<hidden>')
  })
})

describe('userNameOf', () => {
  it('reads the name from a home folder', () => {
    expect(userNameOf('C:\\Users\\KGKyl')).toBe('KGKyl')
    expect(userNameOf('C:\\Users\\KGKyl\\')).toBe('KGKyl')
    expect(userNameOf('/home/k')).toBeNull()
  })
})

const settings = (hooks: Record<string, unknown>): string => JSON.stringify({ hooks, permissions: { allow: [] } })
const one = (hook: Record<string, unknown>): unknown[] => [{ hooks: [hook] }]

describe('sessionHooks', () => {
  it('tells http, exec, command and signal hooks apart, with their timeouts', () => {
    const h = sessionHooks(
      settings({
        UserPromptSubmit: one({ type: 'http', url: 'http://127.0.0.1:5/hook/UserPromptSubmit', headers: { authorization: 'Bearer secret' }, timeout: 30 }),
        SessionStart: one({ type: 'command', command: 'C:\\node.exe', args: ['hook.cjs', 'SessionStart'], timeout: 30 })
      })
    )
    expect(h).toEqual({ prompt: { mode: 'http', timeout: 30 }, start: { mode: 'exec', timeout: 30 } })
    expect(sessionHooks(settings({ UserPromptSubmit: one({ type: 'command', command: 'node "x/hook.cjs" UserPromptSubmit', timeout: 5 }) }))?.prompt).toEqual({ mode: 'command', timeout: 5 })
    expect(sessionHooks(settings({ UserPromptSubmit: one({ type: 'command', command: ": > '/c/x/sig'" }) }))?.prompt).toEqual({ mode: 'signal', timeout: null })
  })

  it("reads nothing it can't, and never the token in a header", () => {
    expect(sessionHooks('not json')).toBeNull()
    expect(sessionHooks('{}')).toBeNull()
    const text = hooksText(sessionHooks(settings({ UserPromptSubmit: one({ type: 'http', headers: { authorization: 'Bearer s3cret' }, timeout: 30 }) })))
    expect(text).toBe('UserPromptSubmit http 30 s, SessionStart none')
    expect(text).not.toContain('s3cret')
    expect(hooksText(null)).toBe('settings file unreadable')
  })
})

describe('logTail', () => {
  it('keeps the last lines, leaving out memory readings and blanks', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `2026-11-24T10:00:${String(i).padStart(2, '0')}.000Z ${i % 5 === 0 ? 'Memory: Browser 200 MB' : `line ${i}`}`)
    const tail = logTail(`${lines.join('\n')}\n\n`, 40)
    expect(tail).toHaveLength(40)
    expect(tail.some((l) => l.includes('Memory:'))).toBe(false)
    expect(tail.at(-1)).toContain('line 49')
  })

  it('keeps a line that only mentions memory later on', () => {
    expect(logTail('2026-11-24T10:00:00.000Z Windows is short of memory: Memory: x')).toHaveLength(1)
  })
})

describe('statusCounts', () => {
  it('counts sessions by kind, then status', () => {
    expect(
      statusCounts([
        { kind: 'terminal', status: 'running' },
        { kind: 'agent', status: 'working' },
        { kind: 'agent', status: 'idle' },
        { kind: 'agent', status: 'working' }
      ])
    ).toBe('agent: 1 idle, 2 working; terminal: 1 running')
    expect(statusCounts([])).toBe('none')
  })
})

describe('memoryLines', () => {
  it('gives RAM, commit, and what Patchbay and the host use', () => {
    const GB = 1024 ** 3
    const lines = memoryLines({ system: { totalPhys: 16 * GB, availPhys: 4 * GB, commitLimit: 20 * GB, commitAvail: 5 * GB }, app: { total: 512 * 1024 ** 2 }, host: { memory: 64 * 1024 ** 2 } })
    expect(lines).toEqual(['RAM: 12.0 GB used of 16.0 GB', 'Commit: 15.0 GB of 20.0 GB (75%)', 'Patchbay: 512 MB, session host 64 MB'])
  })
})

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    about: { version: '0.1.0', build: { commit: 'e94fa9b1c2', dirty: true, branch: 'main', date: '2026-11-24T10:00:00.000Z' }, electron: '39.0.0', node: '22.1.0', chrome: '140.0', os: 'Windows 11 Pro 10.0.26300 x64' },
    at: '2026-11-24T12:00:00.000Z',
    agents: [{ kind: 'claude', name: 'Claude Code', program: `${HOME}\\.local\\bin\\claude.exe`, version: '2.1.150' }],
    launch: {},
    host: { mode: 'background', pid: 4242, version: '0.1.0', protocol: 7, expectedProtocol: 7, running: 2, startedAt: Date.parse('2026-11-20T09:00:00.000Z') },
    sessions: [
      { id: 'aaaaaaaa-1111', kind: 'agent', agent: 'claude', status: 'working', hooks: { prompt: { mode: 'command', timeout: 5 }, start: { mode: 'command', timeout: 5 } } },
      { id: 'bbbbbbbb-2222', kind: 'terminal', status: 'running' }
    ],
    memory: null,
    outsideHooks: [],
    log: ['2026-11-24T11:59:00.000Z Started C:\\Users\\Kyle Smith\\repo with token=abc123'],
    home: HOME,
    ...over
  }
}

describe('diagnosticsText', () => {
  it('has the build, runtime, agents, host, sessions with their hooks, and the log', () => {
    const text = diagnosticsText(input())
    expect(text).toContain('Patchbay 0.1.0 (commit e94fa9b1c2 with changes on main, built 2026-11-24T10:00:00.000Z)')
    expect(text).toContain('Electron 39.0.0, Node 22.1.0')
    expect(text).toContain('OS: Windows 11 Pro 10.0.26300 x64')
    expect(text).toContain('- Claude Code 2.1.150: C:\\Users\\<you>\\.local\\bin\\claude.exe')
    expect(text).toContain('Session host: background, pid 4242, version 0.1.0, protocol 7 (app expects 7), 2 running, started 2026-11-20T09:00:00.000Z')
    expect(text).toContain('Sessions: agent: 1 working; terminal: 1 running')
    // The stale 5 s hook of a session started by an older build is there to see.
    expect(text).toContain('- aaaaaaaa claude working: UserPromptSubmit command 5 s, SessionStart command 5 s')
    expect(text).toContain('Claude settings outside Patchbay naming its hooks: none')
    expect(text).toContain('Log, last 1 lines')
  })

  it('never has the user name, a token, or a full node id', () => {
    const text = diagnosticsText(input())
    expect(text).not.toMatch(/Kyle|Smith/)
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('aaaaaaaa-1111')
  })

  it('says how Claude is launched when Settings changes it, and where outside settings name the hooks', () => {
    const text = diagnosticsText(
      input({
        agents: [{ kind: 'claude', name: 'Claude Code', program: 'wt.exe running claude --verbose', version: 'not asked (runs in a terminal program)' }],
        launch: { claudeTerminal: 'wt.exe', claudeCommand: 'claude --verbose' },
        outsideHooks: [`${HOME}\\.claude\\settings.json`]
      })
    )
    expect(text).toContain('- Claude Code, not asked (runs in a terminal program): wt.exe running claude --verbose')
    expect(text).toContain('Claude runs inside: wt.exe')
    expect(text).toContain('Claude command: claude --verbose')
    expect(text).toContain('naming its hooks: C:\\Users\\<you>\\.claude\\settings.json')
  })

  it("says what isn't known rather than leaving it out", () => {
    const text = diagnosticsText(input({ about: { ...input().about, build: { commit: 'unknown', dirty: false, branch: '', date: 'unknown' } }, agents: [], memory: null }))
    expect(text).toContain('Patchbay 0.1.0 (commit unknown, built unknown)')
    expect(text).toContain('- none enabled')
    expect(text).toContain('Memory: not read')
  })
})
