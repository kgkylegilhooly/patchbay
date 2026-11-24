import { describe, expect, it } from 'vitest'
import { actionById } from '../../src/renderer/actions'
import { agentLine, buildLine, copiedText } from '../../src/renderer/diagnostics/diagnosticsUi'
import { helpMenu, type Commands } from '../../src/renderer/menus'

describe('About lines', () => {
  it('says the commit, branch and build time', () => {
    const line = buildLine({ commit: 'e94fa9b1c2', dirty: false, branch: 'main', date: '2026-11-24T10:00:00.000Z' }, 'en-GB')
    expect(line).toMatch(/^Commit e94fa9b1c2 on main, built 24 Nov 2026, \d\d:\d\d$/)
    expect(buildLine({ commit: 'e94fa9b1c2', dirty: true, branch: 'HEAD', date: 'x' })).toBe('Commit e94fa9b1c2 with changes, build date unknown')
    expect(buildLine({ commit: 'unknown', dirty: false, branch: '', date: 'unknown' })).toBe('Commit unknown, build date unknown')
  })

  it('puts a version after the name, and anything else after a comma', () => {
    expect(agentLine({ kind: 'claude', name: 'Claude Code', program: 'x', version: '2.1.150' })).toBe('Claude Code 2.1.150')
    expect(agentLine({ kind: 'codex', name: 'Codex', program: null, version: 'not found' })).toBe('Codex, not found')
  })

  it('says what the copy did', () => {
    expect(copiedText({ ok: true, lines: 62 })).toBe('Diagnostics copied, 62 lines. Paste them into your bug report.')
    expect(copiedText({ ok: false, reason: 'No.' })).toBe('No.')
  })
})

describe('where Copy diagnostics is', () => {
  it('is in Help, next to the log, and in the palette', () => {
    const ids = helpMenu({} as Commands).flatMap((e) => (e === 'separator' ? [] : [e.id]))
    expect(ids).toEqual(['help-shortcuts', 'help-log', 'open-log-folder', 'copy-diagnostics', 'help-about'])
    expect(actionById('copy-diagnostics')?.label).toBe('Copy diagnostics')
    expect(actionById('open-log-folder')?.label).toBe('Open log folder')
  })
})

describe('About rows, for the keyboard and screen readers', () => {
  it('M2: Copy diagnostics is never disabled while busy, so it keeps focus; it says busy with aria-disabled', async () => {
    const { copyButtonState } = await import('../../src/renderer/diagnostics/diagnosticsUi')
    expect(copyButtonState(true)).toEqual({ 'aria-disabled': true, label: 'Copying…' })
    expect(copyButtonState(false)).toEqual({ 'aria-disabled': false, label: 'Copy diagnostics' })
  })

  it("L6: the log's Open folder button has a name of its own", async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    // A .tsx component, which the node typecheck of tests doesn't compile, so it's loaded by a path it doesn't follow, as in shell.test.ts.
    const path: string = '../../src/renderer/diagnostics/AboutDiagnostics'
    const { ReportRows } = await import(/* @vite-ignore */ path)
    const html = renderToStaticMarkup(createElement(ReportRows))
    expect(html).toContain('aria-label="Open log folder"')
    expect(html).not.toMatch(/data-cmd="copy-diagnostics"[^>]*disabled=""/)
  })
})
