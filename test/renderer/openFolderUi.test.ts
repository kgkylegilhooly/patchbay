import { expect, test } from 'vitest'
import { openFolderEntries } from '../../src/renderer/openFolderUi'

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }

test('a window with a folder offers Explorer, and VS Code only when found; an SSH terminal or a note offers neither', () => {
  const term = { ...box, id: 't', kind: 'terminal', title: 'T', cwd: 'C:\w' } as never
  expect(openFolderEntries(term, true).map((i) => i.id)).toEqual(['open-folder-explorer', 'open-folder-vscode'])
  expect(openFolderEntries(term, false).map((i) => i.id)).toEqual(['open-folder-explorer'])
  // An SSH terminal's folder is on the other machine.
  expect(openFolderEntries({ ...box, id: 's', kind: 'terminal', title: 'S', cwd: 'C:\w', sshHost: 'box' } as never, true)).toEqual([])
  expect(openFolderEntries({ ...box, id: 'n', kind: 'sticky', title: 'N', text: '' } as never, true)).toEqual([])
})
