import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEvidenceStore } from '../../src/main/browser/evidenceStore'
import { EvidenceNetwork } from '../../src/main/browser/evidenceNetwork'
import { EVIDENCE_LIMITS, evidenceUrl, VIEWPORTS, type BrowserDiagnostic, type EvidenceAgent } from '../../src/shared/browserEvidence'
import { createBrowserVerbs } from '../../src/main/control/browserVerbs'
import type { BrowserDriver } from '../../src/main/browser/driver'
import type { BrowserNode } from '../../src/shared/model'
import { PRIVACY_CSS, privateScreenshot } from '../../src/main/browser/evidence'
import type { WebContents } from 'electron'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-evidence-'))
  dirs.push(dir)
  return dir
}
const agent: EvidenceAgent = { id: 'agent', title: 'Checker' }
const other: EvidenceAgent = { id: 'other', title: 'Second agent' }
const revision = { revision: 'a'.repeat(40), uncommitted: true, fingerprint: 'f' }
const start = (s: BrowserEvidenceStore, nodeId = 'b', by = agent) =>
  s.start({ nodeId, projectId: 'p', taskId: 'task-1', url: 'https://site.test/checkout?password=private#secret', viewport: { ...VIEWPORTS.desktop, preset: 'desktop' }, revision, by })
const diagnostic = (nodeId = 'b'): Omit<BrowserDiagnostic, 'attemptId'> => ({
  nodeId,
  pageId: 'page-1',
  pageUrl: 'https://site.test/checkout?secret=1',
  at: 1234,
  kind: 'console',
  message: 'password=PRIVATE cookie=PRIVATE Authorization: PRIVATE',
  url: 'https://site.test/source.js?secret=1',
  line: 5
})
const evidenceFile = (dir: string) => join(dir, 'browser-evidence.json')

test('attempts persist observed facts separately from assertions, with revision, task and who acted', async () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  const a = start(s)
  s.action('b', 'page-1', 'https://site.test/checkout', 'click e4', 'completed', agent)
  s.diagnostic(diagnostic())
  const done = s.finish('b', 'passed', agent)
  expect(done).toMatchObject({ state: 'recorded', assertion: 'passed', startedBy: agent, finishedBy: agent })
  await s.flush()
  const restored = new BrowserEvidenceStore(dir).list('b')[0]
  expect(restored).toMatchObject({ id: a.id, taskId: 'task-1', revision: { uncommitted: true }, diagnostics: [{ pageId: 'page-1', attemptId: a.id, at: 1234 }] })
  expect(restored.actions[0]).toMatchObject({ action: 'click e4', state: 'completed' })
  expect(readFileSync(evidenceFile(dir), 'utf8')).not.toMatch(/PRIVATE|password|#secret/)
})

test('retries create distinct attempts; restart preserves interruption rather than inferring success', async () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  const first = start(s)
  expect(() => start(s)).toThrow(/already recording/)
  await s.flush()
  const restored = new BrowserEvidenceStore(dir)
  expect(restored.list('b')[0]).toMatchObject({ state: 'incomplete', assertion: 'unknown', gaps: [expect.stringMatching(/restart/)] })
  expect(start(restored).id).not.toBe(first.id)
})

test('pictures keep viewport, capture time and whether fields were hidden; missing files become explicitly expired', () => {
  const s = new BrowserEvidenceStore(temp())
  start(s)
  const saved = s.savePicture('b', Buffer.from('png'))
  if (!('path' in saved)) throw new Error(saved.reason)
  s.capture('b', { at: 456, pageId: 'page-1', url: 'https://site.test/', viewport: { ...VIEWPORTS.mobile, preset: 'mobile' }, state: 'available', path: saved.path, width: 390, height: 844, masked: true })
  expect(s.list('b')[0].captures[0]).toMatchObject({ at: 456, viewport: { width: 390, height: 844, preset: 'mobile' }, state: 'available', masked: true })
  rmSync(saved.path)
  expect(s.list('b')[0].captures[0]).toMatchObject({ state: 'expired', reason: expect.stringMatching(/missing/) })
})

test('unavailable and incomplete captures remain distinct from an agent passing assertion', () => {
  const s = new BrowserEvidenceStore(temp())
  start(s)
  s.capture('b', { at: 456, pageId: 'page-1', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'unavailable', reason: 'Screenshot unavailable: The page took too long to draw a picture.' })
  expect(s.finish('b', 'passed', agent)).toMatchObject({ state: 'incomplete', assertion: 'passed', gaps: ['Screenshot unavailable: The page took too long to draw a picture.'] })
})

