import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { outsideHooks, programPath, readLogEnd, sessionLines } from '../../src/main/diagnostics/collect'
import { settingsFileFor } from '../../src/main/sessions/sessionSettingsFiles'
import type { CanvasNode } from '../../src/shared/model'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-diag-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('programPath', () => {
  it('gives the batch file a cmd.exe wrapper runs, without its escapes', () => {
    expect(programPath({ file: 'C:\\Windows\\system32\\cmd.exe', prefixArgs: ['/d', '/s', '/c', 'C:\\npm\\claude^(1^).cmd'] })).toBe('C:\\npm\\claude(1).cmd')
    expect(programPath({ file: 'C:\\bin\\claude.exe', prefixArgs: [] })).toBe('C:\\bin\\claude.exe')
  })
})

describe('readLogEnd', () => {
  it('reads the end of a long log from a whole line on', async () => {
    const file = join(temp(), 'patchbay.log')
    writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'))
    const text = await readLogEnd(file, 1000)
    expect(text.startsWith('line ')).toBe(true)
    expect(text.endsWith('line 4999')).toBe(true)
  })

  it('is empty for a missing log', async () => {
    expect(await readLogEnd(join(temp(), 'none.log'))).toBe('')
  })
})

describe('sessionLines', () => {
  it("lists running sessions, reading each running Claude's hooks from its own settings file", async () => {
    const sessionDir = temp()
    writeFileSync(settingsFileFor(sessionDir, 'c1'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'http', timeout: 30, headers: { authorization: 'Bearer t' } }] }] } }))
    const nodes = [
      { id: 'c1', kind: 'claude', cwd: 'C:\\r', title: 'secret plan' },
      { id: 'c2', kind: 'claude', agent: 'codex', cwd: 'C:\\r', title: '' },
      { id: 'c3', kind: 'claude', cwd: 'C:\\r', title: '' },
      { id: 't1', kind: 'terminal', cwd: 'C:\\r', title: '' },
      { id: 'n1', kind: 'sticky', title: '' }
    ] as unknown as CanvasNode[]
    const lines = await sessionLines({ nodes, isRunning: (id) => id !== 'c3', status: (id) => (id === 't1' ? 'running' : 'idle'), sessionDir, hosted: [{ id: 'gone', running: true }, { id: 'c1', running: true }] })
    expect(lines).toEqual([
      { id: 'c1', kind: 'agent', agent: 'claude', status: 'idle', hooks: { prompt: { mode: 'http', timeout: 30 }, start: null } },
      { id: 'c2', kind: 'agent', agent: 'codex', status: 'idle', hooks: undefined },
      { id: 't1', kind: 'terminal', status: 'running' },
      { id: 'gone', kind: 'unknown', status: 'no node' }
    ])
  })
})

describe('outsideHooks', () => {
  it("finds Claude settings outside a session's own that run Patchbay's hooks", async () => {
    const home = temp()
    const project = temp()
    mkdirSync(join(home, '.claude'))
    mkdirSync(join(project, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/Program Files/Patchbay/resources/resources/hook.cjs" Stop' }] }] } }))
    // Patchbay's name elsewhere in a file, as a permission rule, isn't a hook.
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(patchbay list)'] }, hooks: {} }))
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{ broken')
    const found = await outsideHooks({ home, folders: [project, ''], managedFile: join(home, 'none.json'), registry: [] })
    expect(found).toEqual([join(home, '.claude', 'settings.json')])
  })

  it("reads managed drop-ins and the registry policy, and doesn't count a hook that only reads PATCHBAY_NODE_ID", async () => {
    const home = temp()
    const managedDir = temp()
    mkdirSync(join(managedDir, 'managed-settings.d'))
    writeFileSync(join(managedDir, 'managed-settings.d', '10-team.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4100/hook/Stop' }] }] } }))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo $PATCHBAY_NODE_ID >> ~/log' }] }] } }))
    const registry = [{ key: 'HKCU\\SOFTWARE\\Policies\\ClaudeCode', settings: { statusLine: { type: 'command', command: 'node x/statusline.cjs' } } }]
    const found = await outsideHooks({ home, folders: [], managedFile: join(managedDir, 'managed-settings.json'), registry })
    expect(found).toEqual([join(managedDir, 'managed-settings.d', '10-team.json'), 'HKCU\\SOFTWARE\\Policies\\ClaudeCode'])
  })

  it('reads CLAUDE_CONFIG_DIR in place of ~/.claude, and finds none in a clean setup', async () => {
    const home = temp()
    const config = temp()
    writeFileSync(join(config, 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'node C:/x/statusline.cjs' } }))
    expect(await outsideHooks({ home, configDir: config, folders: [], managedFile: join(home, 'none.json'), registry: [] })).toEqual([join(config, 'settings.local.json')])
    expect(await outsideHooks({ home, folders: [], managedFile: join(home, 'none.json'), registry: [] })).toEqual([])
  })
})
