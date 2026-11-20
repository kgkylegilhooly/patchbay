import { AGENT_KINDS } from '../../shared/agents'
import type { OutputSpec, ValueType } from '../../shared/workflow'

/** Who reports a result: the assigned agent, Patchbay's own adapter (a command's exit), or a person. */
export type Submitter = 'agent' | 'adapter' | 'person'

export interface ParamSpec {
  key: string
  label: string
  type: ValueType
  options?: string[]
  /** Required unless false. A parameter with a default is never missing. */
  required?: boolean
  default?: string | number | boolean
}

/**
 * Something a job can do. Its parameters and fixed outputs drive validation, agents' discovery and (later) the
 * editor's forms. Execution adapters arrive in slice 2; this is data only.
 */
export interface ActionSpec {
  id: string
  label: string
  description: string
  params: ParamSpec[]
  /** Outputs every job of this action has. */
  outputs: OutputSpec[]
  /** Whether a job can declare more result fields of its own. */
  customOutputs: boolean
  /**
   * Which party's report can finish a job of this action. A result from anyone else is refused, so agent output,
   * a command's exit and a person's decision never stand in for one another.
   */
  completedBy: Submitter
  /** A result that doesn't meet this is recorded, but the attempt fails, which stops the run. */
  successWhen?: { output: string; equals: string | number | boolean }
  /** Why it can't be used here, when it can't. Listed so discovery is honest about it. */
  unavailable?: string
}

export const BUILT_IN_ACTIONS: readonly ActionSpec[] = [
  {
    id: 'agent',
    label: 'Agent task',
    description: 'A fresh agent session works on the instructions and submits a result with the declared fields. Becoming idle is never a result.',
    params: [
      { key: 'agent', label: 'Agent', type: 'enum', options: [...AGENT_KINDS], default: 'claude' },
      { key: 'instructions', label: 'Instructions', type: 'text' },
      { key: 'workspace', label: 'Workspace', type: 'workspace' }
    ],
    outputs: [{ key: 'summary', label: 'Summary', type: 'text' }],
    customOutputs: true,
    completedBy: 'agent'
  },
  {
    id: 'command',
    label: 'Run command',
    description: 'Runs a program with its arguments, with no shell between. Succeeds on exit code 0.',
    params: [
      { key: 'program', label: 'Program', type: 'text' },
      { key: 'args', label: 'Arguments', type: 'text-list', required: false },
      { key: 'folder', label: 'Folder', type: 'workspace' }
    ],
    outputs: [
      { key: 'exitCode', label: 'Exit code', type: 'number' },
      { key: 'log', label: 'Log', type: 'file' }
    ],
    customOutputs: false,
    completedBy: 'adapter',
    successWhen: { output: 'exitCode', equals: 0 }
  },
  {
    id: 'human-review',
    label: 'Human review',
    description: 'Waits for a person to approve or reject what it shows them. Only a person can decide.',
    params: [
      { key: 'question', label: 'Question', type: 'text' },
      { key: 'material', label: 'What to review', type: 'text', required: false }
    ],
    outputs: [
      { key: 'approved', label: 'Approved', type: 'boolean' },
      { key: 'feedback', label: 'Feedback', type: 'text', required: false }
    ],
    customOutputs: false,
    completedBy: 'person',
    successWhen: { output: 'approved', equals: true }
  },
  {
    id: 'email',
    label: 'Send email',
    description: 'Sends an email through a saved connection.',
    params: [
      { key: 'to', label: 'To', type: 'text-list' },
      { key: 'subject', label: 'Subject', type: 'text' },
      { key: 'body', label: 'Body', type: 'text' }
    ],
    outputs: [{ key: 'receipt', label: 'Receipt', type: 'text' }],
    customOutputs: false,
    completedBy: 'adapter',
    unavailable: "Patchbay can't send email yet: there's no email connection to send it through."
  }
]

export type ActionCatalog = readonly ActionSpec[]

export function findAction(catalog: ActionCatalog, id: string): ActionSpec | undefined {
  return catalog.find((a) => a.id === id)
}

/** A type with its enum options, as bindings and outputs carry it. */
export interface TypeSpec { type: ValueType; options?: string[] }

export function describeType(t: TypeSpec): string {
  if (t.type === 'enum' && t.options?.length) return `a choice of ${t.options.join(' / ')}`
  return { text: 'text', number: 'a number', boolean: 'true/false', enum: 'a choice', 'text-list': 'a list of text', file: 'a file', workspace: 'a workspace' }[t.type]
}

/**
 * Whether a value of type `from` can fill `to`. Same type; an enum whose choices are all allowed; numbers,
 * true/false and choices into text. Nothing else is converted.
 */
export function assignable(from: TypeSpec, to: TypeSpec): boolean {
  if (from.type === to.type) {
    if (to.type !== 'enum' || !to.options) return true
    return !!from.options && from.options.every((o) => to.options!.includes(o))
  }
  return to.type === 'text' && (from.type === 'number' || from.type === 'boolean' || from.type === 'enum')
}

/** Whether a value fits a type. Says what's wrong when it doesn't. */
export function checkValue(v: unknown, t: TypeSpec): string | null {
  switch (t.type) {
    case 'text': return typeof v === 'string' ? null : 'must be text'
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number'
    case 'boolean': return typeof v === 'boolean' ? null : 'must be true or false'
    case 'enum':
      if (typeof v !== 'string') return 'must be one of the choices'
      return !t.options || t.options.includes(v) ? null : `"${v}" isn't one of the choices (${t.options.join(', ')})`
    case 'text-list': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be a list of text'
    case 'file': return isRef(v, 'file') ? null : 'must be a file'
    case 'workspace': return isRef(v, 'workspace') ? null : 'must be a workspace'
  }
}

function isRef(v: unknown, kind: 'file' | 'workspace'): boolean {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === kind && typeof (v as { path?: unknown }).path === 'string'
}

/** The type of a constant, as well as it can be told. */
export function typeOfValue(v: unknown): ValueType | null {
  if (typeof v === 'string') return 'text'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (Array.isArray(v)) return 'text-list'
  if (isRef(v, 'file')) return 'file'
  if (isRef(v, 'workspace')) return 'workspace'
  return null
}
