import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EVIDENCE_LIMITS as L, evidenceUrl, type BrowserAttempt, type BrowserDiagnostic, type EvidenceCapture, type EvidenceViewport } from '../../shared/browserEvidence'
import { LIMITS } from '../../shared/browserPolicy'

/** Separate from the canvas: retries never overwrite another attempt. Only bounded, selected fields enter here. */
export class BrowserEvidenceStore {
  problem: string | null = null
  private attempts: BrowserAttempt[] = []
  private recent = new Map<string, BrowserDiagnostic[]>()
  private file: string
  readonly shotsDir: string
  constructor(private dir: string, private changed: (id: string) => void = () => {}, private now = Date.now) {
    this.file = join(dir, 'browser-evidence.json')
    this.shotsDir = join(dir, 'browser-shots')
    try {
      if (statSync(this.file).size <= L.metadataBytes) {
        const doc = JSON.parse(readFileSync(this.file, 'utf8'))
        if (doc.version !== 1 || !Array.isArray(doc.attempts) || !doc.attempts.every(validAttempt)) throw new Error('Invalid evidence file')
        this.attempts = doc.attempts
      } else this.problem = 'Saved browser evidence is unavailable: metadata size limit exceeded.'
    } catch { if (existsSync(this.file)) this.problem = 'Saved browser evidence is unavailable: file could not be read.' }
    for (const a of this.attempts) if (a.state === 'recording') { a.state = 'incomplete'; a.finishedAt = now(); a.gaps.push('Recording interrupted by application restart.') }
    this.prune()
    if (this.attempts.length) this.write()
  }
  list(id: string): BrowserAttempt[] {
    this.prune()
    return structuredClone(this.attempts.filter(a => a.nodeId === id).reverse())
  }
  active(id: string): BrowserAttempt | undefined { return this.attempts.find(a => a.nodeId === id && a.state === 'recording') }
  start(input: { nodeId: string; projectId?: string; taskId?: string; url: string; viewport: EvidenceViewport; revision: BrowserAttempt['revision'] }): BrowserAttempt {
    if (this.active(input.nodeId)) throw new Error('An attempt is already recording. Finish it before starting another.')
    if (this.attempts.filter(a => a.state === 'recording').length >= L.attempts) throw new Error('Too many attempts are recording. Finish one first.')
    const a: BrowserAttempt = { ...input, url: evidenceUrl(input.url), id: randomUUID(), startedAt: this.now(), state: 'recording', assertion: 'unknown', actions: [], captures: [], diagnostics: [], gaps: [] }
    this.attempts.push(a)
    this.save(input.nodeId)
    return a
  }
  gap(id: string, message: string): void {
    const a = this.active(id)
    if (a && !a.gaps.includes(message)) { a.gaps.push(message); this.save(id) }
  }
  interrupt(id: string, reason: string): void {
    const a = this.active(id)
    if (!a) return
    this.gap(id, reason)
    a.state = 'incomplete'; a.finishedAt = this.now(); this.save(id)
  }
  finish(id: string, assertion: BrowserAttempt['assertion']): BrowserAttempt {
    const a = this.active(id)
    if (!a) throw new Error('No attempt is recording. Start one first.')
    a.assertion = assertion
    if (this.problem && !a.gaps.includes(this.problem)) a.gaps.push(this.problem)
    a.state = a.gaps.length ? 'incomplete' : 'recorded'
    a.finishedAt = this.now()
    this.save(id)
    return structuredClone(a)
  }
  action(id: string, pageId: string, url: string, action: string, state: 'completed' | 'failed'): void {
    const a = this.active(id)
    if (!a) return
    if (a.actions.length < L.actions) a.actions.push({ at: this.now(), pageId, url: evidenceUrl(url), action, state })
    else { this.gap(id, 'Action limit reached; later actions omitted.'); return }
    if (state === 'failed') this.gap(id, 'An action failed or was interrupted.')
    this.save(id)
  }
  diagnostic(input: Omit<BrowserDiagnostic, 'attemptId'> & { attemptId?: string | null }): void {
    const a = input.attemptId === undefined ? this.active(input.nodeId) : this.attempts.find(a => a.id === input.attemptId && a.nodeId === input.nodeId)
    const d = { ...input, message: input.kind === 'console' ? 'Console error (message omitted for privacy).' : input.status ? 'HTTP failure' : 'Request failed', pageUrl: evidenceUrl(input.pageUrl), url: input.url ? evidenceUrl(input.url) : undefined, attemptId: a?.id ?? null }
    const rows = this.recent.get(input.nodeId) ?? []
    rows.push(d); this.recent.set(input.nodeId, rows.slice(-L.recent))
    if (!a) return
    if (a.diagnostics.length < L.diagnostics) a.diagnostics.push(d)
    else {
      const gap = 'Diagnostic limit reached; later entries omitted.'
      if (!a.gaps.includes(gap)) { a.gaps.push(gap); if (a.state === 'recorded') a.state = 'incomplete'; this.save(input.nodeId) }
      return
    }
    this.save(input.nodeId)
  }
  diagnostics(id: string, kind: BrowserDiagnostic['kind']): BrowserDiagnostic[] { return structuredClone((this.recent.get(id) ?? []).filter(d => d.kind === kind)) }
  forgetRecent(id: string): void { this.recent.delete(id) }
  capture(id: string, capture: EvidenceCapture): void {
    const a = this.active(id)
    if (!a) throw new Error('No attempt is recording. Start one first.')
    if (a.captures.length < L.captures) a.captures.push({ ...capture, url: evidenceUrl(capture.url) })
    else { this.gap(id, 'Capture limit reached; later pictures omitted.'); return }
    if (capture.state !== 'available') this.gap(id, capture.reason ?? 'Screenshot unavailable.')
    this.save(id)
  }
  image(id: string, attemptId: string, index: number): string | null {
    this.prune()
    const capture = this.attempts.find(a => a.nodeId === id && a.id === attemptId)?.captures[index]
    if (!capture?.path || capture.state !== 'available' || !this.ownedShot(capture.path)) return null
    try { return `data:image/png;base64,${readFileSync(capture.path).toString('base64')}` } catch { return null }
  }
  private ownedShot(path: string): boolean { return resolve(path).startsWith(resolve(this.shotsDir) + '\\') || resolve(path).startsWith(resolve(this.shotsDir) + '/') }
  prune(): void {
    const cutoff = this.now() - L.ageMs
    this.attempts = this.attempts.filter(a => a.startedAt >= cutoff)
    while (this.attempts.length > L.attempts || Buffer.byteLength(JSON.stringify(this.attempts)) > L.metadataBytes - 100) {
      const ended = this.attempts.findIndex(a => a.state !== 'recording')
      if (ended >= 0) { this.attempts.splice(ended, 1); continue }
      // Keep active attempt identities, but explicitly discard their oldest bulk evidence if the shared cap is hit.
      const largest = [...this.attempts].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]
      if (!largest) break
      const gap = 'Shared metadata limit reached; older evidence omitted.'
      if (!largest.gaps.includes(gap)) largest.gaps.push(gap)
      if (largest.diagnostics.length) largest.diagnostics.shift()
      else if (largest.actions.length) largest.actions.shift()
      else if (largest.captures.length) largest.captures.shift()
      else break
    }
    try {
      let total = 0
      const files = readdirSync(this.shotsDir).filter(n => n.endsWith('.png')).map(n => ({ path: join(this.shotsDir, n), stat: statSync(join(this.shotsDir, n)) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      files.forEach((f, i) => { total += f.stat.size; if (i >= LIMITS.screenshotsKept || f.stat.size > LIMITS.screenshotBytes || total > L.totalShotBytes || f.stat.mtimeMs < cutoff) rmSync(f.path, { force: true }) })
    } catch { /* Pictures can be missing; mark them below. */ }
    for (const a of this.attempts) for (const c of a.captures) if (c.state === 'available' && (!c.path || !this.ownedShot(c.path) || !existsSync(c.path))) { c.state = 'expired'; c.reason = 'Screenshot expired or is missing.' }
  }
  private save(id: string): void {
    this.prune()
    this.write(id)
    this.changed(id)
  }
  private write(id?: string): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, attempts: this.attempts }))
      renameSync(this.file + '.tmp', this.file)
    } catch {
      this.problem = 'Browser evidence could not be saved. These observations may be lost on restart.'
      for (const a of this.attempts) if (a.state === 'recording' || a.nodeId === id) {
        if (!a.gaps.includes(this.problem)) a.gaps.push(this.problem)
        if (a.state === 'recorded') a.state = 'incomplete'
      }
    }
  }
}

function validAttempt(a: BrowserAttempt): boolean {
  return !!a && typeof a.id === 'string' && typeof a.nodeId === 'string' && typeof a.url === 'string' && Number.isFinite(a.startedAt) &&
    ['recording', 'recorded', 'incomplete'].includes(a.state) && ['passed', 'failed', 'unknown'].includes(a.assertion) &&
    !!a.viewport && Number.isFinite(a.viewport.width) && Number.isFinite(a.viewport.height) &&
    Array.isArray(a.gaps) && a.gaps.every(g => typeof g === 'string') && Array.isArray(a.actions) && a.actions.every(s => s && typeof s.action === 'string') &&
    Array.isArray(a.captures) && a.captures.every(c => c && c.viewport && typeof c.state === 'string') &&
    Array.isArray(a.diagnostics) && a.diagnostics.every(d => d && typeof d.message === 'string')
}
