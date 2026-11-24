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
    expect(redact('authorization: Bearer abc.def-123', null)).toBe('authorization: <hidden>')
    expect(redact('sent with Bearer abc.def-123', null)).toBe('sent with Bearer <hidden>')
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

describe('review round: nothing said to an agent, and no secret shape, gets through', () => {
  it('H1: a garbled-send line keeps no transcript text, from an old log too', () => {
    const line =
      '2026-11-24T10:00:00.000Z send to 1d015715-b71f-441e-bdfc-3333e6b4be2a: garbled. Node "1d015715-b71f-441e-bdfc-3333e6b4be2a" got a damaged copy of the message. Its transcript shows only: "please rotate the "prod" keys and tell nobody". Send it again.'
    const tail = logTail(line)
    expect(tail).toHaveLength(1)
    expect(tail[0]).toContain('Its transcript shows only: <hidden>')
    expect(tail[0]).not.toMatch(/rotate|prod|nobody/)
    expect(diagnosticsText(input({ log: tail }))).not.toMatch(/rotate|prod|nobody/)
  })

  it('M1: JSON keys, flags, URL credentials, Basic auth and known key prefixes', () => {
    expect(redact('{"token":"abc123"} {"PATCHBAY_TOKEN": "abc123"} {"apiKey": "k1"}', null)).toBe('{"token":<hidden>} {"PATCHBAY_TOKEN": <hidden>} {"apiKey": <hidden>}')
    expect(redact('claude --api-key sk-zzz --token SECRET --model opus', null)).toBe('claude --api-key <hidden> --token <hidden> --model opus')
    expect(redact('git failed: https://kyle:SECRETPASS@github.com/a/b.git', null)).toBe('git failed: https://<hidden>@github.com/a/b.git')
    expect(redact('authorization: Basic Zm9vOmJhcg==', null)).toBe('authorization: <hidden>')
    expect(redact('sent with Basic Zm9vOmJhcg==', null)).toBe('sent with Basic <hidden>')
    expect(redact('keys sk-ant-api03-AbC_d-1 ghp_abcdef123 github_pat_11AB xoxb-1-2 sk-abcdefghijklmnopqrstuvwx', null)).toBe('keys <hidden> <hidden> <hidden> <hidden> <hidden>')
  })

  it('M1: a custom command from Settings goes in redacted', () => {
    const text = diagnosticsText(input({ agents: [{ kind: 'claude', name: 'Claude Code', program: 'mywrap --token X1 claude', version: 'not asked (custom command)' }], launch: { claudeCommand: 'claude --api-key sk-ant-api03-Q' } }))
    expect(text).not.toMatch(/X1|sk-ant/)
  })

  it('L1: a home outside \\Users is hidden too, and the account name given', () => {
    expect(redact(String.raw`D:\Profiles\kyle\x and \\server\profiles$\kyle\y`, String.raw`D:\Profiles\kyle`)).toBe(String.raw`D:\Profiles\<you>\x and \\server\profiles$\<you>\y`)
    expect(redact('signed in as jdoe', null, 'jdoe')).toBe('signed in as <you>')
  })

  it('L2: JSON-escaped and URL-encoded paths', () => {
    expect(redact(String.raw`{"cwd":"C:\\Users\\kg\\x"}`, null)).toBe(String.raw`{"cwd":"C:\\Users\\<you>\\x"}`)
    expect(redact('file:///C%3A%5CUsers%5CKGKyl%5Cx', null)).toBe('file:///C%3A%5CUsers%5C<you>%5Cx')
  })

  it("L3: stops at the end of a path in a list, and a name that's also a word is still hidden on purpose", () => {
    expect(redact(String.raw`path=C:\Users\other;D:\bin,next`, String.raw`C:\Users\me`)).toBe(String.raw`path=C:\Users\<you>;D:\bin,next`)
    expect(redact('Session host: background', String.raw`C:\Users\host`)).toBe('Session <you>: background')
  })

  it('L5: node ids in the log are cut to their first 8 characters', () => {
    const text = diagnosticsText(input({ log: ['2026-11-24T10:00:00.000Z Session sync (boot): 1d015715-b71f-441e-bdfc-3333e6b4be2a was shown as ended'] }))
    expect(text).toContain('Session sync (boot): 1d015715… was shown')
    expect(text).not.toContain('3333e6b4be2a')
  })
})

describe('fringe secret shapes (re-check)', () => {
  it('an Authorization header, whatever its scheme', () => {
    expect(redact('Authorization: token abc123', null)).toBe('Authorization: <hidden>')
    expect(redact('{"authorization": "Bearer x.y"}', null)).toBe('{"authorization": <hidden>}')
    expect(redact('proxy-authorization=Negotiate YIIabc, next', null)).toBe('proxy-authorization=<hidden>, next')
  })

  it('an env-style NAME_TOKEN with a space before its value', () => {
    expect(redact('set GITHUB_TOKEN ghx123 and AWS_SECRET_ACCESS_KEY wJalr', null)).toBe('set GITHUB_TOKEN <hidden> and AWS_SECRET_ACCESS_KEY <hidden>')
  })

  it('password flags, -p included', () => {
    expect(redact('mysql --pass hunter2 -u root', null)).toBe('mysql --pass <hidden> -u root')
    expect(redact('tool --password=x1 --pwd y2 -p z3', null)).toBe('tool --password=<hidden> --pwd <hidden> -p <hidden>')
  })

  it('AWS access keys', () => {
    expect(redact('key AKIAIOSFODNN7EXAMPLE and ASIAABCDEFGHIJKLMNOP', null)).toBe('key <hidden> and <hidden>')
  })

  it('cookies', () => {
    expect(redact('Cookie: session=abc; theme=dark', null)).toBe('Cookie: <hidden>')
    expect(redact('Set-Cookie: sid=1; HttpOnly', null)).toBe('Set-Cookie: <hidden>')
  })

  it('an @ inside a URL password', () => {
    expect(redact('https://kyle:p@ss@word@github.com/a/b', null)).toBe('https://<hidden>@github.com/a/b')
  })

  it('an escaped quote inside a JSON secret', () => {
    expect(redact(String.raw`{"token": "a\"b c", "x": 1}`, null)).toBe('{"token": <hidden>, "x": 1}')
    expect(redact(String.raw`{"apiKey":"q\"r s"}`, null)).toBe('{"apiKey":<hidden>}')
  })

  it("leaves a count of tokens alone, which isn't a secret", () => {
    expect(redact('max_tokens=4096 input_tokens: 12', null)).toBe('max_tokens=4096 input_tokens: 12')
    expect(redact('tokens=abc', null)).toBe('tokens=<hidden>')
  })
})
