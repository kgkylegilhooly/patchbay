import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  EVIDENCE_LIMITS as L,
  evidenceUrl,
  type BrowserAttempt,
  type BrowserDiagnostic,
  type EvidenceAgent,
  type EvidenceCapture,
  type EvidenceSummary,
  type EvidenceViewport
} from '../../shared/browserEvidence'

/** How long changes wait before they're written, so a page logging errors in a burst costs one write, not hundreds. */
const WRITE_DELAY_MS = 1000

export class EvidenceRefusal extends Error {}

/**
 * Recorded browser checks, apart from the canvas: retries never overwrite another attempt. Only bounded, selected
 * fields enter here. Everything that runs on a page event is cheap: the file is written later, off the main thread.
 */
export class BrowserEvidenceStore {
  /** Saved evidence couldn't be read when the app started. Shown in the panel; it isn't a fault of any new attempt. */
  loadProblem: string | null = null
  /** The last write failed. Cleared by the next one that works. */
  writeProblem: string | null = null
  /** An attempt started or ended, for a task it's evidence for. Not called for each row recorded in between. */
  lifecycle: (attempt: BrowserAttempt) => void = () => {}
  /** A picture was kept as evidence, for the Files shelf. */
  shot: (nodeId: string, path: string) => void = () => {}
  readonly shotsDir: string
  private attempts: BrowserAttempt[] = []
  private recent = new Map<string, BrowserDiagnostic[]>()
  private versions = new Map<string, number>()
  private file: string
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private dir: string,
    private changed: (id: string) => void = () => {},
    private now: () => number = Date.now,
    private writeDelayMs = WRITE_DELAY_MS
  ) {
    this.file = join(dir, 'browser-evidence.json')
    this.shotsDir = join(dir, 'browser-evidence-shots')
    this.load()
    for (const a of this.attempts) {
      if (a.state !== 'recording') continue
      a.state = 'incomplete'
      a.finishedAt = now()
      a.gaps.push('Recording interrupted by application restart.')
    }
    this.pruneAttempts()
    this.pruneShots()
    if (this.attempts.length) this.schedule()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      if (statSync(this.file).size > L.metadataBytes) throw new Error('too large')
      const doc = JSON.parse(readFileSync(this.file, 'utf8'))
      if (doc.version !== 1 || !Array.isArray(doc.attempts)) throw new Error('not evidence')
      this.attempts = doc.attempts.filter(validAttempt)
      if (this.attempts.length < doc.attempts.length) this.loadProblem = 'Some saved browser evidence was damaged and was left out.'
    } catch {
      // Kept aside rather than overwritten by the next save, so nothing is lost for good.
      const aside = `${this.file}.bad-${this.now()}`
      try {
        renameSync(this.file, aside)
        this.loadProblem = `Saved browser evidence couldn't be read. It was kept as ${aside}.`
      } catch {
        this.loadProblem = "Saved browser evidence couldn't be read."
      }
    }
  }

  summary(id: string): EvidenceSummary {
    const mine = this.attempts.filter((a) => a.nodeId === id)
    return {
      count: mine.length,
      recording: mine.some((a) => a.state === 'recording'),
      version: this.versions.get(id) ?? 0,
      problem: this.writeProblem ?? this.loadProblem
    }
  }

  /** Newest first. Pictures whose files have gone are marked expired here, when someone looks. */
  list(id: string): BrowserAttempt[] {
    this.pruneAttempts()
    const mine = this.attempts.filter((a) => a.nodeId === id)
    for (const a of mine) {
      for (const c of a.captures) {
        if (c.state === 'available' && (!c.path || !this.ownedShot(c.path) || !existsSync(c.path))) {
          c.state = 'expired'
          c.reason = 'Screenshot expired or is missing.'
        }
      }
    }
    return structuredClone(mine.reverse())
  }

  active(id: string): BrowserAttempt | undefined {
    return this.attempts.find((a) => a.nodeId === id && a.state === 'recording')
  }

  /** Every attempt still recording, for checks that end the ones nobody can finish. */
  recording(): ReadonlyArray<Readonly<BrowserAttempt>> {
    return this.attempts.filter((a) => a.state === 'recording')
  }

  start(input: { nodeId: string; projectId?: string; taskId?: string; url: string; viewport: EvidenceViewport; revision: BrowserAttempt['revision']; by: EvidenceAgent }): BrowserAttempt {
    const current = this.active(input.nodeId)
    if (current) throw new EvidenceRefusal(`An attempt by ${who(current)} is already recording on this browser. It has to finish, or be abandoned, first.`)
    const { by, ...rest } = input
    const at = this.now()
    const a: BrowserAttempt = {
      ...rest,
      url: evidenceUrl(input.url),
      id: randomUUID(),
      startedBy: by,
      startedAt: at,
      activeAt: at,
      state: 'recording',
      assertion: 'unknown',
      actions: [],
      captures: [],
      diagnostics: [],
      gaps: []
    }
    this.attempts.push(a)
    this.pruneAttempts()
    this.save(input.nodeId)
    this.lifecycle(structuredClone(a))
    return structuredClone(a)
  }

  /** Steps and finish belong to the agent that started the attempt. Refuses anyone else. */
  owned(id: string, by: EvidenceAgent): BrowserAttempt {
    const a = this.active(id)
    if (!a) throw new EvidenceRefusal('No attempt is recording. Start one first.')
    if (a.startedBy && a.startedBy.id !== by.id) {
      throw new EvidenceRefusal(`This attempt was started by ${who(a)}, so only it can add steps or finish it.`)
    }
    a.activeAt = this.now()
    return a
  }

  gap(id: string, message: string): void {
    const a = this.active(id)
    if (a && !a.gaps.includes(message)) {
      a.gaps.push(message)
      this.save(id)
    }
  }

  interrupt(id: string, reason: string): void {
    const a = this.active(id)
    if (!a) return
    if (!a.gaps.includes(reason)) a.gaps.push(reason)
    a.state = 'incomplete'
    a.finishedAt = this.now()
    this.save(id)
    this.lifecycle(structuredClone(a))
  }

  finish(id: string, assertion: BrowserAttempt['assertion'], by: EvidenceAgent): BrowserAttempt {
    const a = this.owned(id, by)
    a.assertion = assertion
    a.finishedBy = by
    a.state = a.gaps.length ? 'incomplete' : 'recorded'
    a.finishedAt = this.now()
    this.save(id)
    this.lifecycle(structuredClone(a))
    return structuredClone(a)
  }

  /** Ends attempts whose agent has gone quiet, so they don't stay "recording" and block the node for good. */
  sweep(): void {
    const cutoff = this.now() - L.idleMs
    for (const a of this.recording()) {
      if ((a.activeAt ?? a.startedAt) < cutoff) {
        this.interrupt(a.nodeId, `Abandoned: no step or finish from ${who(a)} for ${L.idleMs / 60_000} minutes.`)
      }
    }
  }

  action(id: string, pageId: string, url: string, action: string, state: 'completed' | 'failed', by?: EvidenceAgent): void {
    const a = this.active(id)
    if (!a) return
    if (by && a.startedBy?.id === by.id) a.activeAt = this.now()
    if (a.actions.length >= L.actions) return this.gap(id, 'Action limit reached; later actions omitted.')
    const other = by && a.startedBy && a.startedBy.id !== by.id
    a.actions.push({ at: this.now(), pageId, url: evidenceUrl(url), action, state, ...(other ? { by: by.title } : {}) })
    if (state === 'failed' && !a.gaps.includes('An action failed or was interrupted.')) a.gaps.push('An action failed or was interrupted.')
    if (other) {
      const note = `${by.title} also acted on the page during this attempt.`
      if (!a.gaps.includes(note)) a.gaps.push(note)
    }
    this.save(id)
  }

  diagnostic(input: Omit<BrowserDiagnostic, 'attemptId'> & { attemptId?: string | null }): void {
    // A request is attributed when it starts. One that ends after its attempt finished doesn't change that record.
    const a = input.attemptId === undefined ? this.active(input.nodeId) : this.attempts.find((x) => x.id === input.attemptId && x.nodeId === input.nodeId)
    const into = a?.state === 'recording' ? a : undefined
    const d: BrowserDiagnostic = {
      ...input,
      message: input.kind === 'console' ? 'Console error (message omitted for privacy).' : input.status ? 'HTTP failure' : 'Request failed',
      pageUrl: evidenceUrl(input.pageUrl),
      url: input.url ? evidenceUrl(input.url) : undefined,
      attemptId: into?.id ?? null
    }
    const rows = this.recent.get(input.nodeId) ?? []
    rows.push(d)
    if (rows.length > L.recent) rows.splice(0, rows.length - L.recent)
    this.recent.set(input.nodeId, rows)
    if (!into) return
    if (into.diagnostics.length >= L.diagnostics) return this.gap(input.nodeId, 'Diagnostic limit reached; later entries omitted.')
    into.diagnostics.push(d)
    this.save(input.nodeId)
  }

  diagnostics(id: string, kind: BrowserDiagnostic['kind']): BrowserDiagnostic[] {
    return structuredClone((this.recent.get(id) ?? []).filter((d) => d.kind === kind))
  }

  forgetRecent(id: string): void {
    this.recent.delete(id)
  }

  /** Writes an evidence picture into this store's own folder. The path, or why there's none. */
  savePicture(nodeId: string, png: Buffer): { path: string } | { reason: string } {
    if (png.length > L.shotBytes) return { reason: `The picture was over ${L.shotBytes} bytes, so it wasn't kept.` }
    try {
      mkdirSync(this.shotsDir, { recursive: true })
      const path = join(this.shotsDir, `${nodeId.slice(0, 40).replace(/[^\w-]/g, '_')}-${this.now()}-${randomUUID().slice(0, 8)}.png`)
      writeFileSync(path, png)
      return { path }
    } catch (e) {
      return { reason: `The picture couldn't be saved (${(e as NodeJS.ErrnoException).code ?? 'error'}).` }
    }
  }

  capture(id: string, capture: EvidenceCapture): void {
    const a = this.active(id)
    if (!a) throw new EvidenceRefusal('No attempt is recording. Start one first.')
    if (a.captures.length >= L.captures) {
      if (capture.path) rmSync(capture.path, { force: true })
      return this.gap(id, 'Capture limit reached; later pictures omitted.')
    }
    a.captures.push({ ...capture, url: evidenceUrl(capture.url) })
    const reason = capture.reason ?? 'Screenshot unavailable.'
    if (capture.state !== 'available' && !a.gaps.includes(reason)) a.gaps.push(reason)
    if (capture.path) this.pruneShots()
    if (capture.path) this.shot(id, capture.path)
    this.save(id)
  }

  image(id: string, attemptId: string, index: number): string | null {
    const capture = this.attempts.find((a) => a.nodeId === id && a.id === attemptId)?.captures[index]
    if (!capture?.path || capture.state !== 'available' || !this.ownedShot(capture.path)) return null
    try {
      return `data:image/png;base64,${readFileSync(capture.path).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Writes now what's waiting, as when the app quits. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.writing = this.writing.then(() => this.write())
    }
    return this.writing
  }

  private ownedShot(path: string): boolean {
    return resolve(path).startsWith(resolve(this.shotsDir) + sep)
  }

  private pruneAttempts(): void {
    const cutoff = this.now() - L.ageMs
    this.attempts = this.attempts.filter((a) => a.state === 'recording' || a.startedAt >= cutoff)
    while (this.attempts.length > L.attempts) {
      const ended = this.attempts.findIndex((a) => a.state !== 'recording')
      if (ended < 0) break
      this.attempts.splice(ended, 1)
    }
  }

  /** Pictures no kept attempt refers to go, then the oldest beyond the allowance. Only after a new picture, or at start. */
  pruneShots(): void {
    let names: string[]
    try {
      names = readdirSync(this.shotsDir).filter((n) => n.endsWith('.png'))
    } catch {
      return
    }
    const kept = new Set(this.attempts.flatMap((a) => a.captures.flatMap((c) => (c.path ? [resolve(c.path).toLowerCase()] : []))))
    const cutoff = this.now() - L.ageMs
    const files = names
      .map((n) => {
        const path = join(this.shotsDir, n)
        try {
          return { path, stat: statSync(path) }
        } catch {
          return null
        }
      })
      .filter((f): f is NonNullable<typeof f> => !!f)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    let total = 0
    for (const f of files) {
      total += f.stat.size
      if (!kept.has(resolve(f.path).toLowerCase()) || total > L.totalShotBytes || f.stat.mtimeMs < cutoff) rmSync(f.path, { force: true })
    }
  }

  private save(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    this.schedule()
    this.changed(id)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.writing = this.writing.then(() => this.write())
    }, this.writeDelayMs)
    this.timer.unref?.()
  }

  /** The whole file, within its size limit: the oldest finished attempts go first, then a recording one's oldest rows. */
  private serialize(): string {
    let text = JSON.stringify({ version: 1, attempts: this.attempts })
    while (Buffer.byteLength(text) > L.metadataBytes) {
      const ended = this.attempts.findIndex((a) => a.state !== 'recording')
      if (ended >= 0) this.attempts.splice(ended, 1)
      else {
        const largest = [...this.attempts].sort((a, b) => b.diagnostics.length + b.actions.length - (a.diagnostics.length + a.actions.length))[0]
        if (!largest || (!largest.diagnostics.length && !largest.actions.length)) break
        const gap = 'Shared metadata limit reached; older evidence omitted.'
        if (!largest.gaps.includes(gap)) largest.gaps.push(gap)
        largest.diagnostics.splice(0, Math.ceil(largest.diagnostics.length / 4))
        largest.actions.splice(0, Math.ceil(largest.actions.length / 4))
      }
      text = JSON.stringify({ version: 1, attempts: this.attempts })
    }
    return text
  }

  private async write(): Promise<void> {
    const text = this.serialize()
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(`${this.file}.tmp`, text)
      await rename(`${this.file}.tmp`, this.file)
      this.writeProblem = null
    } catch {
      this.writeProblem = 'Browser evidence could not be saved. These observations may be lost on restart.'
      for (const a of this.attempts) if (a.state === 'recording' && !a.gaps.includes(this.writeProblem)) a.gaps.push(this.writeProblem)
    }
  }
}

const who = (a: BrowserAttempt): string => (a.startedBy ? `"${a.startedBy.title}" (node ${a.startedBy.id})` : 'another agent')

function validAttempt(a: BrowserAttempt): boolean {
  return (
    !!a &&
    typeof a.id === 'string' &&
    typeof a.nodeId === 'string' &&
    typeof a.url === 'string' &&
    Number.isFinite(a.startedAt) &&
    ['recording', 'recorded', 'incomplete'].includes(a.state) &&
    ['passed', 'failed', 'unknown'].includes(a.assertion) &&
    !!a.viewport &&
    Number.isFinite(a.viewport.width) &&
    Number.isFinite(a.viewport.height) &&
    Array.isArray(a.gaps) &&
    a.gaps.every((g) => typeof g === 'string') &&
    Array.isArray(a.actions) &&
    a.actions.every((s) => s && typeof s.action === 'string') &&
    Array.isArray(a.captures) &&
    a.captures.every((c) => c && c.viewport && typeof c.state === 'string') &&
    Array.isArray(a.diagnostics) &&
    a.diagnostics.every((d) => d && typeof d.message === 'string')
  )
}
