import type { TaskRevision } from './task'

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }
} as const
export type ViewportPreset = keyof typeof VIEWPORTS
export interface EvidenceViewport { width: number; height: number; preset?: ViewportPreset }

export const EVIDENCE_LIMITS = {
  ageMs: 30 * 86400_000,
  attempts: 100,
  diagnostics: 200,
  recent: 100,
  actions: 200,
  captures: 20,
  metadataBytes: 2 * 1024 * 1024,
  /** Evidence pictures have their own folder and allowance, apart from plain `browser screenshot` pictures. */
  shotBytes: 16 * 1024 * 1024,
  totalShotBytes: 128 * 1024 * 1024,
  /** An attempt with no step, action or finish from its agent for this long has been abandoned. */
  idleMs: 10 * 60_000
} as const

/** Which agent did something, by its node: what it's called now may differ. */
export interface EvidenceAgent { id: string; title: string }

export interface BrowserDiagnostic {
  at: number
  nodeId: string
  pageId: string
  pageUrl: string
  attemptId: string | null
  kind: 'console' | 'network'
  message: string
  url?: string
  status?: number
  /** A request that got no response: Chromium's fixed name for why, such as net::ERR_CONNECTION_REFUSED, or other. */
  failure?: string
  method?: string
  line?: number
}
export interface EvidenceCapture {
  at: number
  pageId: string
  url: string
  viewport: EvidenceViewport
  state: 'available' | 'unavailable' | 'expired'
  reason?: string
  path?: string
  width?: number
  height?: number
  /** Form fields and embedded frames were hidden for privacy, so the picture doesn't show their contents. */
  masked?: boolean
}
export interface BrowserAttempt {
  id: string
  nodeId: string
  projectId?: string
  /** A task in the node's project this attempt is evidence for. The task lists it too. */
  taskId?: string
  /** The agent that started it. Only it can add steps and finish. Absent in attempts saved before this was recorded. */
  startedBy?: EvidenceAgent
  finishedBy?: EvidenceAgent
  startedAt: number
  finishedAt?: number
  /** The last step, action or finish by the agent that started it. */
  activeAt?: number
  url: string
  viewport: EvidenceViewport
  state: 'recording' | 'recorded' | 'incomplete'
  /** The checkout the node's project or worktree is in, as P1 tasks record it. Not what the page's server runs. */
  revision: TaskRevision | null
  assertion: 'passed' | 'failed' | 'unknown'
  actions: Array<{ at: number; pageId: string; url: string; action: string; state: 'completed' | 'failed'; by?: string }>
  captures: EvidenceCapture[]
  diagnostics: BrowserDiagnostic[]
  gaps: string[]
}

/** What the canvas keeps in a browser node's state: enough to label the panel. The attempts are fetched when it opens. */
export interface EvidenceSummary {
  count: number
  recording: boolean
  /** Changes whenever anything recorded for the node does, so an open panel knows to fetch again. */
  version: number
  /** Saved evidence couldn't be read or written. */
  problem: string | null
}

/** A path segment that looks like a token or key, such as a reset link's or a webhook's, rather than a name. */
function secretLike(segment: string): boolean {
  if (segment.length < 16) return false
  if (/^[0-9a-f-]{16,}$/i.test(segment) && /\d/.test(segment) && /[a-f]/i.test(segment)) return true
  if (segment.length < 20) return false
  const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(segment)).length
  const digits = (segment.match(/\d/g)?.length ?? 0) / segment.length
  // Mixed case with digits, or mostly digits among letters: a slug like my-article-2024 is neither.
  return kinds === 3 || (kinds === 2 && digits >= 0.25)
}

/**
 * URLs as evidence keeps them: no credentials, query strings or fragments, and path segments that look like tokens
 * replaced by `[redacted]`, since reset links and webhooks carry their secret in the path.
 */
export function evidenceUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return value === 'about:blank' ? value : '[URL omitted]'
    const path = url.pathname
      .split('/')
      .map((s) => (secretLike(decodeURIComponentSafe(s)) ? '[redacted]' : s))
      .join('/')
    return `${url.origin}${path}`.slice(0, 1000)
  } catch {
    return '[URL unavailable]'
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
