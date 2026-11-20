import type { Workflow } from './workflow'

/** Workflows that come with Patchbay. A starting point: copy one to personal to change it. */
export const BUILT_IN_WORKFLOWS: readonly Workflow[] = [
  {
    schema: 1,
    name: 'Plan, review, build',
    description: 'An agent writes a plan, you approve it or ask for changes, then an agent builds it in its own worktree.',
    inputs: [{ key: 'brief', label: 'What to build', type: 'text' }],
    steps: [
      {
        kind: 'agent',
        key: 'plan',
        title: 'Plan',
        agent: 'claude',
        prompt: 'Write a short implementation plan for this, as a Markdown file named PLAN.md in the working folder. Read the code first; do not change it yet.\n\n{{in:brief}}',
        outputs: [
          { key: 'doc', label: 'Plan', type: 'file' },
          { key: 'summary', label: 'Summary', type: 'text' }
        ]
      },
      { kind: 'review', key: 'approve', title: 'Approve the plan', question: 'Should the agent build this plan?', show: [{ input: 'brief' }, { step: 'plan', output: 'doc' }] },
      {
        kind: 'agent',
        key: 'build',
        title: 'Build',
        agent: 'claude',
        prompt: 'Build what the plan in {{out:plan.doc}} describes, and test it. Notes from the review: {{out:approve.note}}\n\nThe original request:\n{{in:brief}}',
        outputs: [{ key: 'summary', label: 'What changed', type: 'text' }]
      }
    ]
  }
]
