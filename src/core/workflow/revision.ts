import { WORKFLOW_SCHEMA, type DefinitionRevision, type ValidationIssue, type WorkflowDefinition } from '../../shared/workflow'
import { BUILT_IN_ACTIONS, type ActionCatalog } from './catalog'
import { validateDefinition } from './validate'

/** JSON with object keys sorted, so the same definition always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * Names a definition's content: two 53-bit hashes (cyrb53, different seeds) of its canonical JSON. Pure, so the
 * renderer can use it too. It catches edits and mix-ups; it isn't a security boundary.
 */
export function definitionHash(def: WorkflowDefinition): string {
  const text = canonicalJson(def)
  const part = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed
    let h2 = 0x41c6ce57 ^ seed
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 2654435761)
      h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
  }
  return part(1) + part(2)
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as object)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}

/**
 * A published revision of a definition: a frozen copy that nothing can change. Only a definition with no
 * validation issues can be published.
 */
export function snapshotRevision(def: WorkflowDefinition, revision: number, now: number, catalog: ActionCatalog = BUILT_IN_ACTIONS):
  { ok: true; revision: DefinitionRevision } | { ok: false; issues: ValidationIssue[] } {
  const issues = validateDefinition(def, catalog)
  if (issues.length) return { ok: false, issues }
  const definition = structuredClone(def)
  return {
    ok: true,
    revision: deepFreeze({ schema: WORKFLOW_SCHEMA, workflowId: def.id, revision, publishedAt: now, hash: definitionHash(definition), definition })
  }
}
