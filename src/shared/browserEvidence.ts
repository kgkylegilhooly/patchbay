export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }
} as const
export type ViewportPreset = keyof typeof VIEWPORTS
export interface EvidenceViewport { width: number; height: number; preset?: ViewportPreset }
export const EVIDENCE_LIMITS = { ageMs: 30 * 86400_000, attempts: 100, diagnostics: 200, recent: 100, actions: 200, captures: 20, metadataBytes: 2 * 1024 * 1024, totalShotBytes: 128 * 1024 * 1024 } as const

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
}
export interface BrowserAttempt {
  id: string
  nodeId: string
  projectId?: string
  taskId?: string
  startedAt: number
  finishedAt?: number
  url: string
  viewport: EvidenceViewport
  state: 'recording' | 'recorded' | 'incomplete'
  revision: { commit: string; dirty: boolean } | null
  assertion: 'passed' | 'failed' | 'unknown'
  actions: Array<{ at: number; pageId: string; url: string; action: string; state: 'completed' | 'failed' }>
  captures: EvidenceCapture[]
  diagnostics: BrowserDiagnostic[]
  gaps: string[]
}

/** URL arguments can contain credentials. Never retain query strings or fragments. */
export function evidenceUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return value === 'about:blank' ? value : '[URL omitted]'
    return `${url.origin}${url.pathname}`.slice(0, 1000)
  } catch { return '[URL unavailable]' }
}
