import { describe, expect, test } from 'vitest'
import type { TriggerSchedule } from '../../src/shared/model'
import { draftOf, extrasDraftOf, extrasOf, nextLabel, OUTCOME_LABELS, scheduleOf } from '../../src/renderer/triggerView'
import { triggerNode } from '../trigger/fixtures'

describe('the form for event kinds', () => {
  test('each kind goes to a draft and back unchanged', () => {
    const kinds: TriggerSchedule[] = [
      { type: 'agent', nodeId: 'a', on: 'needs-you' },
      { type: 'run', nodeId: 'r', failedOnly: false },
      { type: 'files', folder: 'C:\\app\\src', glob: '**/*.ts', quietMs: 2500 }
    ]
    for (const s of kinds) expect(scheduleOf(draftOf(s, 0))).toEqual(s)
  })

  test('a new file trigger starts in the project folder, with sane defaults', () => {
    const d = draftOf({ type: 'interval', everyMs: 60_000 }, 0, 'C:\\app')
    expect(scheduleOf({ ...d, type: 'files' })).toEqual({ type: 'files', folder: 'C:\\app', glob: '**/*', quietMs: 5000 })
    expect(scheduleOf({ ...d, type: 'run' })).toEqual({ type: 'run', nodeId: '', failedOnly: true })
  })

  test('check and limits', () => {
    const agent: TriggerSchedule = { type: 'agent', nodeId: 'a', on: 'turn' }
    const blank = extrasDraftOf(undefined, 'C:\\app')
    expect(extrasOf(blank, agent)).toEqual({ preflight: null, limits: { gapMs: 30_000, perHour: 10 }, problem: null })
    expect(extrasOf({ ...blank, command: 'npm run lint' }, { type: 'interval', everyMs: 60_000 })).toEqual({ preflight: { argv: ['npm', 'run', 'lint'], cwd: 'C:\\app' }, limits: undefined, problem: null })
    expect(extrasOf({ ...blank, command: 'a | b' }, agent).problem).toMatch(/without a shell/)
    const saved = extrasDraftOf({ preflight: { argv: ['npm', 'test'], cwd: 'C:\\x' }, limits: { gapMs: 60_000, perHour: 3 } }, 'C:\\app')
    expect(saved).toEqual({ command: 'npm test', cwd: 'C:\\x', gapSeconds: '60', perHour: '3' })
  })

  test('the node says it listens instead of a next time', () => {
    const n = triggerNode('tr', { schedule: { type: 'agent', nodeId: 'a', on: 'turn' } })
    expect(nextLabel(n, 0)).toBe('Arm it to listen for it.')
    expect(OUTCOME_LABELS.skipped).toBe('Skipped')
  })
})
