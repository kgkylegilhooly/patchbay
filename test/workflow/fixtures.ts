import type { DefinitionRevision, WorkflowDefinition } from '../../src/shared/workflow'
import { snapshotRevision } from '../../src/core/workflow/revision'

/** The design's proving workflow: brief → Claude plan → approve → Codex implement → tests → review. */
export function featureWorkflow(): WorkflowDefinition {
  return {
    schema: 1,
    id: 'feature',
    name: 'Feature',
    description: 'Plan, approve, implement, test and review a feature.',
    inputs: [
      { key: 'repo', label: 'Repository', type: 'workspace' },
      { key: 'brief', label: 'Feature brief', type: 'text', description: 'What to build.' },
      { key: 'implementer', label: 'Implementer', type: 'enum', options: ['claude', 'codex'], default: 'codex' },
      { key: 'testArgs', label: 'Extra test arguments', type: 'text', required: false }
    ],
    jobs: [
      {
        id: 'plan',
        name: 'Plan',
        action: 'agent',
        inputs: {
          agent: { from: 'const', value: 'claude' },
          instructions: { from: 'template', parts: ['Write a plan for: ', { input: 'brief' }] },
          workspace: { from: 'input', input: 'repo' }
        },
        outputs: [{ key: 'plan', label: 'Plan document', type: 'file' }]
      },
      {
        id: 'approve',
        name: 'Approve plan',
        action: 'human-review',
        inputs: {
          question: { from: 'const', value: 'Approve this plan?' },
          material: { from: 'template', parts: [{ job: 'plan', output: 'plan' }] }
        }
      },
      {
        id: 'implement',
        name: 'Implement',
        action: 'agent',
        inputs: {
          agent: { from: 'input', input: 'implementer' },
          instructions: { from: 'template', parts: ['Implement ', { job: 'plan', output: 'plan' }, '. Feedback: ', { job: 'approve', output: 'feedback' }] },
          workspace: { from: 'input', input: 'repo' }
        }
      },
      {
        id: 'tests',
        name: 'Integration tests',
        action: 'command',
        inputs: {
          program: { from: 'const', value: 'npm' },
          args: { from: 'list', items: [{ from: 'const', value: 'test' }, { from: 'input', input: 'testArgs' }] },
          folder: { from: 'input', input: 'repo' }
        },
        after: ['implement'],
        limits: { timeoutMs: 600000, retries: 1 }
      },
      {
        id: 'review',
        name: 'Review',
        action: 'agent',
        inputs: {
          instructions: { from: 'template', parts: ['Review the change. Summary: ', { job: 'implement', output: 'summary' }] },
          workspace: { from: 'input', input: 'repo' }
        },
        after: ['tests'],
        outputs: [{ key: 'verdict', type: 'enum', options: ['ship', 'fix'] }]
      }
    ],
    outputs: [{ key: 'review', label: 'Review summary', from: { job: 'review', output: 'summary' } }]
  }
}

export function featureRevision(def = featureWorkflow(), n = 1): DefinitionRevision {
  const snap = snapshotRevision(def, n, 1000)
  if (!snap.ok) throw new Error(JSON.stringify(snap.issues, null, 2))
  return snap.revision
}

export const repo = { kind: 'workspace' as const, path: 'C:/work/app' }
