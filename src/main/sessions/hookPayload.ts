/**
 * What a Claude Code hook event becomes on its way to the app, and what the app's answer becomes on its way back to
 * Claude. resources/hook.cjs does the same for command hooks; this is the session host's copy for http hooks (see
 * hostHooks.ts), and test/sessions/hookPayload.test.ts holds the two to the same result.
 */

/** A bigger input is withheld, which leaves that request to the terminal prompt. */
export const MAX_TOOL_INPUT_CHARS = 256 * 1024
/** Claude's suggested permission updates are a rule or two. More than this is left out, and the button with it. */
export const MAX_SUGGESTIONS_CHARS = 16 * 1024
/** The fields Patchbay uses. Tool responses can be huge and could push the event past the server's limit. */
const FORWARDED = ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'notification_type', 'reason', 'source']
/** Codex's SubagentStart and SubagentStop: which subagent, of what kind, and where its own transcript is. */
const SUBAGENT_FIELDS = ['agent_id', 'agent_type', 'agent_transcript_path', 'turn_id']
/** A turn that ended on an API error says why, such as a usage limit and when it resets. Capped, as it's only for a label. */
const STOP_FAILURE_FIELDS = ['error', 'error_details', 'last_assistant_message']
const MAX_STOP_TEXT_CHARS = 1000

export const DENIED =
  "The person declined this tool call at Patchbay's permission prompt. It's their answer to this call, not a Patchbay rule against the feature it uses."

/** The fields of a hook event that the app uses. `name` stands in when the event doesn't say, as hook.cjs's argv does. */
export function pickHookFields(event: Record<string, unknown>, name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of FORWARDED) if (event[key] !== undefined) out[key] = event[key]
  if (!out.hook_event_name) out.hook_event_name = name
  // Claude adds it to any event from inside a subagent: such an event says nothing about the window's own conversation.
  if (typeof event.agent_id === 'string') out.agent_id = event.agent_id.slice(0, 1000)
  if (out.hook_event_name === 'StopFailure') {
    for (const key of STOP_FAILURE_FIELDS) if (typeof event[key] === 'string') out[key] = (event[key] as string).slice(0, MAX_STOP_TEXT_CHARS)
  }
  if (out.hook_event_name === 'SubagentStart' || out.hook_event_name === 'SubagentStop') {
    for (const key of SUBAGENT_FIELDS) if (typeof event[key] === 'string') out[key] = (event[key] as string).slice(0, 1000)
  }
  if (out.hook_event_name === 'PermissionRequest') {
    out.tool_name = event.tool_name
    const input = JSON.stringify(event.tool_input)
    if (input && input.length <= MAX_TOOL_INPUT_CHARS) out.tool_input = event.tool_input
    // Claude's own "don't ask again" rules, for the Always allow button. Small, or left out.
    const suggestions = Array.isArray(event.permission_suggestions) ? JSON.stringify(event.permission_suggestions) : ''
    if (suggestions && suggestions.length <= MAX_SUGGESTIONS_CHARS) out.permission_suggestions = event.permission_suggestions
  }
  return out
}

/** A journal line, as hook.cjs writes one. Tool input is only for the approval buttons, which a journalled request no longer has. */
export function journalLine(fields: Record<string, unknown>, at: number): string {
  const { tool_name: _name, tool_input: _input, permission_suggestions: _rules, ...kept } = fields
  return `${JSON.stringify({ ...kept, at })}\n`
}

/**
 * The app's answer, as Claude Code reads a hook's output. `{}` is "nothing to say", which Claude takes as success: for a
 * permission request that leaves its own prompt to decide.
 */
export function claudeOutput(event: string, answer: unknown): Record<string, unknown> {
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>
  if (event === 'PermissionRequest') {
    if (a.decision !== 'allow' && a.decision !== 'deny') return {}
    // Agents read a bare "denied" as Patchbay ruling out what the call does, and give up on it for good.
    const decision: Record<string, unknown> = { behavior: a.decision, ...(a.decision === 'deny' ? { message: DENIED } : {}) }
    // Always allow: the rule Claude itself suggested, echoed back so Claude saves it. See approvals.ts.
    if (a.decision === 'allow' && Array.isArray(a.updatedPermissions) && a.updatedPermissions.length) decision.updatedPermissions = a.updatedPermissions
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
  }
  if (event === 'SessionStart' && typeof a.context === 'string' && a.context) {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: a.context.slice(0, 4000) } }
  }
  return {}
}
