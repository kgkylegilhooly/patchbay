import type { TaskState } from '../../shared/task'

/** The order states are counted in: what needs the person first. */
const ORDER: Array<[TaskState, string]> = [
  ['ready-for-review', 'submitted'],
  ['blocked', 'blocked'],
  ['running', 'running'],
  ['planned', 'planned'],
  ['accepted', 'accepted'],
  ['cancelled', 'cancelled']
]

/** The board's folded Task outcomes line: how many tasks are in each state, such as "1 submitted · 2 running". */
export function outcomeSummary(tasks: Array<{ state: TaskState }>): string {
  return ORDER.map(([state, word]) => [tasks.filter((t) => t.state === state).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}
