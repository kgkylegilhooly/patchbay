import { readRecipe, type Recipe } from './recipe'

/** Recipes that come with Patchbay. Read through the same checks as a file, so they can't drift from the schema. */
export const BUILT_IN_RECIPES: Recipe[] = [
  readRecipe({
    schema: 1,
    name: 'Implement and review',
    description: 'A new worktree with a Claude implementer, a Codex reviewer that starts after the implementer\'s first turn, a setup step, a test command and a shared brief.',
    worktree: true,
    nodes: [
      { key: 'setup', kind: 'setup', title: 'Setup: install dependencies', run: ['npm', 'install'], layout: { x: 24, y: 64, width: 560, height: 300 } },
      { key: 'tests', kind: 'run', title: 'Tests', command: 'npm test', layout: { x: 24, y: 388, width: 560, height: 300 } },
      {
        key: 'brief',
        kind: 'note',
        title: 'Brief',
        text: '# {{task}}\n\nBranch: {{branch}}\nFolder: {{cwd}}\n\n- Implementer: Claude\n- Reviewer: Codex, starts after the implementer\'s first turn\n\n## Decisions\n',
        layout: { x: 24, y: 712, width: 560, height: 216 }
      },
      {
        key: 'implementer',
        kind: 'agent',
        agent: 'claude',
        title: 'Implementer',
        prompt: [
          'You are the implementer for this task: {{task}}',
          '',
          'You work in {{cwd}}, on branch {{branch}}. The shared brief is note {{node:brief}}. Read it with `patchbay read --node {{node:brief}}`, and add decisions to it with `patchbay note --node {{node:brief}} --append "..."`.',
          'Make the change, run the tests, and commit on this branch. When your first turn ends, the reviewer (node {{node:reviewer}}) starts and reviews your work. It sends its findings to you with patchbay send. Fix what it finds, then tell it what you changed with `patchbay send --node {{node:reviewer}} --text "..."`.'
        ].join('\n'),
        layout: { x: 608, y: 64, width: 620, height: 420 }
      },
      {
        key: 'reviewer',
        kind: 'agent',
        agent: 'codex',
        title: 'Reviewer',
        after: ['implementer'],
        prompt: [
          'You are the reviewer for this task: {{task}}',
          '',
          'The implementer is node {{node:implementer}}, working in {{cwd}} on branch {{branch}}. The shared brief is note {{node:brief}}.',
          'Read what the implementer did with `patchbay read --node {{node:implementer}} --tail 20`, and look at the changes with git diff and git log in {{cwd}}. Run the tests.',
          'Send your findings, each with file:line, how serious it is and why, to the implementer with `patchbay send --node {{node:implementer}} --text "..."`. Do not edit files yourself.'
        ].join('\n'),
        layout: { x: 608, y: 508, width: 620, height: 420 }
      }
    ],
    links: [
      { from: 'implementer', to: 'reviewer' },
      { from: 'implementer', to: 'brief' },
      { from: 'reviewer', to: 'brief' }
    ]
  })
]
