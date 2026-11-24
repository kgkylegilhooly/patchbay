import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { panelKeyAction, panelStack, type PanelKey } from '../../src/renderer/shell/panelKeys'

// The components are .tsx, which the node typecheck of tests doesn't compile, so they're loaded by a path it doesn't follow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (path: string): Promise<any> => import(path)
const { Panel } = await load('../../src/renderer/shell/Panel')
const { FormShell } = await load('../../src/renderer/shell/FormShell')
const { ConfirmDialog } = await load('../../src/renderer/shell/Confirm')

const noop = (): void => {}
const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('Panel', () => {
  it('has one header with the title, the context line and one close control, last', () => {
    const html = renderToStaticMarkup(h(Panel, { kind: 'drawer', title: 'Search', sub: 'Every project', actions: h('button', { id: 'refresh' }, 'Refresh'), onClose: noop }, 'body'))
    expect(count(html, 'class="shell-head"')).toBe(1)
    expect(html).toContain('<span class="shell-title-text">Search</span>')
    expect(html).toContain('<span class="shell-sub">Every project</span>')
    expect(count(html, 'data-shell="close"')).toBe(1)
    expect(html).toContain('title="Close (Esc)"')
    // The close control comes after the header's actions.
    expect(html.indexOf('id="refresh"')).toBeLessThan(html.indexOf('data-shell="close"'))
  })

  it('pins the footer outside the scrolling body', () => {
    const html = renderToStaticMarkup(h(Panel, { kind: 'modal', title: 'Archive', onClose: noop, footer: h('button', null, 'Archive') }, h('p', null, 'What happens')))
    const body = html.indexOf('class="shell-body"')
    const foot = html.indexOf('class="shell-foot"')
    expect(body).toBeGreaterThan(-1)
    expect(foot).toBeGreaterThan(body)
    // The footer is a sibling of the body, not inside it.
    expect(html.slice(body, foot)).toContain('</div>')
  })

  it('is modal only when it covers what is behind it', () => {
    const modal = renderToStaticMarkup(h(Panel, { kind: 'modal', title: 'M', onClose: noop }))
    const view = renderToStaticMarkup(h(Panel, { kind: 'view', title: 'V', onClose: noop }))
    const drawer = renderToStaticMarkup(h(Panel, { kind: 'drawer', title: 'D', onClose: noop }))
    const form = renderToStaticMarkup(h(Panel, { kind: 'form', title: 'F', onClose: noop }))
    expect(modal).toContain('aria-modal="true"')
    expect(modal).toContain('class="shell-layer"')
    expect(view).toContain('aria-modal="true"')
    expect(drawer).not.toContain('aria-modal')
    expect(form).not.toContain('aria-modal')
    // A form is a non-modal dialog, described by the line that says its keys (F6 there and back).
    expect(form).toContain('aria-describedby="pb-form-keys"')
    for (const html of [modal, view, drawer]) expect(html).not.toContain('aria-describedby')
    for (const html of [modal, view, drawer, form]) expect(html).toContain('role="dialog"')
  })

  it('names itself after its title, or the label given', () => {
    expect(renderToStaticMarkup(h(Panel, { kind: 'drawer', title: 'Git', onClose: noop }))).toContain('aria-label="Git"')
    expect(renderToStaticMarkup(h(Panel, { kind: 'view', title: 'Website', label: 'Board for Website', onClose: noop }))).toContain('aria-label="Board for Website"')
  })

  it('disables the close control while busy', () => {
    const html = renderToStaticMarkup(h(Panel, { kind: 'modal', title: 'Archiving', busy: true, onClose: noop }))
    expect(html).toMatch(/data-shell="close"[^>]*disabled=""|disabled=""[^>]*data-shell="close"/)
  })

  it('is a form when it submits', () => {
    expect(renderToStaticMarkup(h(Panel, { kind: 'modal', title: 'Save', onClose: noop, onSubmit: noop }))).toMatch(/^<div class="shell-layer"><form /)
  })
})

describe('FormShell', () => {
  const form = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(h(FormShell, { title: 'New Claude Code', icon: 'claude', onCancel: noop, onSubmit: noop, submitLabel: 'Start Claude Code', ...props }, h('textarea', { 'data-autofocus': '' })))

  it('is a titled form with Cancel, then the primary verb, and the Ctrl+Enter hint', () => {
    const html = form()
    expect(html).toMatch(/^<form class="shell shell-form pop"/)
    expect(html).toContain('aria-label="New Claude Code"')
    expect(html).toContain('Ctrl+Enter')
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.indexOf('>Start Claude Code<'))
    expect(html).toContain('<button type="submit" class="btn btn-solid">Start Claude Code</button>')
  })

  it('disables the primary while blocked', () => {
    expect(form({ blocked: true })).toContain('<button type="submit" class="btn btn-solid" disabled="">')
  })

  it('can leave out the hint', () => {
    expect(form({ hint: false })).not.toContain('Ctrl+Enter')
  })
})

