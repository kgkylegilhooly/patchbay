import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserEvidenceStore } from '../../src/main/browser/evidenceStore'
import { EvidenceNetwork } from '../../src/main/browser/evidenceNetwork'
import { EVIDENCE_LIMITS, evidenceUrl, VIEWPORTS, type BrowserDiagnostic } from '../../src/shared/browserEvidence'
import { createBrowserVerbs } from '../../src/main/control/browserVerbs'
import type { BrowserDriver } from '../../src/main/browser/driver'
import type { BrowserNode } from '../../src/shared/model'
import { privateScreenshot } from '../../src/main/browser/evidence'
import type { WebContents } from 'electron'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'pb-evidence-')); dirs.push(dir); return dir }
const start = (s: BrowserEvidenceStore, nodeId = 'b') => s.start({ nodeId, projectId: 'p', taskId: 'task-1', url: 'https://site.test/checkout?password=private#secret', viewport: { ...VIEWPORTS.desktop, preset: 'desktop' }, revision: { commit: 'a'.repeat(40), dirty: true } })
const diagnostic = (nodeId = 'b'): Omit<BrowserDiagnostic, 'attemptId'> => ({ nodeId, pageId: 'page-1', pageUrl: 'https://site.test/checkout?secret=1', at: 1234, kind: 'console', message: 'password=PRIVATE cookie=PRIVATE Authorization: PRIVATE', url: 'https://site.test/source.js?secret=1', line: 5 })

