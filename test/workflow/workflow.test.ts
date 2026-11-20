import { describe, expect, test } from 'vitest'
import { readWorkflow, readWorkflowShape, templateRefs, workflowFileName, workflowIssues, WorkflowError, type Step, type Workflow } from '../../src/shared/workflow'
import { featureWorkflow } from './fixtures'

const messages = (wf: Workflow): string[] => workflowIssues(wf).map((i) => i.message)
const edit = (change: (w: Workflow) => void): Workflow => {
  const w = featureWorkflow()
  change(w)
  return w
}
const step = (w: Workflow, key: string) => w.steps.find((s) => s.key === key) as Step & Record<string, unknown>
const shapeError = (raw: unknown): WorkflowError => {
  try { readWorkflowShape(raw) } catch (e) { if (e instanceof WorkflowError) return e; throw e }
  throw new Error('read without error')
}
const raw = (): Record<string, any> => JSON.parse(JSON.stringify(featureWorkflow()))

describe('reading a workflow', () => {
  test('the proving workflow is valid and round-trips through JSON', () => {
    expect(workflowIssues(featureWorkflow())).toEqual([])
    expect(readWorkflow(raw())).toEqual(featureWorkflow())
  })

  test('defaults fill in what a file leaves out', () => {
    const wf = readWorkflowShape({ schema: 1, name: ' Small ', steps: [{ kind: 'agent', key: 'a', prompt: 'Go' }] })
    expect(wf).toEqual({ schema: 1, name: 'Small', inputs: [], steps: [{ kind: 'agent', key: 'a', title: 'a', agent: 'claude', prompt: 'Go', outputs: [] }] })
  })

  test('fields this version doesn\'t know are refused, never dropped', () => {
    const r = raw()
    r.steps[3].shell = true
    expect(shapeError(r).message).toBe('Step "tests": "shell" isn\'t a field this version of Patchbay knows, so the workflow can\'t be used as written.')
    expect(shapeError({ ...raw(), schedule: 'daily' }).issues[0].path).toBe('schedule')
  })

  test('a newer schema says so', () => {
    expect(shapeError({ ...raw(), schema: 2 }).message).toMatch(/newer Patchbay \(schema 2\)/)
  })

  test('unknown kinds, agents and malformed shows name the step', () => {
    const r = raw()
    r.steps[0].kind = 'email'
    expect(shapeError(r).message).toBe('Step "plan": "kind" must be agent, command or review, not "email".')
    const r2 = raw()
    r2.steps[0].agent = 'gemini'
    expect(shapeError(r2).message).toContain('"agent" must be claude or codex')
    const r3 = raw()
    r3.steps[1].show = [{ step: 'plan' }]
    expect(shapeError(r3).message).toContain('{"step": KEY, "output": KEY}')
    const r4 = raw()
    r4.steps[2].timeoutMin = 0
    expect(shapeError(r4).message).toContain('"timeoutMin" must be a whole number')
  })

  test('readWorkflow throws with every issue', () => {
    const r = raw()
    r.steps[0].prompt = ''
    r.inputs[1].options = []
    try { readWorkflow(r); throw new Error('no throw') } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError)
      expect((e as WorkflowError).issues).toHaveLength(3) // The empty choice also makes its default wrong.
      expect((e as WorkflowError).message).toMatch(/\(and 2 more\)$/)
    }
  })

  test('references are found, with spaces allowed', () => {
    expect(templateRefs('a {{in:x}} b {{ out:plan.doc }} {{out:plan}} {{ task }}')).toEqual([
      { whole: '{{in:x}}', input: 'x' },
      { whole: '{{ out:plan.doc }}', step: 'plan', output: 'doc' },
      { whole: '{{out:plan}}', bad: true }
    ])
  })

  test('file names', () => {
    expect(workflowFileName('Plan & Ship!')).toBe('plan-ship.json')
  })
})

