import { expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { migrate } from '../../src/core/persist/docStore'
import { promptName, sanitizePrompts, withoutPrompt, withPrompt } from '../../src/shared/savedPrompts'
import type { CanvasDoc } from '../../src/shared/model'

// F70: the asks a project uses again and again are saved with the project, so they outlast Recent's 20.
test('a saved prompt is named from its first line, the same text twice is kept once at the top, and one can go', () => {
  let list = withPrompt(undefined, '\n  Review this branch against main.\nList anything risky.', 'a', 1)
  expect(list).toEqual([{ id: 'a', name: 'Review this branch against main.', text: 'Review this branch against main.\nList anything risky.', at: 1 }])
  list = withPrompt(list, 'Write the release note', 'b', 2)
  list = withPrompt(list, 'Review this branch against main.\nList anything risky.', 'c', 3)
  expect(list.map((p) => p.id)).toEqual(['c', 'b'])
  expect(withPrompt(list, '   ', 'd', 4)).toBe(list)
  expect(withoutPrompt(list, 'b').map((p) => p.id)).toEqual(['c'])
  expect(promptName('x '.repeat(50))).toMatch(/…$/)
})

test('damaged saved prompts are dropped on their own, and none at all is no list', () => {
  expect(sanitizePrompts([{ id: 'a', name: 'A', text: 'do a', at: 1 }, { id: '', name: 'B', text: 'b', at: 1 }, { id: 'c', name: 'C', text: '  ', at: 1 }, 'x'])).toEqual([{ id: 'a', name: 'A', text: 'do a', at: 1 }])
  expect(sanitizePrompts('nope')).toBeUndefined()
  expect(sanitizePrompts([])).toBeUndefined()
})

const doc = (): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes: [],
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

test("a project's saved prompts are set by their own op, checked on the way in, and survive a save and load", () => {
  const saved = withPrompt(undefined, 'Write the release note', 'a', 1)
  const next = reduce(doc(), { op: 'setProjectPrompts', id: 'p', prompts: [...saved, { id: 'bad' } as never] })
  expect(next.projects[0].prompts).toEqual(saved)
  expect(migrate(JSON.parse(JSON.stringify(next))).projects[0].prompts).toEqual(saved)
  expect(reduce(next, { op: 'setProjectPrompts', id: 'p', prompts: [] }).projects[0].prompts).toBeUndefined()
  expect(reduce(next, { op: 'setProjectPrompts', id: 'nope', prompts: saved })).toBe(next)
  // A damaged list on disk costs only itself.
  const damaged = { ...JSON.parse(JSON.stringify(next)), projects: [{ ...next.projects[0], prompts: 'broken' }] }
  expect(migrate(damaged).projects[0].prompts).toBeUndefined()
})

test("the Prompts menu: this project's saved first, other projects' in a submenu, recent after; save and forget", async () => {
  const { PromptsEntries } = await import('../../src/renderer/promptsMenu')
  const picked: string[] = []
  const saved: string[] = []
  const forgot: string[] = []
  const mine = withPrompt(undefined, 'Review this branch against main', 'r', 1)
  const entries = PromptsEntries({
    saved: mine,
    others: [{ project: 'Website', prompt: { id: 'w', name: 'Check the links', text: 'Check the links', at: 1 } }],
    recent: ['Review this branch against main', 'Run the tests and fix what fails'],
    text: 'Write the release note',
    onPick: (t) => void picked.push(t),
    save: (t) => void saved.push(t),
    forget: (id) => void forgot.push(id)
  })
  const items = entries.filter((e) => e !== 'separator') as Array<{ id: string; label: string; disabled?: boolean; run: () => void; submenu?: Array<{ id: string; label: string; run: () => void }> }>
  expect(items.map((i) => i.label)).toEqual(['Review this branch against main', 'From other projects', 'Run the tests and fix what fails', 'Save this prompt', 'Forget a saved prompt'])
  items[0].run()
  items[1].submenu![0].run()
  expect(items[1].submenu![0].label).toBe('Check the links · Website')
  items.find((i) => i.id === 'save-prompt')!.run()
  items.find((i) => i.id === 'forget-prompt')!.submenu![0].run()
  expect(picked).toEqual(['Review this branch against main', 'Check the links'])
  expect(saved).toEqual(['Write the release note'])
  expect(forgot).toEqual(['r'])
  // Text already saved, or none, can't be saved again.
  const again = PromptsEntries({ saved: mine, others: [], recent: [], text: 'Review this branch against main', onPick: () => {}, save: () => {}, forget: () => {} })
  expect(again.find((e) => e !== 'separator' && e.id === 'save-prompt')).toMatchObject({ label: 'Saved in this project', disabled: true })
})
