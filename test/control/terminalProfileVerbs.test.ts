import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasNode, TerminalNode } from '../../src/shared/model'
import { builtInProfiles, profileList, type TerminalProfile } from '../../src/shared/terminalProfiles'
import { claudeNode, fakeHost, fakeRunner, groupNode, memoryStore } from './fakes'

let dir: string
let projDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay profile verbs '))
  projDir = join(dir, 'proj')
  mkdirSync(projDir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const vs: TerminalProfile = { id: 'custom:vs', name: 'VS prompt', program: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'] }
const proj = (): TerminalProfile => ({ id: 'custom:proj', name: 'Project', program: 'bash.exe', args: [], cwd: projDir })

function setup({ extra = [] as CanvasNode[], defaultTerminalProfile = undefined as string | undefined, profiles = undefined as TerminalProfile[] | undefined } = {}) {
  const store = memoryStore([claudeNode('me', { cwd: dir }), ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const terminalProfiles = () => profileList({ terminalProfiles: profiles ?? [vs, proj()], defaultTerminalProfile }, builtInProfiles({ gitBash: true }))
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate, terminalProfiles })
  const node = (id: string) => store.get().nodes.find((n) => n.id === id) as TerminalNode
  return { store, runner, verbs, node }
}

const idOf = (r: unknown) => (r as { id: string }).id

test('open-terminal --profile records the profile, found by name or id', async () => {
  const { verbs, node, runner } = setup()
  const byName = idOf(await verbs('me', 'open-terminal', { profile: 'vs PROMPT', command: 'msbuild' }))
  expect(node(byName)).toMatchObject({ kind: 'terminal', profile: 'custom:vs', command: 'msbuild', cwd: dir })
  const byId = idOf(await verbs('me', 'open-terminal', { profile: 'builtin:git-bash' }))
  expect(node(byId).profile).toBe('builtin:git-bash')
  expect(runner.started).toEqual([byName, byId])
})

test("a profile's folder is used unless --cwd says otherwise", async () => {
  const { verbs, node } = setup()
  expect(node(idOf(await verbs('me', 'open-terminal', { profile: 'Project' }))).cwd).toBe(projDir)
  expect(node(idOf(await verbs('me', 'open-terminal', { profile: 'Project', cwd: dir }))).cwd).toBe(dir)
})

test("a group's worktree comes before a profile's folder", async () => {
  const worktree = { path: join(dir, 'wt'), branch: 'b', repo: dir }
  mkdirSync(worktree.path)
  const { verbs, node } = setup({ extra: [groupNode('g', { worktree })] })
  expect(node(idOf(await verbs('me', 'open-terminal', { profile: 'Project', group: 'g' }))).cwd).toBe(worktree.path)
})

test("the default profile's folder counts too, and one that's gone is passed over", async () => {
  const { verbs, node } = setup({ defaultTerminalProfile: 'custom:proj' })
  const id = idOf(await verbs('me', 'open-terminal', {}))
  expect(node(id)).toMatchObject({ cwd: projDir })
  expect(node(id).profile).toBeUndefined()

  const gone = setup({ defaultTerminalProfile: 'custom:proj', profiles: [{ ...proj(), cwd: join(dir, 'missing') }] })
  expect(gone.node(idOf(await gone.verbs('me', 'open-terminal', {}))).cwd).toBe(dir)
})

test("a named profile's missing folder is refused", async () => {
  const { verbs } = setup({ profiles: [{ ...proj(), cwd: join(dir, 'missing') }] })
  const e = await verbs('me', 'open-terminal', { profile: 'Project' }).then(
    () => null,
    (err: unknown) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  expect((e as Error).message).toMatch(/Folder not found/)
})

test('an unknown --profile is refused, listing the profiles there are, and opens nothing', async () => {
  const { verbs, store } = setup()
  const before = store.get().nodes.length
  const e = await verbs('me', 'open-terminal', { profile: 'zsh' }).then(
    () => null,
    (err: unknown) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  expect((e as Error).message).toBe('No terminal profile is called "zsh". Available: "Git Bash", "VS prompt", "Project", "Windows PowerShell", "Command Prompt".')
  expect(store.get().nodes).toHaveLength(before)
})
