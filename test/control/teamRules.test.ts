import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { createPromptWitness } from '../../src/main/control/promptWitness'
import { RpcRefusal } from '../../src/main/control/server'
import { TEAM_RULES_TITLE, findTeamRules, withTeamRules } from '../../src/main/control/teamRules'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasNode, ClaudeNode, StickyNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from './fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay rules '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const note = (id: string, text: string, over: Partial<StickyNode> = {}): StickyNode => ({
  id,
  kind: 'sticky',
  title: TEAM_RULES_TITLE,
  text,
  x: 0,
  y: 0,
  width: 200,
  height: 120,
  parentId: null,
  ...over
})

function setup(extra: CanvasNode[] = []) {
  const store = memoryStore([claudeNode('me', { cwd: dir, projectId: 'p1' }), ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const verbs = createVerbs({
    store,
    runner,
    tracker,
    host: fakeHost(),
    prompts: createPromptWitness(),
    stops: { get: () => undefined },
    gate: createAfterGate({ store, tracker, runner }),
    timing: { enterDelayMs: 0, settleMs: 5 },
    waitTiming: { pollMs: 5, graceMs: 60 },
    deliveryTiming: { confirmMs: 400, pollMs: 10 }
  })
  const promptOf = (id: string): string | undefined => (store.get().nodes.find((n) => n.id === id) as ClaudeNode | undefined)?.prompt
  return { store, verbs, promptOf }
}

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'not refused',
    (e) => (e instanceof RpcRefusal ? e.message : `threw ${e}`)
  )

describe('withTeamRules', () => {
  test('puts the rules first, says where they came from, and keeps the brief whole', () => {
    const text = withTeamRules('Fix the parser.', { id: 'r', text: '- Nobody pushes.\n' })
    expect(text.startsWith('Team rules (from the "Team rules" note on the canvas, for every member):\n- Nobody pushes.\n')).toBe(true)
    expect(text.endsWith('\n\nYour brief:\nFix the parser.')).toBe(true)
  })
})

describe('findTeamRules', () => {
  const me = claudeNode('me', { projectId: 'p1' })
  test("uses the person's note in the caller's project, whatever the title's case", () => {
    expect(findTeamRules([me, note('r', 'Be brief.', { title: ' team RULES ', projectId: 'p1' })], me)).toEqual({ id: 'r', text: 'Be brief.' })
  })
  test("skips a note in another project, an empty one, and one another agent made", () => {
    const nodes = [me, note('x', 'Other project.', { projectId: 'p2' }), note('e', '  \n', { projectId: 'p1' }), note('o', 'From an agent.', { projectId: 'p1', openedBy: 'someone' })]
    expect(findTeamRules(nodes, me)).toBeNull()
  })
  test('uses a note the caller made itself', () => {
    expect(findTeamRules([me, note('mine', 'Mine.', { projectId: 'p1', openedBy: 'me' })], me)?.id).toBe('mine')
  })
})

describe('open-agent and spawn-team', () => {
  test("open-agent puts a person's Team rules note before the brief and says which note it used", async () => {
    const { verbs, promptOf } = setup([note('rules', 'No npm install.', { projectId: 'p1' })])
    const made = (await verbs('me', 'open-agent', { prompt: 'Add tests.' })) as { id: string; rules?: string }
    expect(made.rules).toBe('rules')
    expect(promptOf(made.id)).toMatch(/^Team rules .*\nNo npm install\.\n\nYour brief:\nAdd tests\.$/s)
  })

  test('--no-rules leaves the brief as written, and an agent opened with no prompt gets nothing', async () => {
    const { verbs, promptOf } = setup([note('rules', 'No npm install.', { projectId: 'p1' })])
    const plain = (await verbs('me', 'open-agent', { prompt: 'Add tests.', noRules: true })) as { id: string; rules?: string }
    expect(promptOf(plain.id)).toBe('Add tests.')
    expect(plain.rules).toBeUndefined()
    const empty = (await verbs('me', 'open-agent', {})) as { id: string; rules?: string }
    expect(promptOf(empty.id)).toBeUndefined()
    expect(empty.rules).toBeUndefined()
  })

  test('with no rules note, nothing changes', async () => {
    const { verbs, promptOf } = setup()
    const made = (await verbs('me', 'open-agent', { prompt: 'Add tests.' })) as { id: string; rules?: string }
    expect(promptOf(made.id)).toBe('Add tests.')
    expect(made).not.toHaveProperty('rules')
  })

  test('spawn-team gives the rules to every member with a brief, except one that opts out', async () => {
    const { verbs, promptOf } = setup([note('rules', 'Nobody pushes.', { projectId: 'p1' })])
    const made = (await verbs('me', 'spawn-team', {
      label: 'T',
      members: [{ name: 'a', prompt: 'Do A.' }, { name: 'b', prompt: 'Do B.', noRules: true }, { name: 'c' }]
    })) as { members: Record<string, string>; rules?: string }
    expect(made.rules).toBe('rules')
    expect(promptOf(made.members.a)).toMatch(/Nobody pushes\.\n\nYour brief:\nDo A\.$/)
    expect(promptOf(made.members.b)).toBe('Do B.')
    expect(promptOf(made.members.c)).toBeUndefined()
  })

  test('a brief that only goes over the limit with the rules is refused, naming the note, and makes nothing', async () => {
    const { verbs, store } = setup([note('rules', 'r'.repeat(20000), { projectId: 'p1' })])
    const before = store.get().nodes.length
    const said = await refusal(verbs('me', 'spawn-team', { label: 'T', members: [{ name: 'a', prompt: 'b'.repeat(10000) }] }))
    expect(said).toMatch(/with the Team rules note \(rules\).*--no-rules|noRules/)
    expect(store.get().nodes.length).toBe(before)
  })
})
