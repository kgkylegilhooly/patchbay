import { expect, test, vi } from 'vitest'
import { projectMenu, type Commands, type MenuItem } from '../../src/renderer/menus'
import { openProjectDoc, projectDocEntries, projectDocPath, type ProjectDocDeps } from '../../src/renderer/projectDocs'

// F74: a project's CLAUDE.md and AGENTS.md, from its tab, in a Reader.
const project = { id: 'p', name: 'Patchbay', folder: 'C:\\Code\\patchbay' }

test("the file sits in the project's folder, whichever slash the folder ends in", () => {
  expect(projectDocPath('C:\\Code\\patchbay', 'CLAUDE.md')).toBe('C:\\Code\\patchbay\\CLAUDE.md')
  expect(projectDocPath('C:/Code/patchbay/', 'AGENTS.md')).toBe('C:/Code/patchbay\\AGENTS.md')
  expect(projectDocPath('D:\\', 'CLAUDE.md')).toBe('D:\\CLAUDE.md')
})

const deps = (over: Partial<ProjectDocDeps> = {}): ProjectDocDeps & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    activeProjectId: 'p',
    switchProject: vi.fn(async (id: string) => void calls.push(`switch ${id}`)),
    open: vi.fn(async (path: string) => (calls.push(`open ${path}`), { ok: true as const })),
    say: vi.fn(),
    ...over
  }
}

test('opens it in a Reader, showing the project first when another one is on screen', async () => {
  const d = deps({ activeProjectId: 'other' })
  await openProjectDoc(project, 'CLAUDE.md', d)
  expect(d.calls).toEqual(['switch p', 'open C:\\Code\\patchbay\\CLAUDE.md'])
  expect(d.say).toHaveBeenCalledWith(null)
  const here = deps()
  await openProjectDoc(project, 'AGENTS.md', here)
  expect(here.calls).toEqual(['open C:\\Code\\patchbay\\AGENTS.md'])
})

test("a missing file is named plainly, not as one that's gone; other refusals pass through", async () => {
  const d = deps({ open: async () => ({ ok: false, reason: 'The file is gone: C:\\Code\\patchbay\\CLAUDE.md', missing: true }) })
  await openProjectDoc(project, 'CLAUDE.md', d)
  expect(d.say).toHaveBeenCalledWith("There's no CLAUDE.md in C:\\Code\\patchbay.")
  const e = deps({ open: async () => ({ ok: false, reason: "The file can't be read: EACCES" }) })
  await openProjectDoc(project, 'CLAUDE.md', e)
  expect(e.say).toHaveBeenCalledWith("The file can't be read: EACCES")
})

test('a project without a folder offers neither, and says why if asked', async () => {
  expect(projectDocEntries({ folder: '' }, vi.fn())).toEqual([])
  const d = deps()
  await openProjectDoc({ ...project, folder: '' }, 'CLAUDE.md', d)
  expect(d.open).not.toHaveBeenCalled()
  expect(d.say).toHaveBeenCalledWith(expect.stringContaining('has no folder of its own'))
})

test("the project tab's menu has Open CLAUDE.md and Open AGENTS.md, for a project with a folder", () => {
  const openProjectDocCmd = vi.fn()
  const c = new Proxy({} as Commands, { get: (_t, key) => (key === 'openProjectDoc' ? openProjectDocCmd : () => {}) })
  const ctx = { sessionTitles: [], items: 0, canClose: true, last: false, rename: () => {}, folder: project.folder }
  const items = projectMenu(c, 'p', ctx).filter((e): e is MenuItem => e !== 'separator')
  const claude = items.find((i) => i.id === 'open-claude-md')
  expect(claude?.label).toBe('Open CLAUDE.md')
  expect(items.find((i) => i.id === 'open-agents-md')?.label).toBe('Open AGENTS.md')
  claude!.run()
  expect(openProjectDocCmd).toHaveBeenCalledWith('p', 'CLAUDE.md')
  expect(projectMenu(c, 'p', { ...ctx, folder: '' }).some((e) => e !== 'separator' && e.id === 'open-claude-md')).toBe(false)
})
