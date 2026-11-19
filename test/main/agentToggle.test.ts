import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readAgentsFrom } from '../../src/main/agentsAllowed'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createVerbs } from '../../src/main/control/verbs'
import { createNodeRunner } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTriggerService } from '../../src/main/triggers/service'
import { agentChoice } from '../../src/shared/agents'
import type { SessionSpec } from '../../src/shared/contract'
import type { CanvasNode, ClaudeNode, TriggerNode } from '../../src/shared/model'
import { planRecipe, type RecipeParams } from '../../src/shared/recipe'
import { BUILT_IN_RECIPES } from '../../src/shared/recipeBuiltins'
import type { Settings } from '../../src/shared/settings'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from '../control/fakes'
import { recipeWorld } from '../recipes/fakes'
import { triggerNode } from '../trigger/fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay agents '))
})
afterEach(() => {
  readAgentsFrom(() => ({}))
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const CODEX_OFF: Settings = { agentsOff: 'codex' }

const refused = async (p: Promise<unknown>, pattern: RegExp): Promise<void> => {
  const e = await p.then(
    () => null,
    (err) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  expect(e.message).toMatch(pattern)
}

function verbsWith(settings: Settings) {
  const store = memoryStore([claudeNode('me', { cwd: dir })])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const choice = () => agentChoice(settings)
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate, timing: { enterDelayMs: 0, settleMs: 10 }, defaultAgent: () => choice().default, agents: choice })
  return { store, runner, verbs }
}

describe('control verbs', () => {
  test('open-agent --agent codex is refused while Codex is off, naming the setting and what is on', async () => {
    const { verbs, store, runner } = verbsWith(CODEX_OFF)
    await refused(verbs('me', 'open-agent', { agent: 'codex' }), /Codex is turned off in Settings > Agents.*Patchbay may use Claude Code\. Name claude as the agent instead/)
    expect(store.get().nodes).toHaveLength(1)
    expect(runner.started).toEqual([])
  })

  test('open-agent with no agent uses the default, which is always on', async () => {
    const { verbs, store } = verbsWith({ defaultAgent: 'codex', agentsOff: 'codex' })
    const { id } = (await verbs('me', 'open-agent', {})) as { id: string }
    expect((store.get().nodes.find((n) => n.id === id) as ClaudeNode).agent).toBeUndefined()
  })

  test('spawn-team is refused as a whole when a member names an agent that is off', async () => {
    const { verbs, store, runner } = verbsWith({ agentsOff: 'claude' })
    await refused(verbs('me', 'spawn-team', { label: 'T', members: [{ name: 'a' }, { name: 'b', agent: 'claude' }] }), /Team member "b": Claude Code is turned off in Settings > Agents/)
    expect(store.get().nodes).toHaveLength(1)
    expect(runner.started).toEqual([])
    const r = (await verbs('me', 'spawn-team', { label: 'T', members: [{ name: 'a' }] })) as { members: Record<string, string> }
    expect(store.get().nodes.find((n) => n.id === r.members.a)).toMatchObject({ agent: 'codex' })
  })

  test('whoami says which agents may be opened', async () => {
    const all = (await verbsWith({}).verbs('me', 'whoami', {})) as { text: string; agents: unknown }
    expect(all.text).toContain('Agents Patchbay may open: Claude Code and Codex, and the default is Claude Code.')
    const one = (await verbsWith(CODEX_OFF).verbs('me', 'whoami', {})) as { text: string; agents: unknown }
    expect(one.agents).toEqual({ enabled: ['claude'], default: 'claude' })
    expect(one.text).toContain('Agents Patchbay may open: Claude Code only, and the default is Claude Code. Codex is turned off in Settings > Agents, so patchbay refuses to open it.')
  })
})

describe('starting, restarting and resuming', () => {
  function runnerWith(nodes: CanvasNode[], settings: () => Settings) {
    const store = memoryStore(nodes)
    const tracker = createStatusTracker({ notify: () => {} })
    const host = fakeHost()
    const specs: SessionSpec[] = []
    const killed: string[] = []
    host.start = (spec) => {
      specs.push(spec)
      host.running.add(spec.nodeId)
    }
    host.kill = async (id) => {
      killed.push(id)
      host.running.delete(id)
    }
    const runner = createNodeRunner({
      host,
      tracker,
      store,
      ctx: {
        sessionDir: join(dir, 'sessions'),
        hookScript: 'C:/hook.cjs',
        pluginDir: 'C:/skill',
        cliDir: 'C:/cli',
        endpointFile: 'C:/endpoint.json',
        secret: 'sec',
        claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
        codex: { file: 'C:\\bin\\codex.exe', prefixArgs: [] },
        baseEnv: { PATH: 'C:\\Windows' },
        settings
      }
    })
    return { runner, host, specs, killed }
  }

  test('a Codex node does not start or resume while Codex is off, and says why', async () => {
    const { runner, specs } = runnerWith([claudeNode('x', { agent: 'codex', cwd: dir, sessionId: 's' })], () => CODEX_OFF)
    await runner.startNode('x')
    expect(specs).toEqual([])
    expect(runner.errors().x).toEqual({ code: 'spawn-failed', message: expect.stringMatching(/^Codex is turned off in Settings > Agents/) })
  })

  test('restart is refused before anything is stopped, so a running session keeps running', async () => {
    let settings: Settings = {}
    const { runner, host, specs, killed } = runnerWith([claudeNode('x', { agent: 'codex', cwd: dir })], () => settings)
    await runner.startNode('x')
    expect(specs).toHaveLength(1)
    settings = CODEX_OFF
    await runner.restartNode('x')
    expect(killed).toEqual([])
    expect(host.isRunning('x')).toBe(true)
    expect(specs).toHaveLength(1)
    expect(runner.errors().x?.message).toMatch(/Codex is turned off/)
    // Once Codex is on again, restart works.
    settings = {}
    await runner.restartNode('x')
    expect(specs).toHaveLength(2)
    expect(runner.errors().x).toBeUndefined()
  })

  test('other agents and terminals start as before', async () => {
    const { runner, specs } = runnerWith([claudeNode('c', { cwd: dir })], () => CODEX_OFF)
    await runner.startNode('c')
    expect(specs).toHaveLength(1)
    expect(runner.errors().c).toBeUndefined()
  })
})

describe('triggers', () => {
  test('a trigger aimed at an agent that is off records a failed run and sends nothing', () => {
    vi.useFakeTimers()
    readAgentsFrom(() => CODEX_OFF)
    const store = memoryStore([claudeNode('t', { agent: 'codex' }), triggerNode('tr')])
    const tracker = createStatusTracker({ notify: () => {} })
    const host = fakeHost()
    host.running.add('t')
    const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 0, settleMs: 10 } })
    const service = createTriggerService({ store, tracker, host, queue, now: () => 1_000_000 })
    const trig = () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode
    expect(service.arm('tr', canonicalSpec(trig()))).toEqual({ ok: true })
    const r = service.runNow('tr')
    expect(r).toMatchObject({ ok: true, run: { outcome: 'failed', detail: expect.stringMatching(/^Codex is turned off in Settings > Agents/) } })
    expect(trig().runs[0].outcome).toBe('failed')
    expect(host.writes).toEqual([])
  })
})

