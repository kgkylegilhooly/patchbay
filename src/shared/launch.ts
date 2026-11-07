/** What the launcher runs: the program, its arguments, folder and environment. A null value removes a variable. */
export interface LaunchPlan {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string | null>
}

export interface LaunchConfigItem {
  kind: 'config'
  name: string
  /** Absent when it can't be run here, and `problem` says why. */
  plan?: LaunchPlan
  problem?: string
  /** Things it asks for that only matter to a debugger, so they're left out. */
  notes: string[]
}

export interface LaunchCompoundItem {
  kind: 'compound'
  name: string
  members: string[]
  problem?: string
  notes: string[]
}

export type LaunchItem = LaunchConfigItem | LaunchCompoundItem
