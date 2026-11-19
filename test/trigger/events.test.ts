import { describe, expect, test } from 'vitest'
import { armRefusal, canonicalSpec, isArmed } from '../../src/core/trigger/arming'
import {
  describeEvent,
  eventVars,
  expandPrompt,
  folderProblem,
  globToRegExp,
  ignoredPath,
  isInside,
  matchesGlob,
  placeholderProblem,
  placeholdersIn,
  preflightArgv,
  projectRoots
} from '../../src/core/trigger/events'
import { migrate } from '../../src/core/persist/docStore'
import { describeSchedule, nextRun, scheduleError } from '../../src/core/trigger/schedule'
import type { CanvasDoc, TriggerNode } from '../../src/shared/model'
import { claudeNode, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

const root = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
const inRoot = (rel: string) => (process.platform === 'win32' ? `${root}\\${rel}` : `${root}/${rel}`)

function doc(nodes: CanvasDoc['nodes']): Pick<CanvasDoc, 'nodes' | 'projects'> {
  return { nodes, projects: [{ id: 'p', name: 'App', folder: root, viewport: { x: 0, y: 0, zoom: 1 } }] }
}

describe('migration', () => {
  test('a trigger saved before events keeps the same spec string, so it stays armed', () => {
    const old = triggerNode('tr', { schedule: { type: 'cron', expr: '0  9 * * *' } })
    // What the earlier version wrote for this trigger.
    const before = JSON.stringify([['cron', '0 9 * * *'], old.prompt, old.targetId])
    expect(canonicalSpec(old)).toBe(before)
    expect(isArmed({ ...old, armedSpec: before })).toBe(true)
    for (const schedule of [{ type: 'interval' as const, everyMs: 60_000 }, { type: 'once' as const, at: 5 }]) {
      const n = triggerNode('tr', { schedule })
      expect(canonicalSpec(n)).toBe(JSON.stringify([[schedule.type, schedule.type === 'interval' ? schedule.everyMs : schedule.at], n.prompt, n.targetId]))
    }
  })

  test('a check, and an event kind\'s limits, are part of what arming agrees to', () => {
    const plain = triggerNode('tr')
    const checked = { ...plain, preflight: { argv: ['npm', 'test'], cwd: root } }
    expect(canonicalSpec(checked)).not.toBe(canonicalSpec(plain))
    const ev = triggerNode('tr', { schedule: { type: 'agent', nodeId: 'a', on: 'turn' } })
    const tighter = { ...ev, limits: { gapMs: 60_000, perHour: 2 } }
    expect(canonicalSpec(tighter)).not.toBe(canonicalSpec(ev))
    // Changing the check after arming disarms.
    expect(isArmed({ ...checked, armedSpec: canonicalSpec(plain) })).toBe(false)
  })
})

describe('globs', () => {
  test('a pattern without / matches file names at any depth', () => {
    expect(matchesGlob('a.ts', '*.ts')).toBe(true)
    expect(matchesGlob('src/deep/a.ts', '*.ts')).toBe(true)
    expect(matchesGlob('src/a.tsx', '*.ts')).toBe(false)
    expect(matchesGlob('src\\a.ts', '*.{ts,tsx}')).toBe(true)
  })

  test('a pattern with / matches the path from the folder', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true)
    expect(matchesGlob('src/x/a.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('src/x/a.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('anything/at/all', '**/*')).toBe(true)
  })

  test('regex characters are literal, and unbalanced braces are refused', () => {
    expect(matchesGlob('a+b.(1).md', 'a+b.(1).md')).toBe(true)
    expect(matchesGlob('aXb', 'a.b')).toBe(false)
    expect(globToRegExp('{a,b')).toBeNull()
  })

  test('.git and node_modules are never watched', () => {
    expect(ignoredPath('.git/index')).toBe(true)
    expect(ignoredPath('pkg\\node_modules\\x\\a.js')).toBe(true)
    expect(ignoredPath('src/.gitignore')).toBe(false)
  })
})