describe('issues', () => {
  test('a dangling {{out:}} names what exists', () => {
    expect(messages(edit((w) => { step(w, 'implement').prompt = 'Use {{out:design.doc}}' }))).toEqual(['Step "Implement" uses "design.doc", but there\'s no step "design".'])
    expect(messages(edit((w) => { step(w, 'implement').prompt = 'Use {{out:plan.notes}}' }))).toEqual(['Step "Implement" uses "notes" from "Plan", which has no such output. Its outputs: doc, summary.'])
    expect(messages(edit((w) => { step(w, 'approve').show = [{ step: 'plan', output: 'nope' }] }))).toEqual(['Step "Approve plan" uses "nope" from "Plan", which has no such output. Its outputs: doc, summary.'])
  })

  test('a step can only use earlier steps', () => {
    expect(messages(edit((w) => { step(w, 'plan').prompt = 'After {{out:implement.summary}}' }))).toEqual(['Step "Plan" uses "Implement", which runs after it. A step can only use outputs of the steps before it.'])
    expect(messages(edit((w) => { step(w, 'plan').prompt = 'Mine {{out:plan.summary}}' }))).toEqual(['Step "Plan" uses its own output. A step can only use outputs of the steps before it.'])
  })

  test('an unknown input, and a malformed reference', () => {
    expect(messages(edit((w) => { step(w, 'plan').prompt = '{{in:breif}}' }))).toEqual(['Step "Plan" uses an input "breif" that isn\'t in this workflow. Inputs: brief, implementer, filter, attempts.'])
    expect(messages(edit((w) => { step(w, 'plan').prompt = 'x {{out:plan}}' }))).toEqual(['Step "Plan": {{out:plan}} isn\'t a reference. Use {{in:KEY}} or {{out:STEP.OUTPUT}}.'])
  })

  describe('commands', () => {
    test('values never go into a shell or after an eval flag', () => {
      expect(messages(edit((w) => { step(w, 'tests').run = ['cmd', '/c', 'echo {{in:brief}}'] }))).toEqual([
        'Step "Tests" puts a value right after "/c", where it would run as code. Pass it as data instead.',
        'Step "Tests" puts values into "cmd", which would read them as commands. Run the tool itself instead, like ["npm", "test", "--", "{{in:filter}}"].'
      ])
      expect(messages(edit((w) => { step(w, 'tests').run = ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '{{in:brief}}'] }))).toHaveLength(1)
      expect(messages(edit((w) => { step(w, 'tests').run = ['node', '-e', '{{in:brief}}'] }))).toEqual(['Step "Tests" puts a value right after "-e", where it would run as code. Pass it as data instead.'])
    })

    test('values as plain arguments are fine; literal shell characters are fine too, as no shell runs them', () => {
      expect(messages(edit((w) => { step(w, 'tests').run = ['node', 'scripts/check.js', '--name', '{{in:brief}}', 'a&b'] }))).toEqual([])
      expect(messages(edit((w) => { step(w, 'tests').run = ['bash', 'script.sh'] }))).toEqual([])
    })

    test('the program is named in the workflow', () => {
      expect(messages(edit((w) => { step(w, 'tests').run = ['{{in:brief}}'] }))).toEqual(['Step "Tests": the program can\'t come from an input or an output. Name it in the workflow.'])
      expect(messages(edit((w) => { step(w, 'tests').run = [] }))).toEqual(['Step "Tests" needs a program to run, like ["npm", "test"].'])
    })

    test('the folder stays inside the run\'s folder', () => {
      expect(messages(edit((w) => { step(w, 'tests').folder = 'packages/app' }))).toEqual([])
      expect(messages(edit((w) => { step(w, 'tests').folder = '../other' }))).toEqual(['Step "Tests": the folder "../other" must be inside the run\'s folder, like "packages/app".'])
      expect(messages(edit((w) => { step(w, 'tests').folder = 'C:\\elsewhere' }))).toHaveLength(1)
    })

    test('a task check needs a deliverable', () => {
      expect(messages(edit((w) => { delete w.deliverable }))).toEqual(['Step "Tests" is a check on the deliverable task, but the workflow has no deliverable.'])
    })
  })

  test('keys, choices and defaults', () => {
    expect(messages(edit((w) => { w.steps.push({ ...w.steps[0] }) }))).toEqual(['Two steps have the key "plan".'])
    expect(messages(edit((w) => { w.inputs[1].options = [] ; delete w.inputs[1].default }))).toEqual(['Input "Implementer" is a choice but has no options.'])
    expect(messages(edit((w) => { w.inputs[1].default = 'gemini' }))).toEqual(['The default for input "implementer" must be one of claude, codex.'])
    expect(messages(edit((w) => { w.inputs[0].options = ['a'] }))).toEqual(['Input "Feature brief" has options, but only a choice (enum) can.'])
    expect(messages(edit((w) => { (w.steps[0] as { outputs: unknown[] }).outputs.push({ key: 'doc', type: 'text' }) }))).toEqual(['Step "Plan" has two outputs called "doc".'])
  })

  test('an empty workflow can be saved but not started', () => {
    expect(messages({ schema: 1, name: '', inputs: [], steps: [] })).toEqual(['Give the workflow a name.', 'The workflow has no steps yet. Add a step.'])
  })

  test('reviews need a question and something to show', () => {
    expect(messages(edit((w) => { step(w, 'approve').question = ' '; step(w, 'approve').show = [] }))).toEqual([
      'Step "Approve plan" needs a question for the person.',
      'Step "Approve plan" doesn\'t show anything. Choose an input or an earlier step\'s output.'
    ])
  })

  test('renaming a step keeps its references', () => {
    expect(messages(edit((w) => { w.steps[0].title = 'Write the plan' }))).toEqual([])
  })
})
