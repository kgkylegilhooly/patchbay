/**
 * Claude Code's own messaging between sessions (SendMessage and ListAgents, on Windows since 2.1.234) lets any Claude
 * session on the PC find and message any other. That goes around Patchbay's rule that agents message only the nodes
 * they opened or that the person linked to them, so it's off in Patchbay's nodes unless Settings turns it on:
 *
 * - `crossSessionInbound: "refuse"` drops every message arriving from another session. A --settings value outranks the
 *   person's user settings, and Claude Code's /config hides its own row for it while Patchbay sets it.
 * - Denying ListAgents stops the node finding other sessions to message.
 *
 * SendMessage itself stays: it is also how Claude talks to its own subagents and agent-team teammates, which share a
 * mailbox inside the session rather than this inbox, and which ListAgents isn't needed for.
 */
export interface NativeMessagingSettings {
  crossSessionInbound?: 'refuse'
  deny: string[]
}

/** The setting's value that lets Claude nodes use Claude's own messaging between sessions. */
export const NATIVE_MESSAGING_ON = 'on'

export function nativeMessagingSettings(setting: string | undefined): NativeMessagingSettings {
  if (setting?.trim().toLowerCase() === NATIVE_MESSAGING_ON) return { deny: [] }
  return { crossSessionInbound: 'refuse', deny: ['ListAgents'] }
}
