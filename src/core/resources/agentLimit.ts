/** The optional soft limit on agents running at once. It only ever stops a new one starting; running ones carry on. */

export const AGENT_LIMIT = { min: 1, max: 99 }

/** The setting's text as a limit. Blank, zero or anything unreadable means no limit. */
export function parseAgentLimit(value: string | undefined): number | null {
  const n = Number((value ?? '').trim())
  if (!value?.trim() || !Number.isFinite(n) || n < AGENT_LIMIT.min) return null
  return Math.min(AGENT_LIMIT.max, Math.floor(n))
}

/** Why an agent can't start now, with `running` other agents already running. Null when it can. */
export function agentLimitReason(limit: number | null, running: number): string | null {
  if (limit === null || running < limit) return null
  const agents = `${running} agent${running === 1 ? ' is' : 's are'}`
  return `Not started: ${agents} already running, and your limit is ${limit} (Settings > Background sessions). Close or stop one you're done with, then start this one again.`
}
