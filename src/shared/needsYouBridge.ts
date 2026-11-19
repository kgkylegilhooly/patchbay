/** A tool call the agent made that has no result yet: while it's at Need attention, what it's waiting to be allowed. */
export interface PendingTool {
  tool: string
  summary: string
}

/** When a session's status last changed. `exact` is false when Patchbay found it that way on starting up. */
export interface WaitSince {
  at: number
  exact: boolean
}

/** What a peek shows of a session, read in main. */
export interface SessionPeek {
  since: WaitSince | null
  /** The end of the last thing the agent said, or null if it hasn't said anything yet. */
  lastMessage: string | null
  /** The newest call with no result yet. Only means "what it's asking" while it needs you. */
  pending: PendingTool | null
  /** Why the conversation couldn't be read, if it couldn't. */
  problem: string | null
}

/**
 * The jump-and-peek calls to main, as window.patchbayNeedsYou. Each is one request on the channel
 * `pb:needsYou:<method>`, served in src/main/needsYou/ipc.ts. Read-only: a reply goes through sendToAgent.
 */
export interface NeedsYouBridge {
  /** When each session's status last changed, by node id. */
  waits(): Promise<Record<string, WaitSince>>
  peek(nodeId: string): Promise<{ ok: true; peek: SessionPeek } | { ok: false; reason: string }>
}