describe('recipes', () => {
  const recipe = BUILT_IN_RECIPES.find((r) => r.name === 'Implement and review')!
  const params = (over: Partial<RecipeParams> = {}): RecipeParams => ({ task: 'Add dark mode', branch: 'dark-mode', repo: process.cwd(), cwd: process.cwd(), worktree: true, ...over })
  let n = 0
  const newId = () => `id-${++n}`

  test('the preview names an agent that is off as a problem, until the person chooses to use another', () => {
    const off = agentChoice(CODEX_OFF)
    const plan = planRecipe(recipe, params(), newId, off)
    expect(plan.problems.some((p) => /needs Codex, which is turned off in Settings > Agents\. Start it with Claude Code instead/.test(p))).toBe(true)
    const swapped = planRecipe(recipe, params({ useAgent: 'claude' }), newId, off)
    expect(swapped.problems).toEqual([])
    expect(swapped.warnings.some((w) => /starts as Claude Code, as you chose, since Codex is turned off/.test(w))).toBe(true)
    expect(swapped.nodes.filter((x) => x.kind === 'claude').every((x) => (x as ClaudeNode).agent === undefined)).toBe(true)
    // With every agent on, nothing changes, and a stray choice is ignored.
    const all = planRecipe(recipe, params({ useAgent: 'claude' }), newId)
    expect(all.problems).toEqual([])
    expect(all.nodes.some((x) => x.kind === 'claude' && x.agent === 'codex')).toBe(true)
    // A choice of an agent that is itself off doesn't count.
    expect(planRecipe(recipe, params({ useAgent: 'codex' }), newId, off).problems.length).toBeGreaterThan(0)
  })

  test('Start is refused in main while the recipe needs an agent that is off, and makes nothing', async () => {
    readAgentsFrom(() => CODEX_OFF)
    const w = recipeWorld()
    const r = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params() })
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/needs Codex, which is turned off/) })
    expect(w.worktrees).toEqual([])
    expect(w.store.get().nodes).toEqual([])
    const ok = await w.service.start({ projectId: 'p1', ref: 'Implement and review', params: params({ useAgent: 'claude' }) })
    if (!ok.ok) throw new Error(ok.reason)
    expect(w.agent(ok.ids.reviewer).agent).toBeUndefined()
  })
})