test('attempts persist observed facts separately from assertions and retain revision, dirty state and optional task', () => {
  const dir = temp(); const s = new BrowserEvidenceStore(dir)
  const a = start(s)
  s.action('b', 'page-1', 'https://site.test/checkout', 'click e4', 'completed')
  s.diagnostic(diagnostic())
  const done = s.finish('b', 'passed')
  expect(done.state).toBe('recorded')
  expect(done.assertion).toBe('passed')
  const restored = new BrowserEvidenceStore(dir).list('b')[0]
  expect(restored).toMatchObject({ id: a.id, taskId: 'task-1', revision: { dirty: true }, diagnostics: [{ pageId: 'page-1', attemptId: a.id, at: 1234 }] })
  expect(restored.actions[0]).toMatchObject({ action: 'click e4', state: 'completed' })
  expect(readFileSync(join(dir, 'browser-evidence.json'), 'utf8')).not.toMatch(/PRIVATE|password|#secret/)
})

test('retries create distinct attempts; restart preserves interruption rather than inferring success', () => {
  const dir = temp(); const s = new BrowserEvidenceStore(dir); const first = start(s)
  expect(() => start(s)).toThrow(/already recording/)
  const restored = new BrowserEvidenceStore(dir)
  expect(restored.list('b')[0]).toMatchObject({ state: 'incomplete', assertion: 'unknown', gaps: [expect.stringMatching(/restart/)] })
  expect(start(restored).id).not.toBe(first.id)
})

test('pictures keep viewport and capture time; missing files become explicitly expired', () => {
  const s = new BrowserEvidenceStore(temp()); start(s)
  mkdirSync(s.shotsDir); const path = join(s.shotsDir, 'shot.png'); writeFileSync(path, 'png')
  s.capture('b', { at: 456, pageId: 'page-1', url: 'https://site.test/', viewport: { ...VIEWPORTS.mobile, preset: 'mobile' }, state: 'available', path, width: 390, height: 844 })
  expect(s.list('b')[0].captures[0]).toMatchObject({ at: 456, viewport: { width: 390, height: 844, preset: 'mobile' }, state: 'available' })
  rmSync(path)
  expect(s.list('b')[0].captures[0]).toMatchObject({ state: 'expired', reason: expect.stringMatching(/missing/) })
})

test('unavailable and incomplete captures remain distinct from an agent passing assertion', () => {
  const s = new BrowserEvidenceStore(temp()); start(s)
  s.capture('b', { at: 456, pageId: 'page-1', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'unavailable', reason: 'Page still loading.' })
  expect(s.finish('b', 'passed')).toMatchObject({ state: 'incomplete', assertion: 'passed', gaps: ['Page still loading.'] })
})

test('bounded logs explicitly report truncation and never retain console messages or request payloads', () => {
  const dir = temp(); const s = new BrowserEvidenceStore(dir); start(s)
  for (let i = 0; i < EVIDENCE_LIMITS.diagnostics + 5; i++) s.diagnostic(diagnostic())
  expect(s.list('b')[0].diagnostics).toHaveLength(EVIDENCE_LIMITS.diagnostics)
  expect(s.diagnostics('b', 'console')).toHaveLength(EVIDENCE_LIMITS.recent)
  expect(s.list('b')[0].gaps.join(' ')).toMatch(/limit/)
  expect(statSync(join(dir, 'browser-evidence.json')).size).toBeLessThan(EVIDENCE_LIMITS.metadataBytes)
  expect(readFileSync(join(dir, 'browser-evidence.json'), 'utf8')).not.toContain('PRIVATE')
})

test('retention expires old attempts and screenshots; image reads cannot escape the screenshot directory', () => {
  let now = Date.now(); const s = new BrowserEvidenceStore(temp(), undefined, () => now); const a = start(s)
  mkdirSync(s.shotsDir)
  const file = join(s.shotsDir, 'old.png'); writeFileSync(file, 'old'); utimesSync(file, new Date(now - EVIDENCE_LIMITS.ageMs - 1), new Date(now - EVIDENCE_LIMITS.ageMs - 1))
  const outside = join(temp(), 'private.png'); writeFileSync(outside, 'secret')
  s.capture('b', { at: now, pageId: 'p', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'available', path: outside })
  expect(s.image('b', a.id, 0)).toBeNull()
  expect(() => statSync(file)).toThrow()
  now += EVIDENCE_LIMITS.ageMs + 1
  expect(s.list('b')).toEqual([])
})

test('malformed saved evidence is explicitly unavailable', () => {
  const dir = temp(); writeFileSync(join(dir, 'browser-evidence.json'), '{broken')
  const s = new BrowserEvidenceStore(dir)
  expect(s.problem).toMatch(/unavailable/)
  expect(s.list('b')).toEqual([])
})

test('action and capture count limits remain bounded and visible', () => {
  const s = new BrowserEvidenceStore(temp()); start(s)
  for (let i = 0; i < EVIDENCE_LIMITS.actions + 1; i++) s.action('b', 'page', 'about:blank', 'click e1', 'completed')
  for (let i = 0; i < EVIDENCE_LIMITS.captures + 1; i++) s.capture('b', { at: i, pageId: 'p', url: 'about:blank', viewport: VIEWPORTS.desktop, state: 'unavailable' })
  const a = s.finish('b', 'passed')
  expect(a.actions).toHaveLength(EVIDENCE_LIMITS.actions)
  expect(a.captures).toHaveLength(EVIDENCE_LIMITS.captures)
  expect(a.state).toBe('incomplete')
  expect(a.gaps.join(' ')).toMatch(/Action limit/)
  expect(a.gaps.join(' ')).toMatch(/Capture limit/)
})

test('only the newest fifty screenshot files are retained', () => {
  const s = new BrowserEvidenceStore(temp()); mkdirSync(s.shotsDir)
  for (let i = 0; i < 51; i++) { const file = join(s.shotsDir, `${i}.png`); writeFileSync(file, 'png'); utimesSync(file, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000)) }
  s.prune()
  expect(() => statSync(join(s.shotsDir, '0.png'))).toThrow()
  expect(statSync(join(s.shotsDir, '50.png')).size).toBe(3)
})

test('network attribution survives navigation and finish; pre-attempt requests never leak into a later attempt', () => {
  const s = new BrowserEvidenceStore(temp())
  let pageId = 'page-1'
  const n = new EvidenceNetwork(() => ({ nodeId: 'b', pageId, pageUrl: 'https://site.test/old?token=secret', attemptId: s.active('b')?.id ?? null }), d => s.diagnostic(d), () => {})
  n.start({ id: 1, webContentsId: 7, method: 'GET', url: 'https://site.test/pre?secret=1' })
  const a = start(s)
  n.start({ id: 2, webContentsId: 7, method: 'POST', url: 'https://site.test/fail?secret=2' })
  s.finish('b', 'unknown'); pageId = 'page-2'; start(s)
  n.end({ id: 1 }, true); n.end({ id: 2, statusCode: 500 }, false)
  expect(s.list('b')[0].diagnostics).toHaveLength(0)
  expect(s.list('b')[1].diagnostics[0]).toMatchObject({ attemptId: a.id, pageId: 'page-1', status: 500, method: 'POST', url: 'https://site.test/fail' })
  expect(s.diagnostics('b', 'network')[0].attemptId).toBeNull()
})

