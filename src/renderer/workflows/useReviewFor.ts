import { useEffect, useState } from 'react'
import type { ReviewTarget } from '../../shared/workflowBridge'
import { workflows } from '../workflowBridge'

/**
 * The workflow review waiting on the document a reader shows, kept current as runs change. While there is one, the
 * reader's Send goes to it as Request changes. See src/main/workflows/service.ts reviewFor.
 */
export function useReviewFor(path: string): ReviewTarget | null {
  const [target, setTarget] = useState<ReviewTarget | null>(null)
  useEffect(() => {
    let live = true
    const check = (): void => void workflows.reviewFor(path).then((t) => live && setTarget(t)).catch(() => live && setTarget(null))
    check()
    const off = workflows.onChange(check)
    return () => {
      live = false
      off()
    }
  }, [path])
  return target
}

/** Sends a reader's comments to the waiting review as Request changes. */
export async function requestChanges(target: ReviewTarget, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return workflows.act(target.runId, { type: 'decide', attemptId: target.attemptId, decision: 'request-changes', note: text })
}