test('bounded logs explicitly report truncation and never retain console messages or request payloads', async () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  start(s)
  for (let i = 0; i < EVIDENCE_LIMITS.diagnostics + 5; i++) s.diagnostic(diagnostic())
  expect(s.list('b')[0].diagnostics).toHaveLength(EVIDENCE_LIMITS.diagnostics)
  expect(s.diagnostics('b', 'console')).toHaveLength(EVIDENCE_LIMITS.recent)
  expect(s.list('b')[0].gaps.join(' ')).toMatch(/limit/)
  await s.flush()
  expect(statSync(evidenceFile(dir)).size).toBeLessThan(EVIDENCE_LIMITS.metadataBytes)
  expect(readFileSync(evidenceFile(dir), 'utf8')).not.toContain('PRIVATE')
})

test('a burst of page errors is recorded without a write for each: one write follows, after a pause', async () => {
  vi.useFakeTimers()
  const dir = temp()
  const changed: string[] = []
  const s = new BrowserEvidenceStore(dir, (id) => changed.push(id), Date.now, 1000)
  start(s)
  const began = performance.now()
  for (let i = 0; i < EVIDENCE_LIMITS.diagnostics; i++) s.diagnostic(diagnostic())
  expect(performance.now() - began).toBeLessThan(200)
  expect(existsSync(evidenceFile(dir))).toBe(false)
  expect(s.summary('b')).toMatchObject({ count: 1, recording: true, version: EVIDENCE_LIMITS.diagnostics + 1 })
  vi.useRealTimers()
  await s.flush()
  expect(JSON.parse(readFileSync(evidenceFile(dir), 'utf8')).attempts[0].diagnostics).toHaveLength(EVIDENCE_LIMITS.diagnostics)
})

test('the file stays within its size limit by dropping the oldest finished attempts first', async () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  const filler = 'x'.repeat(900)
  for (let n = 0; n < 40; n++) {
    start(s, `n${n}`)
    for (let i = 0; i < EVIDENCE_LIMITS.diagnostics; i++) s.diagnostic({ ...diagnostic(`n${n}`), pageId: `${filler}${i}` })
    s.finish(`n${n}`, 'unknown', agent)
  }
  await s.flush()
  expect(statSync(evidenceFile(dir)).size).toBeLessThanOrEqual(EVIDENCE_LIMITS.metadataBytes)
  expect(s.list('n39')).toHaveLength(1)
  expect(s.list('n0')).toHaveLength(0)
})

test('retention expires old attempts and pictures; image reads cannot escape the evidence picture folder', () => {
  let now = Date.now()
  const s = new BrowserEvidenceStore(temp(), undefined, () => now)
  const a = start(s)
  mkdirSync(s.shotsDir)
  const old = join(s.shotsDir, 'old.png')
  writeFileSync(old, 'old')
  utimesSync(old, new Date(now - EVIDENCE_LIMITS.ageMs - 1), new Date(now - EVIDENCE_LIMITS.ageMs - 1))
  const outside = join(temp(), 'private.png')
  writeFileSync(outside, 'secret')
  s.capture('b', { at: now, pageId: 'p', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'available', path: outside })
  expect(s.image('b', a.id, 0)).toBeNull()
  expect(existsSync(old)).toBe(false)
  s.finish('b', 'unknown', agent)
  now += EVIDENCE_LIMITS.ageMs + 1
  expect(s.list('b')).toEqual([])
})

test("evidence pictures have their own folder: one no attempt refers to goes, plain screenshots aren't touched", () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  expect(s.shotsDir).toBe(join(dir, 'browser-evidence-shots'))
  start(s)
  mkdirSync(s.shotsDir, { recursive: true })
  writeFileSync(join(s.shotsDir, 'stray.png'), 'png')
  const saved = s.savePicture('b', Buffer.from('png'))
  if (!('path' in saved)) throw new Error(saved.reason)
  s.capture('b', { at: 1, pageId: 'p', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'available', path: saved.path })
  expect(readdirSync(s.shotsDir)).toEqual([saved.path.split(/[\\/]/).at(-1)])
  expect(s.savePicture('b', Buffer.alloc(EVIDENCE_LIMITS.shotBytes + 1))).toEqual({ reason: expect.stringMatching(/over/) })
})

