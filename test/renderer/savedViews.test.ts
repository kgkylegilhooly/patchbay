import { expect, test } from 'vitest'
import { ACTIONS } from '../../src/renderer/actions'
import { createViewStore, VIEW_SLOTS } from '../../src/renderer/savedViews'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

test('a view is kept per project and slot, and survives a new store over the same storage', () => {
  const storage = memory()
  const views = createViewStore(storage)
  views.set('p1', 3, { x: 10, y: -20, zoom: 0.5 })
  views.set('p2', 3, { x: 1, y: 2, zoom: 2 })
  const again = createViewStore(storage)
  expect(again.get('p1', 3)).toEqual({ x: 10, y: -20, zoom: 0.5 })
  expect(again.get('p2', 3)).toEqual({ x: 1, y: 2, zoom: 2 })
  expect(again.get('p1', 4)).toBeNull()
})

test('damaged or odd storage reads as nothing saved, never as a broken view', () => {
  const storage = memory()
  storage.data.set('patchbay.savedViews', 'not json')
  expect(createViewStore(storage).get('p1', 1)).toBeNull()
  storage.data.set('patchbay.savedViews', JSON.stringify({ p1: { 1: { x: 0, y: 0, zoom: 0 }, 2: { x: 'a', y: 0, zoom: 1 } } }))
  expect(createViewStore(storage).get('p1', 1)).toBeNull()
  expect(createViewStore(storage).get('p1', 2)).toBeNull()
  // Saving over damage starts afresh.
  const views = createViewStore(storage)
  views.set('p1', 1, { x: 5, y: 5, zoom: 1 })
  expect(views.get('p1', 1)).toEqual({ x: 5, y: 5, zoom: 1 })
})

test('Alt+N goes to slot N and Alt+Shift+N keeps it, for 1 to 9, with no key used twice', () => {
  for (const n of VIEW_SLOTS) {
    expect(ACTIONS.find((a) => a.id === `view-go-${n}`)?.key).toBe(`Alt+${n}`)
    expect(ACTIONS.find((a) => a.id === `view-save-${n}`)?.key).toBe(`Alt+Shift+${n}`)
  }
  const keys = ACTIONS.flatMap((a) => (a.key ? [a.key] : []))
  expect(new Set(keys).size).toBe(keys.length)
})