describe('placeholders', () => {
  test('filled in one pass: a value is never read again', () => {
    expect(expandPrompt('Check {{files}} from {{node}}', { files: '{{node}}.ts', node: 'Builder' })).toBe('Check {{node}}.ts from Builder')
  })

  test('\\{{ writes a literal {{ and names nothing', () => {
    expect(placeholdersIn('use \\{{node}} literally, and {{event}}')).toEqual(['event'])
    expect(expandPrompt('use \\{{node}} literally', { node: 'X' })).toBe('use {{node}} literally')
  })

  test('each kind names what it has, and arming refuses the rest', () => {
    expect(placeholderProblem('{{files}}', { type: 'agent', nodeId: 'a', on: 'turn' })).toMatch(/no \{\{files\}\}.*\{\{node\}\}/)
    expect(placeholderProblem('{{exitCode}} {{node}}', { type: 'run', nodeId: 'r', failedOnly: true })).toBeNull()
    // A schedule sends its prompt as written, so braces in it are nobody's business.
    expect(placeholderProblem('{{whatever}}', { type: 'interval', everyMs: 60_000 })).toBeNull()
  })

  test('event values', () => {
    const files = Array.from({ length: 22 }, (_, i) => `f${i}.ts`)
    const v = eventVars({ type: 'files', folder: root, files: files.slice(0, 20), total: 22 }, 0)
    expect(v.files).toMatch(/^`f0.ts`, `f1.ts`.*`f19.ts` and 2 more$/)
    expect(eventVars({ type: 'run', nodeTitle: 'npm test', exitCode: 1 }, 0)).toMatchObject({ node: 'npm test', exitCode: '1', event: '"npm test" failed with exit code 1' })
    expect(eventVars(null, 0).event).toBe('run by hand')
  })
})

describe('folders', () => {
  test('inside the project, a worktree or a session folder only', () => {
    const roots = projectRoots(
      { nodes: [claudeNode('a', { cwd: 'D:\\elsewhere', projectId: 'p' }), claudeNode('b', { cwd: 'E:\\other', projectId: 'q' })], projects: doc([]).projects },
      'p'
    )
    expect(roots).toContain(root)
    expect(roots).toContain('D:\\elsewhere')
    expect(roots).not.toContain('E:\\other')
    expect(folderProblem(inRoot('src'), roots, 'it watches')).toBeNull()
    expect(folderProblem('D:\\elsewhere\\x', roots, 'it watches')).toBeNull()
    expect(folderProblem('E:\\other', roots, 'it watches')).toMatch(/inside the project/)
    expect(folderProblem(inRoot('..\\..\\x'), roots, 'it watches')).toMatch(/\.\./)
    expect(folderProblem('src', roots, 'it watches')).toMatch(/full path/)
  })

  test('a sibling with the same prefix is not inside', () => {
    expect(isInside('C:\\work\\app2', 'C:\\work\\app')).toBe(false)
    expect(isInside('c:/WORK/app/src', 'C:\\work\\app\\')).toBe(true)
  })
})

describe('preflight', () => {
  test('split into arguments, with shell syntax refused', () => {
    expect(preflightArgv('  npm   test ')).toEqual({ ok: true, argv: ['npm', 'test'] })
    expect(preflightArgv('')).toEqual({ ok: true, argv: null })
    expect(preflightArgv('npm test && rm -rf x')).toMatchObject({ ok: false })
    expect(preflightArgv('echo "hi"')).toMatchObject({ ok: false })
  })
})

