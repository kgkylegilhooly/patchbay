import type { RecipeSource } from './recipe'
import type { Workflow, WorkflowIssue, WorkflowRun } from './workflow'

/** A workflow as listed, beside recipes in the library: where it came from, and what's wrong with it if anything. */
export interface WorkflowEntry {
  /** `source:name`, or `source:file` for one that couldn't be read. */
  ref: string
  source: RecipeSource
  name: string
  description?: string
  file?: string
  /** Absent when the file couldn't be read at all. */
  workflow?: Workflow
  /** Names exactly this content, by the same rule as recipes. A run records it; agents may only start trusted ones. */
  hash?: string
  /** Why it can't be started: it couldn't be read, or it has issues. */
  problem?: string
  issues?: WorkflowIssue[]
}

/** A step as starting would run it, for the form's preview. */
export interface StepPreview {
  key: string
  kind: 'agent' | 'command' | 'review'
  title: string
  agent?: string
  prompt?: string
  question?: string
  /** For a command: what runs, with the inputs filled in so far as known. */
  runs?: string
  folder?: string
  taskCheck?: boolean
}

export type PersonAction =
  | { type: 'decide'; attemptId: string; decision: 'approve' | 'request-changes'; note?: string }
  | { type: 'retry'; step: string }
  | { type: 'stop' }
  | { type: 'remind'; attemptId: string }
  | { type: 'mark-done'; attemptId: string; outputs: Record<string, { type: 'text'; text: string }> }

export type Outcome = { ok: true } | { ok: false; reason: string }

/** The page's calls to main for workflows, on `pb:workflows:<method>`. See src/main/workflows/ipc.ts. */
export interface WorkflowBridge {
  list(projectId: string): Promise<{ entries: WorkflowEntry[]; repo: string | null; folder: string }>
  preview(a: { projectId: string; ref: string; inputs: Record<string, unknown> }): Promise<{ ok: true; steps: StepPreview[] } | { ok: false; reason: string }>
  start(a: { projectId: string; ref: string; hash?: string; inputs: Record<string, unknown>; at?: { x: number; y: number } }): Promise<{ ok: true; runId: string; groupId: string | null } | { ok: false; reason: string; problems?: string[] }>
  runs(projectId: string): Promise<WorkflowRun[]>
  act(runId: string, action: PersonAction): Promise<Outcome>
  /** Saves a definition. One with issues still saves; `file` replaces that file, in the folder for `where`. */
  save(a: { projectId: string; workflow: unknown; where: 'personal' | 'repository'; overwrite?: boolean; file?: string }): Promise<{ ok: true; file: string; hash: string; issues: WorkflowIssue[] } | { ok: false; reason: string; exists?: boolean }>
  openFolder(projectId: string, where: 'personal' | 'repository'): Promise<void>
  /** Opens a workflow file, or a file a run kept (a log, a submitted file), with the system's app for it. */
  openFile(path: string): Promise<Outcome>
  onChange(cb: (run: WorkflowRun) => void): () => void
}
