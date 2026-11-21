import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { buildClaudeLaunch } from '../../src/main/sessions/claudeLaunch'
import { onClaudeNodesRemoved, pruneSessionSettings, removeSessionSettings, settingsFileFor } from '../../src/main/sessions/sessionSettingsFiles'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, CanvasOp, ClaudeNode } from '../../src/shared/model'

let dir: string
let sessionDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay session settings '))
  sessionDir = join(dir, 'sessions')
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

const claude = (id: string): ClaudeNode => ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: dir, sessionId: null, transcriptPath: null, after: [] })
const terminal = (id: string): CanvasNode => ({ id, kind: 'terminal', title: id, x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: dir }) as CanvasNode

function memoryStore(nodes: CanvasNode[]): CanvasStore {
  let doc = { version: 3, nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projects: [], closed: [] } as unknown as CanvasDoc
  const listeners: Array<(d: CanvasDoc) => void> = []
  return {
    get: () => doc,
    dispatch(op: CanvasOp) {
      doc = reduce(doc, op)
      for (const cb of listeners) cb(doc)
    },
    subscribe(cb) {
      listeners.push(cb)
      return () => void listeners.splice(listeners.indexOf(cb), 1)
    }
  }
}

/** The settings a Claude launch writes, with a host port, so the hook token is in them. */
function launch(id: string): string {
  const l = buildClaudeLaunch(claude(id), {
    sessionDir,
    hookScript: 'C:\\hook.cjs',
    pluginDir: 'C:\\skill',
    cliDir: 'C:\\cli',
    endpointFile: 'C:\\e.json',
    token: `token-of-${id}`,
    claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
    baseEnv: { Path: 'C:\\Windows' },
    home: join(dir, 'home'),
    managedSettingsFile: join(dir, 'managed.json'),
    hookPort: 40001
  })
  return l.args[l.args.indexOf('--settings') + 1]
}

test("a removed Claude node's settings file, which holds its hook token, goes with it, however it was removed", () => {
  const store = memoryStore([claude('a'), claude('b'), claude('c'), terminal('t')])
  const files = ['a', 'b', 'c'].map(launch)
  expect(files[0]).toBe(settingsFileFor(sessionDir, 'a'))
  expect(readdirSync(sessionDir).length).toBe(3)
  const removed: string[] = []
  onClaudeNodesRemoved(store, (id) => {
    removed.push(id)
    removeSessionSettings(sessionDir, id)
  })
  store.dispatch({ op: 'removeNodes', ids: ['a', 't'], at: 1 })
  expect(removed).toEqual(['a'])
  expect(existsSync(files[0])).toBe(false)
  expect(existsSync(files[1])).toBe(true)
  // Changes that remove nothing remove nothing.
  store.dispatch({ op: 'patchNode', id: 'b', patch: { title: 'B' } })
  expect(removed).toEqual(['a'])
  store.dispatch({ op: 'removeNodes', ids: ['b', 'c'], at: 2 })
  expect(removed.sort()).toEqual(['a', 'b', 'c'])
  expect(readdirSync(sessionDir)).toEqual([])
})

test('at start, files of nodes that are gone are removed, but not one a running session still has, nor anything else', () => {
  for (const id of ['kept', 'gone', 'running', 'odd/id']) launch(id)
  mkdirSync(join(sessionDir, 'signals'), { recursive: true })
  writeFileSync(join(sessionDir, 'notes.txt'), '')
  const removed = pruneSessionSettings(sessionDir, (id) => id === 'kept' || id === 'running')
  expect(removed.sort()).toEqual(['gone', 'odd/id'])
  expect(readdirSync(sessionDir).sort()).toEqual(['kept.settings.json', 'notes.txt', 'running.settings.json', 'signals'])
  expect(pruneSessionSettings(join(dir, 'nowhere'), () => false)).toEqual([])
})