describe('ConfirmDialog', () => {
  it('asks with a red verb and starts on Cancel for danger', () => {
    const html = renderToStaticMarkup(h(ConfirmDialog, { title: 'Delete project?', message: 'Ends "Dev".', verb: 'Delete project', onConfirm: noop, onCancel: noop }))
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('<p class="confirm-message">Ends &quot;Dev&quot;.</p>')
    expect(html).toMatch(/<button type="button" class="btn" data-autofocus="">Cancel<\/button>/)
    expect(html).toContain('<button type="button" class="btn btn-danger">Delete project</button>')
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.indexOf('>Delete project<'))
  })

  it('starts on the verb, in white, when it is not dangerous', () => {
    const html = renderToStaticMarkup(h(ConfirmDialog, { title: 'Pull with a merge?', verb: 'Pull and merge', tone: 'neutral', onConfirm: noop, onCancel: noop }))
    expect(html).toContain('<button type="button" class="btn btn-solid" data-autofocus="">Pull and merge</button>')
  })

  it('carries the hooks scripts use', () => {
    const html = renderToStaticMarkup(
      h(ConfirmDialog, { title: 'Discard?', verb: 'Discard', lines: ['README.md'], attrs: { 'data-git-confirm': 'discard' }, verbAttrs: { 'data-git': 'confirm' }, cancelAttrs: { 'data-git': 'cancel' }, onConfirm: noop, onCancel: noop })
    )
    expect(html).toContain('data-git-confirm="discard"')
    expect(html).toContain('data-git="confirm"')
    expect(html).toContain('data-git="cancel"')
    expect(html).toContain('<li>README.md</li>')
  })
})

describe('panelKeyAction', () => {
  const key = (k: string, target: Partial<PanelKey['target']> = {}, mods: Partial<PanelKey> = {}): PanelKey => ({ key: k, ...mods, target: { textEntry: false, ownsEsc: false, ...target } })

  it('closes on Esc', () => {
    for (const kind of ['modal', 'drawer', 'view', 'form'] as const) expect(panelKeyAction(kind, key('Escape'), { isForm: false })).toBe('close')
  })

  it('leaves Esc to a field that owns it', () => {
    expect(panelKeyAction('modal', key('Escape', { ownsEsc: true }), { isForm: false })).toBeNull()
  })

  it('does not throw a drawer or view away on Esc from a text box or terminal', () => {
    expect(panelKeyAction('view', key('Escape', { textEntry: true }), { isForm: false })).toBeNull()
    expect(panelKeyAction('drawer', key('Escape', { textEntry: true }), { isForm: false })).toBeNull()
    // A form or modal still closes from its fields, as the small forms always did.
    expect(panelKeyAction('form', key('Escape', { textEntry: true }), { isForm: true })).toBe('close')
    expect(panelKeyAction('modal', key('Escape', { textEntry: true }), { isForm: false })).toBe('close')
  })

  it('does nothing while busy', () => {
    expect(panelKeyAction('modal', key('Escape'), { isForm: true, busy: true })).toBeNull()
    expect(panelKeyAction('form', key('Enter', {}, { ctrlKey: true }), { isForm: true, busy: true })).toBeNull()
  })

  it('submits a form on Ctrl+Enter, from a text box too, and nothing else', () => {
    expect(panelKeyAction('form', key('Enter', { textEntry: true }, { ctrlKey: true }), { isForm: true })).toBe('submit')
    expect(panelKeyAction('form', key('Enter', {}, { ctrlKey: true, shiftKey: true }), { isForm: true })).toBeNull()
    expect(panelKeyAction('drawer', key('Enter', {}, { ctrlKey: true }), { isForm: false })).toBeNull()
    expect(panelKeyAction('form', key('Enter'), { isForm: true })).toBeNull()
  })
})

describe('panelStack', () => {
  it('knows the top panel, so only it answers a key at the window', () => {
    const a = panelStack.push()
    const b = panelStack.push()
    expect(panelStack.isTop(b)).toBe(true)
    expect(panelStack.isTop(a)).toBe(false)
    panelStack.remove(b)
    expect(panelStack.isTop(a)).toBe(true)
    panelStack.remove(a)
  })
})
