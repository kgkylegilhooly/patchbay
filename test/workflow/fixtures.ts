import type { Workflow } from '../../src/shared/workflow'

/** The proving workflow: brief → Claude plan → review → Codex implement → npm test, with a deliverable. */
export function featureWorkflow(): Workflow {
  return {
    schema: 1,
    name: 'Feature',
    description: 'Plan, review, implement and test a feature.',
    worktree: true,
    inputs: [
      { key: 'brief', label: 'Feature brief', type: 'text' },
      { key: 'implementer', label: 'Implementer', type: 'enum', options: ['claude', 'codex'], default: 'codex' },
      { key: 'filter', label: 'Test filter', type: 'text', required: false },
      { key: 'attempts', label: 'Attempts', type: 'number', default: 1 }
    ],
    steps: [
      {
        kind: 'agent', key: 'plan', title: 'Plan', agent: 'claude',
        prompt: 'Write a plan for: {{in:brief}}',
        outputs: [{ key: 'doc', label: 'Plan document', type: 'file' }, { key: 'summary', type: 'text' }]
      },
      { kind: 'review', key: 'approve', title: 'Approve plan', question: 'Is this plan right?', show: [{ input: 'brief' }, { step: 'plan', output: 'doc' }] },
      {
        kind: 'agent', key: 'implement', title: 'Implement', agent: 'codex',
        prompt: 'Implement the plan in {{out:plan.doc}}. Summary: {{ out:plan.summary }} Reviewer said: {{out:approve.note}}',
        outputs: [{ key: 'summary', type: 'text' }],
        timeoutMin: 60
      },
      { kind: 'command', key: 'tests', title: 'Tests', run: ['npm', 'test', '--', '{{in:filter}}'], timeoutMin: 10, taskCheck: true }
    ],
    deliverable: { criteria: ['The feature works', 'Tests pass'] }
  }
}
