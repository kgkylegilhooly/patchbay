import type { PendingApproval } from '../shared/contract'

/**
 * F45: windows waiting on the very same request (five agents each asking to run `npm test`) get one decision, not one
 * click each. Only the same tool with the same whole detail counts: a summary can be cut, so it never decides.
 */

/** The pending requests identical to `a`, itself included, in the order they came. */
export function sameRequests(all: PendingApproval[], a: PendingApproval): PendingApproval[] {
  return all.filter((o) => o.tool === a.tool && o.detail === a.detail)
}

const names = (titles: string[]): string => (titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0])

/** What the confirmation says it will do, naming each window. */
export function approveAllMessage(tool: string, detail: string, titles: string[]): string {
  return `Approves ${tool}: ${detail} in ${names(titles)}, as Approve in each window would.`
}