describe('arming an event trigger', () => {
  const agent = claudeNode('a', { title: 'Builder', projectId: 'p', cwd: root })
  const target = terminalNode('t', { projectId: 'p', cwd: root })
  const make = (over: Partial<TriggerNode>) => triggerNode('tr', { projectId: 'p', ...over })

  test('an event has no next time, and isn\'t refused for it', () => {
    const s = { type: 'agent' as const, nodeId: 'a', on: 'turn' as const }
    expect(nextRun(s, 0, 0)).toBeNull()
    expect(scheduleError(s)).toBeNull()
    expect(armRefusal(make({ schedule: s }), doc([agent, target]), 0)).toBeNull()
  })

  test('the watched node must exist, be the right kind, and be in the project', () => {
    expect(armRefusal(make({ schedule: { type: 'agent', nodeId: 'gone', on: 'turn' } }), doc([agent, target]), 0)).toMatch(/agent it watches is gone/)
    expect(armRefusal(make({ schedule: { type: 'run', nodeId: 'a', failedOnly: true } }), doc([agent, target]), 0)).toMatch(/run node it watches is gone/)
    const elsewhere = claudeNode('x', { projectId: 'q' })
    expect(armRefusal(make({ schedule: { type: 'agent', nodeId: 'x', on: 'exit' } }), doc([agent, target, elsewhere]), 0)).toMatch(/another project/)
  })

  test('files: folder inside the project, a pattern, a sane quiet time', () => {
    const files = (over: object) => make({ schedule: { type: 'files', folder: inRoot('src'), glob: '*.ts', quietMs: 5000, ...over } })
    expect(armRefusal(files({}), doc([target]), 0)).toBeNull()
    expect(armRefusal(files({ folder: process.platform === 'win32' ? 'Z:\\x' : '/elsewhere' }), doc([target]), 0)).toMatch(/inside the project/)
    expect(armRefusal(files({ glob: ' ' }), doc([target]), 0)).toMatch(/pattern/)
    expect(armRefusal(files({ quietMs: 10 }), doc([target]), 0)).toMatch(/quiet time/)
  })

  test('limits and the check are checked too', () => {
    const s = { type: 'agent' as const, nodeId: 'a', on: 'turn' as const }
    expect(armRefusal(make({ schedule: s, limits: { gapMs: 10, perHour: 5 } }), doc([agent, target]), 0)).toMatch(/gap/)
    expect(armRefusal(make({ schedule: s, limits: { gapMs: 60_000, perHour: 0 } }), doc([agent, target]), 0)).toMatch(/an hour/)
    expect(armRefusal(make({ schedule: s, preflight: { argv: ['npm', 'test'], cwd: process.platform === 'win32' ? 'Z:\\x' : '/x' } }), doc([agent, target]), 0)).toMatch(/check runs in/)
    expect(armRefusal(make({ schedule: s, prompt: 'see {{files}}' }), doc([agent, target]), 0)).toMatch(/\{\{files\}\}/)
  })

  test('described exactly, with the node\'s name', () => {
    expect(describeSchedule({ type: 'agent', nodeId: 'a', on: 'needs-you' }, () => 'Builder')).toBe('When "Builder" needs you')
    expect(describeEvent({ type: 'run', nodeId: 'r', failedOnly: true })).toBe('When "a run node that is gone" fails (non-zero exit)')
    expect(describeSchedule({ type: 'files', folder: root, glob: '*.ts', quietMs: 5000 })).toBe(`When files matching *.ts change in ${root}, after 5 seconds quiet`)
  })
})

