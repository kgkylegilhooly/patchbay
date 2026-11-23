'use strict'
// A scene's picture waits for its fake agents to reach their statuses. On a busy machine each hook of fake-claude.cjs
// takes seconds (Git Bash, then Node, per hook), so the canvas scene took 12 s to settle with 48 busy workers and 45 s
// with 96. A picture taken after a fixed second and a half showed every agent Idle or Starting. See
// docs/plans/r2-reliability.md.

/** The status fake-claude.cjs ends up in for a prompt, in the order it reads them. Null: only past starting. */
function expectedStatus(prompt) {
  const p = prompt ?? ''
  if (/\bneeds\b/.test(p) || /\bpermission\b/.test(p)) return 'needs-you'
  // Works a while, then asks and stops: it changes on its own.
  if (/\blater=\d+\b/.test(p)) return null
  if (/\bworking\b/.test(p)) return 'working'
  if (/\blimit\b/.test(p) || /\bloginfail\b/.test(p) || /\bunknown\b/.test(p)) return 'unknown'
  if (/\bexit\b/.test(p)) return 'exited'
  return 'idle'
}

/** The agents the app starts by itself when the seeded canvas opens (planRestore in src/main/lifecycle.ts). */
function agentsToWaitFor(doc) {
  const archived = new Set((doc.projects ?? []).filter((p) => p.archivedAt !== undefined).map((p) => p.id))
  return doc.nodes
    .filter((n) => n.kind === 'claude' && !(n.projectId && archived.has(n.projectId)) && !(n.after?.length > 0) && !n.setupWait)
    // Codex's states come from fake-codex.cjs, which replays a recording.
    .map((n) => ({ id: n.id, want: (n.agent ?? 'claude') === 'claude' ? expectedStatus(n.prompt) : null }))
}

/** An agent that ended (as when a scene's settings turn Claude off) won't change again, so it counts as settled. */
const settled = (status, want) => status === 'exited' || (want === null ? status !== undefined && status !== 'starting' : status === want)

/** True once every agent got there; false, having said which didn't, after the limit. The picture is taken either way. */
async function waitForAgents(page, doc, { timeoutMs = 120_000, everyMs = 250, log = (line) => console.error(line) } = {}) {
  const agents = agentsToWaitFor(doc)
  if (agents.length === 0) return true
  const deadline = Date.now() + timeoutMs
  let now = {}
  for (;;) {
    now = (await page.evaluate(() => window.patchbay.getStatuses()).catch(() => ({}))) ?? {}
    if (agents.every((a) => settled(now[a.id], a.want))) return true
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, everyMs))
  }
  const off = agents.filter((a) => !settled(now[a.id], a.want)).map((a) => `${a.id} (wanted ${a.want ?? 'past starting'}, is ${now[a.id] ?? 'not started'})`)
  log(`NOTE  the scene's agents hadn't settled after ${Math.round(timeoutMs / 1000)} s, so the picture may show them wrong: ${off.join(', ')}`)
  return false
}

module.exports = { expectedStatus, agentsToWaitFor, waitForAgents }
