import { describe, expect, test } from 'vitest'
import { addInput, addStep, blankWorkflow, choicesFor, chipsIn, insertAt, moveStep, removeStep, uniqueKey, updateInput, updateStep, usesOfInput, usesOfStep } from '../../src/renderer/workflows/editModel'
import { chipRuns, earlierAttempts, needsPerson, runStrip, runSubject } from '../../src/renderer/workflows/runView'
import { workflowIssues, type Workflow, type WorkflowRun } from '../../src/shared/workflow'
import { createRun, advance } from '../../src/core/workflow/engine'
import { featureWorkflow } from './fixtures'

describe('the outline editor', () => {
  test('building a workflow from blank with Add step and the value picker, without typing an expression', () => {
    let wf: Workflow = { ...blankWorkflow('Ship it') }
    const plan = addStep(wf, 'agent')
    wf = updateStep(plan.wf, plan.key, (s) => ({ ...s, title: 'Plan' }))
    const brief = choicesFor(wf, plan.key).find((c) => c.label === 'Brief')!
    wf = updateStep(wf, plan.key, (s) => (s.kind === 'agent' ? { ...s, prompt: insertAt('Plan: ', 6, brief.token).text, outputs: [{ key: 'doc', label: 'Plan document', type: 'file' }] } : s))
    const review = addStep(wf, 'review')
    wf = review.wf
    const doc = choicesFor(wf, review.key).find((c) => c.label === 'Plan › Plan document')!
    wf = updateStep(wf, review.key, (s) => (s.kind === 'review' ? { ...s, show: [doc.binding] } : s))
    const tests = addStep(wf, 'command')
    wf = updateStep(tests.wf, tests.key, (s) => (s.kind === 'command' ? { ...s, run: ['npm', 'test'] } : s))
    expect(workflowIssues(wf)).toEqual([])
    expect(wf.steps.map((s) => s.key)).toEqual(['agent', 'review', 'command'])
    expect(chipsIn(wf, 'review', '{{out:agent.doc}}')).toEqual([{ token: '{{out:agent.doc}}', label: 'Plan › Plan document', known: true }])
  })

  test('only earlier steps are offered', () => {
    const wf = featureWorkflow()
    expect(choicesFor(wf, 'approve').map((c) => c.label)).toEqual(['Feature brief', 'Implementer', 'Test filter', 'Attempts', 'Plan › Plan document', 'Plan › summary'])
    expect(choicesFor(wf, 'plan').map((c) => c.label)).toEqual(['Feature brief', 'Implementer', 'Test filter', 'Attempts'])
  })

  test('moving a step after one that uses it shows up as an issue, never silently', () => {
    const wf = moveStep(featureWorkflow(), 'plan', 1)
    expect(wf.steps.map((s) => s.key)).toEqual(['approve', 'plan', 'implement', 'tests'])
    expect(workflowIssues(wf).map((i) => i.step)).toContain('approve')
    expect(moveStep(featureWorkflow(), 'plan', -1)).toEqual(featureWorkflow())
  })

  test('renaming a step keeps references; deleting one says what used it', () => {
    const renamed = updateStep(featureWorkflow(), 'plan', (s) => ({ ...s, title: 'Design' }))
    expect(workflowIssues(renamed)).toEqual([])
    expect(chipsIn(renamed, 'implement', '{{out:plan.doc}}')[0].label).toBe('Design › Plan document')
    expect(usesOfStep(featureWorkflow(), 'plan')).toEqual(['Approve plan', 'Implement'])
    expect(usesOfStep(featureWorkflow(), 'plan', 'summary')).toEqual(['Implement'])
    const gone = removeStep(featureWorkflow(), 'plan')
    expect(workflowIssues(gone).length).toBeGreaterThan(0)
    expect(chipsIn(gone, 'implement', '{{out:plan.doc}}')[0]).toMatchObject({ known: false })
  })

  test('inputs: added with unique keys; options only for choices; defaults dropped when the type changes', () => {
    let wf = addInput(blankWorkflow('x'))
    expect(wf.inputs.map((i) => i.key)).toEqual(['brief', 'input'])
    expect(addInput(wf).inputs[2].key).toBe('input-2')
    wf = updateInput(wf, 1, { type: 'enum' })
    expect(wf.inputs[1].options).toEqual(['option'])
    wf = updateInput(wf, 1, { default: 'option' })
    wf = updateInput(wf, 1, { type: 'text' })
    expect(wf.inputs[1]).toEqual({ key: 'input', label: 'New input', type: 'text' })
    expect(usesOfInput(featureWorkflow(), 'brief')).toEqual(['Plan', 'Approve plan'])
  })

  test('keys', () => {
    expect(uniqueKey('Run the tests!', ['run-the-tests'])).toBe('run-the-tests-2')
    expect(uniqueKey('123', [])).toBe('step')
  })
})

describe('the run panel\'s words', () => {
  const run = (): WorkflowRun => {
    let n = 0
    const r = createRun({ workflow: featureWorkflow(), hash: 'h', ref: 'r', id: 'r1', projectId: 'p', inputs: { brief: 'Dark mode for the whole settings page, every section of it, including the advanced one' }, cwd: 'C:\\wt', worktree: null, groupId: null }, { now: 1, newId: () => `n${++n}` })
    if (!r.ok) throw new Error('bad')
    return r.run
  }

  test('the strip says where the run is', () => {
    let r = run()
    expect(runStrip(r)).toBe('Step 1 of 4 · Plan starting')
    const go = (e: Parameters<typeof advance>[1]) => { const x = advance(r, e, { now: 2, newId: () => 'nx' }); if (!x.ok) throw new Error(x.message); r = x.run }
    go({ type: 'launched', attemptId: 'r1:plan:1' })
    go({ type: 'idle', nodeId: 'n1' })
    expect(runStrip(r)).toBe('Step 1 of 4 · Plan idle, no result')
    expect(needsPerson(r)).toBe(true)
    go({ type: 'node-gone', nodeId: 'n1' })
    go({ type: 'retry', step: 'plan' })
    expect(earlierAttempts(r, 'plan').map((a) => a.state)).toEqual(['interrupted'])
    expect(runSubject(r)).toBe('Dark mode for the whole settings page, every section of it,…')
  })

  test('chips: what is going, and what ended recently', () => {
    const going = run()
    const old = { ...run(), id: 'r2', state: 'succeeded' as const, endedAt: 0 }
    const recent = { ...run(), id: 'r3', state: 'stopped' as const, endedAt: 1_000_000 }
    expect(chipRuns([going, old, recent], 1_000_100).map((r) => r.id)).toEqual(['r1', 'r3'])
  })
})
