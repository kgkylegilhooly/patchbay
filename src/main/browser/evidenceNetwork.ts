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
  end(d: { id: number; statusCode?: number }, failed: boolean): void {
    const origin = this.requests.get(d.id)
    this.requests.delete(d.id)
    if (!origin || (!failed && (d.statusCode ?? 0) < 400)) return
    this.record({ ...origin, at: Date.now(), kind: 'network', message: failed ? 'Request failed' : 'HTTP failure', status: d.statusCode })
  }
}
