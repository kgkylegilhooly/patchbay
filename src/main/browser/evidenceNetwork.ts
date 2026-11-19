import type { BrowserDiagnostic } from '../../shared/browserEvidence'
import { evidenceUrl } from '../../shared/browserEvidence'

type Request = { id: number; webContentsId?: number; url: string; method: string; resourceType?: string }
type Origin = Pick<BrowserDiagnostic, 'nodeId' | 'pageId' | 'pageUrl' | 'attemptId'>
/** Attribute late responses to the page and attempt at request start, never the currently displayed page. */
export class EvidenceNetwork {
  private requests = new Map<number, Origin & { url: string; method: string }>()
  constructor(private origin: (contentsId: number) => Origin | undefined, private record: (d: BrowserDiagnostic) => void, private overflow: (id: string) => void) {}
  start(d: Request): void {
    if (d.webContentsId === undefined) return
    const origin = this.origin(d.webContentsId)
    if (!origin) return
    if (this.requests.size >= 1000) {
      const first = this.requests.entries().next().value!
      this.requests.delete(first[0]); this.overflow(first[1].nodeId)
    }
    this.requests.set(d.id, { ...origin, pageUrl: evidenceUrl(d.resourceType === 'mainFrame' ? d.url : origin.pageUrl), url: evidenceUrl(d.url), method: /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(d.method) ? d.method : 'OTHER' })
  }
  end(d: { id: number; statusCode?: number; error?: string }, failed: boolean): void {
    const origin = this.requests.get(d.id)
    this.requests.delete(d.id)
    if (!origin || (!failed && (d.statusCode ?? 0) < 400)) return
    // Cancelled by the page, or by moving to another page: not a failure of the site, and busy pages make many.
    if (failed && d.error === 'net::ERR_ABORTED') return
    this.record({ ...origin, at: Date.now(), kind: 'network', message: failed ? 'Request failed' : 'HTTP failure', status: d.statusCode, ...(failed ? { failure: failureName(d.error) } : {}) })
  }
}

/** Chromium names a failure from a fixed list, such as net::ERR_CONNECTION_REFUSED. Anything else isn't kept. */
export function failureName(error: string | undefined): string {
  return error && /^net::ERR_[A-Z0-9_]{1,60}$/.test(error) ? error : 'other'
}
