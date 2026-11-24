import type { CanvasDoc, ClaudeNode } from '../shared/model'

/**
 * A note as a saved prompt: the text it holds goes to the agents a cable joins it to, with one click on the note. A
 * prompt you'd otherwise retype ("run the tests and fix what fails") lives on the canvas beside the agents it's for.
 */

export type SendResult = { ok: true; queued: boolean } | { ok: false; reason: string }

/** The agents a cable (a link, drawn either way) joins the note to, in canvas order. */
export function linkedAgents(doc: CanvasDoc, noteId: string): ClaudeNode[] {
  const other = new Set(doc.edges.flatMap((e) => (e.kind !== 'link' ? [] : e.from === noteId ? [e.to] : e.to === noteId ? [e.from] : [])))
  return doc.nodes.filter((n): n is ClaudeNode => n.kind === 'claude' && other.has(n.id))
}

const names = (titles: string[]): string => (titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0])

export function sendTitle(agents: Pick<ClaudeNode, 'title'>[]): string {
  return `Send this note to ${agents.length > 2 ? `${agents.length} linked agents` : names(agents.map((a) => a.title))}`
}

/** What happened, for the line under the note: sent, then queued, then each refusal with its reason. */
export function sendSummary(results: Array<{ title: string; result: SendResult }>): string {
  const sent = results.filter((r) => r.result.ok && !r.result.queued).map((r) => r.title)
  const queued = results.filter((r) => r.result.ok && r.result.queued).map((r) => r.title)
  const parts: string[] = []
  if (sent.length) parts.push(`Sent to ${names(sent)}.`)
  if (queued.length) parts.push(`Queued for ${names(queued)}, which ${queued.length > 1 ? 'get' : 'gets'} it when ${queued.length > 1 ? 'idle' : 'it is idle'}.`)
  for (const r of results) if (!r.result.ok) parts.push(`${r.title}: ${r.result.reason}`)
  return parts.join(' ')
}
