import { describe, expect, test } from 'vitest'
import { validateDefinition } from '../../src/core/workflow/validate'
import { BUILT_IN_ACTIONS, type ActionCatalog } from '../../src/core/workflow/catalog'
import type { IssueCode, WorkflowDefinition } from '../../src/shared/workflow'
import { featureWorkflow } from './fixtures'

const issues = (def: WorkflowDefinition, catalog?: ActionCatalog) => validateDefinition(def, catalog)
const codes = (def: WorkflowDefinition) => issues(def).map((i) => i.code)
const only = (def: WorkflowDefinition, code: IssueCode) => {
  const all = issues(def)
  expect(all.map((i) => i.code)).toEqual([code])
  return all[0]
}
const edit = (change: (d: WorkflowDefinition) => void): WorkflowDefinition => {
  const d = featureWorkflow()
  change(d)
  return d
}

describe('validation', () => {
  test('the proving workflow is valid', () => {
    expect(issues(featureWorkflow())).toEqual([])
  })

  describe('missing inputs', () => {
    test('a required parameter that isn\'t set', () => {
      const i = only(edit((d) => { delete d.jobs[0].inputs.instructions }), 'missing-input')
      expect(i.path).toBe('jobs.plan.inputs.instructions')
      expect(i.jobId).toBe('plan')
      expect(i.message).toBe('Instructions of "Plan" isn\'t set. Choose a value, a workflow input or an earlier job\'s output.')
    })

    test('a parameter with a default can be left out', () => {
      expect(codes(edit((d) => { delete d.jobs[0].inputs.agent }))).toEqual([])
    })

    test('a required parameter fed by an optional input with no default', () => {
      const all = issues(edit((d) => { d.inputs[0].required = false }))
      // Every job that needs the repository says so.
      expect(all.map((i) => i.jobId)).toEqual(['plan', 'implement', 'tests', 'review'])
      expect(all[0].message).toContain('Workspace of "Plan" is required, but input "Repository" can be left empty')
    })

    test('a required parameter fed by an optional output', () => {
      const i = only(edit((d) => { d.jobs[3].inputs.program = { from: 'job', job: 'approve', output: 'feedback' } }), 'missing-input')
      expect(i.message).toContain('Approve plan → Feedback can be left empty')
    })

    test('optional sources are fine in text and lists', () => {
      // The fixture already puts optional feedback in a prompt and an optional input in the test arguments.
      expect(issues(featureWorkflow())).toEqual([])
    })
  })

  describe('type mismatches', () => {
    test('text input into a workspace parameter', () => {
      const i = only(edit((d) => { d.jobs[0].inputs.workspace = { from: 'input', input: 'brief' } }), 'type-mismatch')
      expect(i.message).toBe('Workspace of "Plan" needs a workspace, but input "Feature brief" is text.')
    })

    test('a constant of the wrong type, or not one of the choices', () => {
      expect(only(edit((d) => { d.jobs[0].inputs.agent = { from: 'const', value: 'gemini' } }), 'type-mismatch').message)
        .toContain('"gemini" isn\'t one of the choices (claude, codex)')
      expect(only(edit((d) => { d.jobs[3].inputs.folder = { from: 'const', value: 'C:/x' } }), 'type-mismatch').message)
        .toContain('Folder of "Integration tests" must be a workspace')
    })

    test('an enum whose choices aren\'t all allowed', () => {
      expect(only(edit((d) => { d.inputs[2].options = ['claude', 'codex', 'gemini'] }), 'type-mismatch').message)
        .toContain('Agent of "Implement" needs a choice of claude / codex')
    })

    test('numbers, booleans and choices go into text; nothing else is converted', () => {
      expect(codes(edit((d) => { d.jobs[4].inputs.instructions = { from: 'job', job: 'tests', output: 'exitCode' } }))).toEqual([])
      expect(codes(edit((d) => { d.jobs[1].inputs.question = { from: 'job', job: 'plan', output: 'plan' } }))).toEqual(['type-mismatch'])
      expect(codes(edit((d) => { d.jobs[3].inputs.program = { from: 'const', value: 3 } }))).toEqual(['type-mismatch'])
    })

    test('text with chips only fills text; lists only fill lists', () => {
      expect(only(edit((d) => { d.jobs[0].inputs.workspace = { from: 'template', parts: ['x'] } }), 'type-mismatch').message)
        .toContain("can't be text with values filled in")
      expect(only(edit((d) => { d.jobs[3].inputs.program = { from: 'list', items: [] } }), 'type-mismatch').message).toContain('not a list')
      expect(only(edit((d) => { d.jobs[3].inputs.args = { from: 'list', items: [{ from: 'input', input: 'repo' }] } }), 'type-mismatch').message)
        .toBe('Each item of Arguments of "Integration tests" needs text, but input "Repository" is a workspace.')
    })

    test('a bad default for an input', () => {
      expect(only(edit((d) => { d.inputs[2].default = 'gemini' }), 'bad-default').message).toContain('isn\'t one of the choices')
    })

    test('a choice with no options, or options on something that isn\'t a choice', () => {
      expect(codes(edit((d) => { d.inputs[2].options = []; delete d.inputs[2].default }))).toContain('bad-option')
      expect(codes(edit((d) => { d.inputs[1].options = ['a'] }))).toEqual(['bad-option'])
    })
  })

  describe('dangling references', () => {
    test('a workflow input that doesn\'t exist', () => {
      const i = only(edit((d) => { d.jobs[0].inputs.workspace = { from: 'input', input: 'repository' } }), 'dangling-input')
      expect(i.message).toContain('uses a workflow input "repository" that doesn\'t exist')
    })

    test('a job that doesn\'t exist', () => {
      expect(only(edit((d) => { d.jobs.splice(1, 1); d.jobs[1].inputs.instructions = { from: 'template', parts: [{ job: 'approve', output: 'feedback' }] } }), 'dangling-job').path)
        .toBe('jobs.implement.inputs.instructions.parts.0')
    })

    test('an output a job doesn\'t have lists the ones it does', () => {
      const i = issues(edit((d) => { d.jobs[0].outputs = [{ key: 'design', type: 'file' }] }))[0]
      expect(i.code).toBe('dangling-output')
      expect(i.message).toBe('Job "Approve plan" reads "plan" from "Plan", but "Plan" has no output called "plan". Its outputs are: summary, design.')
      // Implement reads it too, through a chip: one issue per place it's read.
      expect(issues(edit((d) => { d.jobs[0].outputs = [] })).map((x) => x.path))
        .toEqual(['jobs.approve.inputs.material.parts.0', 'jobs.implement.inputs.instructions.parts.1'])
    })

    test('waiting for a job that doesn\'t exist', () => {
      expect(only(edit((d) => { d.jobs[4].after = ['lint'] }), 'dangling-job').message).toContain('waits for a job "lint"')
    })

    test('a workflow output from nowhere', () => {
      expect(only(edit((d) => { d.outputs = [{ key: 'x', from: { job: 'review', output: 'nope' } }] }), 'dangling-output').message)
        .toContain('The workflow reads "nope" from "Review"')
    })

    test('renaming a job keeps its bindings; only its id is referenced', () => {
      expect(issues(edit((d) => { d.jobs[0].name = 'Write the plan' }))).toEqual([])
    })
  })

  describe('cycles', () => {
    test('a job reading its own output', () => {
      expect(only(edit((d) => { d.jobs[0].inputs.instructions = { from: 'job', job: 'plan', output: 'summary' } }), 'cycle').message)
        .toContain('reads its own output')
    })

    test('a job waiting for itself', () => {
      expect(only(edit((d) => { d.jobs[0].after = ['plan'] }), 'cycle').message).toContain('waits for itself')
    })

    test('a loop names the jobs in the order work would flow', () => {
      const step = (id: string, name: string, after: string[]) => ({ id, name, action: 'human-review', inputs: { question: { from: 'const' as const, value: '?' } }, after })
      const def: WorkflowDefinition = { schema: 1, id: 'w', name: 'W', inputs: [], jobs: [step('a', 'Build', ['c']), step('b', 'Test', ['a']), step('c', 'Ship', ['b'])] }
      expect(only(def, 'cycle').message).toBe('These jobs depend on each other in a loop: Build → Test → Ship → Build. Workflows run in one direction; remove one of the links.')
    })

    test('every loop through the proving workflow is reported', () => {
      // Implement reads Plan directly and Review reads Implement directly, so closing the loop makes two.
      const all = issues(edit((d) => { d.jobs[0].after = ['review'] }))
      expect(all.map((i) => i.code)).toEqual(['cycle', 'cycle'])
      expect(all.every((i) => i.message.includes('Review → Plan'))).toBe(true)
    })

    test('two jobs depending on each other', () => {
      expect(only(edit((d) => { d.jobs[0].after = ['approve'] }), 'cycle').message).toContain('Plan → Approve plan → Plan')
    })
  })

  describe('actions', () => {
    test('an action this Patchbay doesn\'t have lists the available ones', () => {
      expect(only(edit((d) => { d.jobs[3].action = 'shell' }), 'unknown-action').message)
        .toBe('Job "Integration tests" uses an action "shell" this Patchbay doesn\'t have. Available: agent, command, human-review.')
    })

    test('an unavailable action says why', () => {
      const def = edit((d) => { d.jobs.push({ id: 'mail', name: 'Email me', action: 'email', inputs: { to: { from: 'const', value: ['me@example.com'] }, subject: { from: 'const', value: 'Done' }, body: { from: 'const', value: 'x' } } }) })
      expect(only(def, 'action-unavailable').message).toContain("Patchbay can't send email yet")
    })

    test('availability comes from the catalog given', () => {
      const catalog = BUILT_IN_ACTIONS.map((a) => (a.id === 'command' ? { ...a, unavailable: 'Commands are turned off.' } : a))
      expect(issues(featureWorkflow(), catalog).map((i) => i.code)).toEqual(['action-unavailable'])
    })

    test('a job with no action', () => {
      expect(only(edit((d) => { d.jobs[1].action = '' }), 'unknown-action').message).toContain('has no action')
    })

    test('a parameter the action doesn\'t take', () => {
      expect(only(edit((d) => { d.jobs[3].inputs.shell = { from: 'const', value: 'bash' } }), 'unknown-parameter').message)
        .toContain('It takes: program, args, folder')
    })

    test('fixed-output actions can\'t declare outputs', () => {
      expect(only(edit((d) => { d.jobs[3].outputs = [{ key: 'report', type: 'file' }] }), 'outputs-not-allowed').message)
        .toContain('Run command has fixed outputs (exitCode, log)')
    })
  })

  describe('keys and limits', () => {
    test('duplicate keys', () => {
      expect(codes(edit((d) => { d.inputs.push({ key: 'brief', label: 'Again', type: 'text' }) }))).toEqual(['duplicate-key'])
      expect(codes(edit((d) => { d.jobs.push({ ...d.jobs[4] }) }))).toEqual(['duplicate-key'])
      expect(codes(edit((d) => { d.jobs[0].outputs!.push({ key: 'summary', type: 'text' }) }))).toEqual(['duplicate-key'])
    })

    test('keys must be plain', () => {
      expect(codes(edit((d) => { d.inputs[1].key = 'the brief' }))).toContain('shape')
    })

    test('bounded retries and sensible time limits', () => {
      expect(codes(edit((d) => { d.jobs[3].limits = { retries: 9 } }))).toEqual(['bad-limit'])
      expect(codes(edit((d) => { d.jobs[3].limits = { retries: 1.5 } }))).toEqual(['bad-limit'])
      expect(codes(edit((d) => { d.jobs[3].limits = { timeoutMs: 10 } }))).toEqual(['bad-limit'])
    })

    test('an empty workflow is saveable but not runnable', () => {
      expect(codes({ schema: 1, id: 'x', name: '', inputs: [], jobs: [] })).toEqual(['empty', 'empty'])
    })
  })
})
