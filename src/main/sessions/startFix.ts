import type { NodeError, StartFix } from '../../shared/contract'

/**
 * What a session that couldn't start needs from the person, carried on the error so the node can offer it as a button:
 * Settings › Agents for an agent program that wasn't found, Background sessions for the limit on agents at once, or a
 * new folder for one that's gone. See docs/plans/r3-start.md.
 */
export function withFix<E>(e: E, fix: StartFix): E {
  if (e instanceof Error && !(e as { fix?: StartFix }).fix) (e as { fix?: StartFix }).fix = fix
  return e
}

/** The fix a thrown start error carries, from withFix or its kind. */
export function fixOf(e: unknown, code: NodeError['code']): StartFix | undefined {
  const own = e instanceof Error ? (e as { fix?: StartFix }).fix : undefined
  return own ?? (code === 'cwd-missing' ? 'folder' : undefined)
}