describe('loading saved triggers', () => {
  const save = (trigger: object) => ({
    version: 3,
    projects: [{ id: 'p', name: 'App', folder: root, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [{ ...triggerNode('tr', { projectId: 'p' }), ...trigger }],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })

  test('one saved before event kinds loads unchanged', () => {
    const old = { schedule: { type: 'cron', expr: '0 9 * * *' }, armedSpec: 'x', armedAt: 1, nextAt: 2, runs: [{ id: 'r', at: 1, source: 'schedule', outcome: 'missed', detail: 'd' }] }
    const loaded = migrate(save(old)).nodes[0] as TriggerNode
    expect(loaded).toMatchObject(old)
    expect(loaded.preflight).toBeUndefined()
    expect(loaded.limits).toBeUndefined()
  })

  test('event kinds, checks, limits and skipped runs load', () => {
    const now = {
      schedule: { type: 'files', folder: root, glob: '*.ts', quietMs: 5000 },
      preflight: { argv: ['npm', 'test'], cwd: root },
      limits: { gapMs: 30000, perHour: 10 },
      runs: [{ id: 'r', at: 1, source: 'event', outcome: 'skipped', detail: 'd', event: 'e', repeats: 3, preflight: { code: 1, tail: 't' } }]
    }
    expect(migrate(save(now)).nodes[0]).toMatchObject(now)
    for (const s of [{ type: 'agent', nodeId: 'a', on: 'turn' }, { type: 'run', nodeId: 'r', failedOnly: false }]) expect(migrate(save({ schedule: s })).nodes[0]).toMatchObject({ schedule: s })
  })

  test('damaged ones are refused', () => {
    expect(() => migrate(save({ schedule: { type: 'agent', nodeId: 'a', on: 'sometimes' } }))).toThrow(/invalid nodes/)
    expect(() => migrate(save({ preflight: { argv: 'npm test', cwd: root } }))).toThrow(/invalid nodes/)
  })
})

describe('what goes out', () => {
  test('a value for a terminal keeps only characters a shell does nothing with', async () => {
    const { terminalSafe } = await import('../../src/core/trigger/events')
    expect(terminalSafe('src/a b.ts, C:/x/y.ts')).toBe('src/a b.ts, C:/x/y.ts')
    expect(terminalSafe('"npm test" finished')).toBe('npm test finished')
    expect(terminalSafe('a;b&c|d$e`f<g>h(i)%j^k!l\nm')).toBe('a_b_c_d_e_f_g_h_i__j_k_l_m')
  })

  test('a check\'s output loses its colours and control codes', async () => {
    const { outputTail } = await import('../../src/core/trigger/events')
    expect(outputTail('\x1b[2m> node --version\x1b[0m\r\nv22.19.0\x07\n')).toBe('> node --version\nv22.19.0')
    expect(outputTail('x'.repeat(1000))).toHaveLength(401)
  })
})

describe('placeholder values by target', () => {
  test('for a terminal: one argument each, no options, no shell characters; for an agent: names marked as data', async () => {
    const { eventVars } = await import('../../src/core/trigger/events')
    const e = { type: 'files' as const, folder: root, files: ['-rf x', 'a`b.ts'], total: 3 }
    expect(eventVars(e, 0, 'terminal').files).toBe('./-rf x a_b.ts')
    expect(eventVars(e, 0, 'claude').files).toBe("`-rf x`, `a'b.ts` and 1 more")
    expect(eventVars({ type: 'run', nodeTitle: 'say "hi"; ls', exitCode: -1 }, 0, 'terminal')).toMatchObject({ node: 'say hi_ ls', exitCode: '-1' })
  })
})

describe('loops between triggers', () => {
  const nodes = [claudeNode('A', { title: 'Builder', projectId: 'p', cwd: root }), claudeNode('B', { title: 'Reviewer', projectId: 'p', cwd: root }), terminalNode('T', { projectId: 'p', cwd: root })]
  const agentTrig = (id: string, watch: string, to: string, armed = true): TriggerNode => {
    const n = triggerNode(id, { title: id, projectId: 'p', schedule: { type: 'agent', nodeId: watch, on: 'turn' }, targetId: to })
    return armed ? { ...n, armedSpec: canonicalSpec(n) } : n
  }
  const d = (...t: TriggerNode[]) => ({ ...doc([...nodes, ...t]) })

  test('A\'s turn fires B and B\'s turn fires A: arming the second is refused, naming both', () => {
    const one = agentTrig('one', 'A', 'B')
    const two = agentTrig('two', 'B', 'A', false)
    expect(armRefusal(two, d(one, two), 0)).toBe('Arming it would make a loop: "two" sends to "Builder", then "one" sends to "Reviewer", which sets it off again. Disarm one of them, or change what it watches or sends to.')
    // A disarmed partner is no loop.
    expect(armRefusal(two, d({ ...one, armedSpec: null }, two), 0)).toBeNull()
  })

  test('longer chains count; a trigger sending to what it watches is not a loop (its own turn never fires it)', () => {
    const c = [agentTrig('ab', 'A', 'B'), agentTrig('bt', 'B', 'T')]
    expect(armRefusal(agentTrig('self', 'A', 'A', false), d(...c), 0)).toBeNull()
    // A terminal has no turns, so nothing watches it as an agent: no chain back from T.
    expect(armRefusal(agentTrig('ta', 'B', 'A', false), d(agentTrig('ab', 'A', 'B')), 0)).toMatch(/loop/)
  })

  test('a file trigger counts every session working in that folder as able to set it off', () => {
    const files = triggerNode('files', { title: 'files', projectId: 'p', schedule: { type: 'files', folder: inRoot('src'), glob: '*.ts', quietMs: 5000 }, targetId: 'B' })
    const back = agentTrig('back', 'B', 'A')
    expect(armRefusal(files, d(back, files), 0)).toMatch(/"files" sends to "Reviewer", then "back" sends to "Builder"/)
    // Elsewhere, no loop.
    const elsewhere = { ...files, schedule: { type: 'files' as const, folder: inRoot('src'), glob: '*.ts', quietMs: 5000 } }
    const away = [claudeNode('A', { title: 'Builder', projectId: 'p', cwd: process.platform === 'win32' ? 'D:\other' : '/other' }), nodes[1], nodes[2]]
    expect(armRefusal(elsewhere, { nodes: [...away, back, elsewhere], projects: doc([]).projects }, 0)).toBeNull()
  })
})