test("an unreadable evidence file is kept aside, said once, and doesn't mark new attempts incomplete", async () => {
  const dir = temp()
  writeFileSync(evidenceFile(dir), '{broken')
  const s = new BrowserEvidenceStore(dir)
  expect(s.summary('b').problem).toMatch(/couldn't be read.*bad-/)
  expect(readdirSync(dir).some((n) => n.startsWith('browser-evidence.json.bad-'))).toBe(true)
  expect(readFileSync(join(dir, readdirSync(dir).find((n) => n.includes('.bad-'))!), 'utf8')).toBe('{broken')
  start(s)
  expect(s.finish('b', 'passed', agent)).toMatchObject({ state: 'recorded', gaps: [] })
})

test("a write that fails is reported, and the report goes once a write works again", async () => {
  const dir = temp()
  const s = new BrowserEvidenceStore(dir)
  start(s)
  mkdirSync(`${evidenceFile(dir)}.tmp`) // A folder where the temporary file should go makes the write fail.
  await s.flush()
  s.diagnostic(diagnostic())
  await s.flush()
  expect(s.summary('b').problem).toMatch(/could not be saved/)
  rmSync(`${evidenceFile(dir)}.tmp`, { recursive: true })
  s.diagnostic(diagnostic())
  await s.flush()
  expect(s.summary('b').problem).toBeNull()
})

test('action and capture count limits remain bounded and visible', () => {
  const s = new BrowserEvidenceStore(temp())
  start(s)
  for (let i = 0; i < EVIDENCE_LIMITS.actions + 1; i++) s.action('b', 'page', 'about:blank', 'click e1', 'completed', agent)
  for (let i = 0; i < EVIDENCE_LIMITS.captures + 1; i++) s.capture('b', { at: i, pageId: 'p', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'unavailable' })
  const a = s.finish('b', 'passed', agent)
  expect(a.actions).toHaveLength(EVIDENCE_LIMITS.actions)
  expect(a.captures).toHaveLength(EVIDENCE_LIMITS.captures)
  expect(a.state).toBe('incomplete')
  expect(a.gaps.join(' ')).toMatch(/Action limit/)
  expect(a.gaps.join(' ')).toMatch(/Capture limit/)
})

test('only the agent that started an attempt can step or finish it; another agent acting is named', () => {
  const s = new BrowserEvidenceStore(temp())
  start(s)
  expect(() => s.owned('b', other)).toThrow(/started by "Checker".*only it can/)
  expect(() => s.finish('b', 'passed', other)).toThrow(/only it can/)
  s.action('b', 'page', 'https://site.test/', 'click e2', 'completed', other)
  const done = s.finish('b', 'passed', agent)
  expect(done.actions[0]).toMatchObject({ action: 'click e2', by: 'Second agent' })
  expect(done.gaps).toContain('Second agent also acted on the page during this attempt.')
  expect(() => start(s, 'b', other)).not.toThrow()
})

test('an attempt nobody steps or finishes for ten minutes ends as abandoned, and frees the node', () => {
  let now = 1_000_000
  const s = new BrowserEvidenceStore(temp(), undefined, () => now)
  start(s)
  now += EVIDENCE_LIMITS.idleMs - 1000
  s.sweep()
  expect(s.active('b')).toBeDefined()
  s.owned('b', agent) // A step counts as activity.
  now += EVIDENCE_LIMITS.idleMs + 1
  s.sweep()
  expect(s.list('b')[0]).toMatchObject({ state: 'incomplete', gaps: [expect.stringMatching(/Abandoned.*Checker/)] })
  expect(() => start(s)).not.toThrow()
})

test('start, finish and interruption are reported for the task link; rows in between are not', () => {
  const s = new BrowserEvidenceStore(temp())
  const seen: string[] = []
  s.lifecycle = (a) => seen.push(a.state)
  start(s)
  s.diagnostic(diagnostic())
  s.action('b', 'p', 'about:blank', 'click e1', 'completed', agent)
  s.finish('b', 'failed', agent)
  start(s)
  s.interrupt('b', 'Takeover')
  expect(seen).toEqual(['recording', 'recorded', 'recording', 'incomplete'])
})

test('network attribution survives navigation and finish; a late answer never changes a finished attempt', () => {
  const s = new BrowserEvidenceStore(temp())
  let pageId = 'page-1'
  const n = new EvidenceNetwork(() => ({ nodeId: 'b', pageId, pageUrl: 'https://site.test/old?token=secret', attemptId: s.active('b')?.id ?? null }), (d) => s.diagnostic(d), () => {})
  n.start({ id: 1, webContentsId: 7, method: 'GET', url: 'https://site.test/pre?secret=1' })
  const a = start(s)
  n.start({ id: 2, webContentsId: 7, method: 'POST', url: 'https://site.test/fail?secret=2' })
  n.start({ id: 3, webContentsId: 7, method: 'GET', url: 'https://site.test/late' })
  n.end({ id: 2, statusCode: 500 }, false)
  s.finish('b', 'unknown', agent)
  pageId = 'page-2'
  start(s)
  n.end({ id: 1 }, true)
  n.end({ id: 3, statusCode: 502 }, false)
  const [later, first] = s.list('b')
  expect(later.diagnostics).toHaveLength(0)
  expect(first.diagnostics).toEqual([expect.objectContaining({ attemptId: a.id, pageId: 'page-1', status: 500, method: 'POST', url: 'https://site.test/fail' })])
  expect(s.diagnostics('b', 'network').filter((d) => d.attemptId === null)).toHaveLength(2)
})

test("a failed request keeps Chromium's fixed failure name; a cancelled one isn't a failure", () => {
  const s = new BrowserEvidenceStore(temp())
  const n = new EvidenceNetwork(() => ({ nodeId: 'b', pageId: 'p', pageUrl: 'https://site.test/', attemptId: null }), (d) => s.diagnostic(d), () => {})
  const fail = (id: number, error: string) => {
    n.start({ id, webContentsId: 7, method: 'GET', url: 'https://down.test/api' })
    n.end({ id, error }, true)
  }
  fail(1, 'net::ERR_CONNECTION_REFUSED')
  fail(2, 'net::ERR_FAILED token=SECRET')
  fail(3, 'net::ERR_ABORTED')
  const rows = s.diagnostics('b', 'network')
  expect(rows.map((d) => d.failure)).toEqual(['net::ERR_CONNECTION_REFUSED', 'other'])
  expect(JSON.stringify(rows)).not.toContain('SECRET')
})

test('URL metadata removes credentials, fragments, queries and token-like path parts, and refuses non-web content', () => {
  expect(evidenceUrl('https://name:password@site.test/path?authorization=secret#cookie')).toBe('https://site.test/path')
  expect(evidenceUrl('data:text/plain,password')).toBe('[URL omitted]')
  expect(evidenceUrl('https://site.test/reset/9f8a7b6c5d4e3f2a1b0c9d8e')).toBe('https://site.test/reset/[redacted]')
  expect(evidenceUrl('https://hooks.slack.com/services/T0001/B0002/XyZ123abcDEF456ghiJKL789')).toBe('https://hooks.slack.com/services/T0001/B0002/[redacted]')
  expect(evidenceUrl('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/send')).toBe('https://api.telegram.org/[redacted]/send')
  expect(evidenceUrl('https://site.test/blog/my-long-article-about-things-2024/comments')).toBe('https://site.test/blog/my-long-article-about-things-2024/comments')
})

test('the evidence picture mask keeps fields in place with an outline, hides frames, and is removed on failure', async () => {
  expect(PRIVACY_CSS).toMatch(/input, textarea, select, \[contenteditable\] \{ color: transparent/)
  expect(PRIVACY_CSS).toMatch(/outline: 2px dashed/)
  expect(PRIVACY_CSS).toMatch(/iframe, frame, embed, object \{ visibility: hidden/)
  expect(PRIVACY_CSS).not.toMatch(/input[^}]*visibility: hidden/)
  const guest = { insertCSS: vi.fn(async () => 'mask'), removeInsertedCSS: vi.fn(async () => {}), isDestroyed: () => false } as unknown as WebContents
  await expect(privateScreenshot(guest, async () => { throw new Error('hidden') })).rejects.toThrow('hidden')
  expect(guest.insertCSS).toHaveBeenCalledWith(PRIVACY_CSS, { cssOrigin: 'user' })
  expect(guest.removeInsertedCSS).toHaveBeenCalledWith('mask')
})

function verbs() {
  const node: BrowserNode = { id: 'b', kind: 'browser', title: 'Page', url: 'https://site.test/', x: 0, y: 0, width: 900, height: 600, parentId: null }
  const s = new BrowserEvidenceStore(temp())
  const titles: Record<string, string> = { agent: 'Checker', other: 'Second agent' }
  const evidence: NonNullable<BrowserDriver['evidence']> = {
    start: vi.fn(async (_id, by) => start(s, 'b', by)),
    capture: vi.fn(async (_id, check, by) => {
      s.owned('b', by)
      check()
      return s.list('b')
    }),
    finish: async (id, outcome, by) => s.finish(id, outcome, by),
    viewport: vi.fn(async (_id: string, preset: keyof typeof VIEWPORTS | 'node') => (preset === 'node' ? { width: 900, height: 560 } : { ...VIEWPORTS[preset], preset })),
    list: (id) => s.list(id),
    summary: (id) => s.summary(id),
    diagnostics: (id, kind) => s.diagnostics(id, kind),
    action: (id, action, state, by) => s.action(id, 'page', node.url, action, state, by),
    interrupt: (id) => s.interrupt(id, 'Takeover'),
    image: () => null
  }
  const driver = { evidence, waitReady: vi.fn(async () => true), noteDriving: vi.fn(), page: () => ({ url: node.url, title: 'Page' }), call: vi.fn(async () => ({ typed: 6 })), settled: async () => true } as unknown as BrowserDriver
  const find = (id: string) => (id === 'b' ? node : titles[id] ? ({ id, kind: 'terminal', title: titles[id] } as never) : undefined)
  const run = createBrowserVerbs({ driver, find, accessOf: (caller) => (caller === 'agent' || caller === 'other' ? 'linked' : null) })
  return { run, node, s, driver, evidence }
}

test('new evidence verbs preserve access and takeover rules', async () => {
  const { run, node, evidence } = verbs()
  for (const verb of ['console', 'network', 'evidence', 'viewport', 'verify']) {
    const args = { node: 'b', phase: 'start', preset: 'mobile' }
    await expect(run('stranger', `browser-${verb}`, args)).rejects.toThrow(/isn't linked/)
    node.held = true
    await expect(run('agent', `browser-${verb}`, args)).rejects.toThrow(/taken control/)
    node.held = false
  }
  expect(evidence.capture).not.toHaveBeenCalled()
})

test('named viewport presets, going back to the node size, and start/step/finish are reachable through agent verbs', async () => {
  const { run, s } = verbs()
  for (const preset of ['desktop', 'mobile']) await expect(run('agent', 'browser-viewport', { node: 'b', preset })).resolves.toMatchObject({ observed: { preset, ...VIEWPORTS[preset as keyof typeof VIEWPORTS] } })
  await expect(run('agent', 'browser-viewport', { node: 'b', preset: 'node' })).resolves.toMatchObject({ observed: { width: 900 } })
  await expect(run('agent', 'browser-viewport', { node: 'b', preset: 'tablet' })).rejects.toThrow(/desktop, mobile, or node/)
  await run('agent', 'browser-verify', { node: 'b', phase: 'start' })
  await run('agent', 'browser-type', { node: 'b', ref: 'e3', text: 'SECRET' })
  await run('agent', 'browser-verify', { node: 'b', phase: 'step' })
  const result = await run('agent', 'browser-verify', { node: 'b', phase: 'finish', outcome: 'passed' })
  expect(result).toMatchObject({ untrusted: true, assertionNotice: expect.stringContaining('do not prove'), pictureNotice: expect.stringContaining('form fields'), observed: { attempt: { assertion: 'passed', startedBy: { id: 'agent', title: 'Checker' } } } })
  expect(JSON.stringify(s.list('b'))).not.toContain('SECRET')
  expect(s.list('b')[0].actions).toContainEqual(expect.objectContaining({ action: 'type into e3', state: 'completed' }))
})

test("another linked agent can't finish someone else's attempt with its own outcome", async () => {
  const { run, s } = verbs()
  await run('agent', 'browser-verify', { node: 'b', phase: 'start' })
  await expect(run('other', 'browser-verify', { node: 'b', phase: 'finish', outcome: 'passed' })).rejects.toThrow(/started by "Checker"/)
  expect(s.active('b')?.assertion).toBe('unknown')
})

test('offscreen and takeover after a wait never start an attempt or take a screenshot', async () => {
  const { run, node, driver, evidence } = verbs()
  driver.waitReady = async () => false
  await expect(run('agent', 'browser-verify', { node: 'b', phase: 'start' })).rejects.toThrow(/isn't on screen/)
  driver.waitReady = async () => {
    node.held = true
    return true
  }
  await expect(run('agent', 'browser-verify', { node: 'b', phase: 'start' })).rejects.toThrow(/taken control/)
  expect(evidence.start).not.toHaveBeenCalled()
  expect(evidence.capture).not.toHaveBeenCalled()
})

test('Take control during a recording ends the attempt as incomplete, keeps what was observed, and refuses the next verb', async () => {
  const { run, node, s } = verbs()
  await run('agent', 'browser-verify', { node: 'b', phase: 'start' })
  await run('agent', 'browser-type', { node: 'b', ref: 'e3', text: 'x' })
  node.held = true
  await expect(run('agent', 'browser-verify', { node: 'b', phase: 'finish', outcome: 'passed' })).rejects.toThrow(/taken control/)
  const [attempt] = s.list('b')
  expect(attempt).toMatchObject({ state: 'incomplete', assertion: 'unknown', gaps: ['Takeover'] })
  expect(attempt.actions).toContainEqual(expect.objectContaining({ action: 'type into e3', state: 'completed' }))
})