test('URL metadata removes credentials, fragments and queries and refuses non-web content', () => {
  expect(evidenceUrl('https://name:password@site.test/path?authorization=secret#cookie')).toBe('https://site.test/path')
  expect(evidenceUrl('data:text/plain,password')).toBe('[URL omitted]')
})

test('screenshot privacy mask covers inputs, editable text and embedded frames and is restored on failure', async () => {
  const guest = { insertCSS: vi.fn(async () => 'mask'), removeInsertedCSS: vi.fn(async () => {}), isDestroyed: () => false } as unknown as WebContents
  await expect(privateScreenshot(guest, async () => { throw new Error('hidden') })).rejects.toThrow('hidden')
  expect(guest.insertCSS).toHaveBeenCalledWith(expect.stringMatching(/input.*textarea.*contenteditable.*iframe/), { cssOrigin: 'user' })
  expect(guest.removeInsertedCSS).toHaveBeenCalledWith('mask')
})

function verbs() {
  const node: BrowserNode = { id: 'b', kind: 'browser', title: 'Page', url: 'https://site.test/', x: 0, y: 0, width: 900, height: 600, parentId: null }
  const s = new BrowserEvidenceStore(temp())
  const evidence: NonNullable<BrowserDriver['evidence']> = {
    start: vi.fn(async () => start(s)), capture: vi.fn(async (_id, check) => { check(); return s.list('b') }), finish: (id, outcome) => s.finish(id, outcome),
    viewport: vi.fn(async (_id: string, preset: keyof typeof VIEWPORTS) => ({ ...VIEWPORTS[preset], preset })), list: id => s.list(id), diagnostics: (id, kind) => s.diagnostics(id, kind),
    action: (id, action, state) => s.action(id, 'page', node.url, action, state), interrupt: id => s.interrupt(id, 'Takeover'), image: () => null
  }
  const driver = { evidence, waitReady: vi.fn(async () => true), noteDriving: vi.fn(), page: () => ({ url: node.url, title: 'Page' }), call: vi.fn(async () => ({ typed: 6 })), settled: async () => true } as unknown as BrowserDriver
  const run = createBrowserVerbs({ driver, find: id => id === 'b' ? node : undefined, accessOf: caller => caller === 'agent' ? 'linked' : null })
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

test('named viewport presets and start/step/finish are reachable through agent verbs', async () => {
  const { run, s } = verbs()
  for (const preset of ['desktop', 'mobile']) await expect(run('agent', 'browser-viewport', { node: 'b', preset })).resolves.toMatchObject({ observed: { preset, ...VIEWPORTS[preset as keyof typeof VIEWPORTS] } })
  await run('agent', 'browser-verify', { node: 'b', phase: 'start' })
  await run('agent', 'browser-type', { node: 'b', ref: 'e3', text: 'SECRET' })
  await run('agent', 'browser-verify', { node: 'b', phase: 'step' })
  const result = await run('agent', 'browser-verify', { node: 'b', phase: 'finish', outcome: 'passed' })
  expect(result).toMatchObject({ untrusted: true, assertionNotice: expect.stringContaining('do not prove'), observed: { attempt: { assertion: 'passed' } } })
  expect(JSON.stringify(s.list('b'))).not.toContain('SECRET')
  expect(s.list('b')[0].actions).toContainEqual(expect.objectContaining({ action: 'type into e3', state: 'completed' }))
})

test('offscreen and takeover after a wait never start an attempt or take a screenshot', async () => {
  const { run, node, driver, evidence } = verbs()
  driver.waitReady = async () => false
  await expect(run('agent', 'browser-verify', { node: 'b', phase: 'start' })).rejects.toThrow(/isn't on screen/)
  driver.waitReady = async () => { node.held = true; return true }
  await expect(run('agent', 'browser-verify', { node: 'b', phase: 'start' })).rejects.toThrow(/taken control/)
  expect(evidence.start).not.toHaveBeenCalled()
  expect(evidence.capture).not.toHaveBeenCalled()
})
