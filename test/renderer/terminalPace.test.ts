import { expect, test, vi } from 'vitest'
import { canvasTier, onCanvasTier, PACE_MS, paceFor, setCanvasTier } from '../../src/renderer/terminalPace'

test('the terminal being typed in draws at once, whatever the zoom', () => {
  for (const tier of ['near', 'far', 'overview'] as const) expect(paceFor({ focused: true, hovered: false, tier })).toBe(0)
  expect(paceFor({ focused: true, hovered: false, tier: 'near', offstage: true })).toBe(0)
})

test('near enough to read, or under the pointer, it draws ten times a second', () => {
  expect(paceFor({ focused: false, hovered: false, tier: 'near' })).toBe(PACE_MS.near)
  expect(paceFor({ focused: false, hovered: true, tier: 'far' })).toBe(PACE_MS.near)
  expect(PACE_MS.near).toBe(100)
})

test('zoomed out to a tile it draws less often, and not readable at all once a second', () => {
  expect(paceFor({ focused: false, hovered: false, tier: 'far' })).toBe(PACE_MS.far)
  expect(paceFor({ focused: false, hovered: true, tier: 'overview' })).toBe(PACE_MS.hidden)
  expect(paceFor({ focused: false, hovered: false, tier: 'near', offstage: true })).toBe(PACE_MS.hidden)
  expect(PACE_MS.far).toBeGreaterThan(PACE_MS.near)
  expect(PACE_MS.hidden).toBeGreaterThan(PACE_MS.far)
})

test('a tier change tells the terminals once, and the same tier again says nothing', () => {
  const cb = vi.fn()
  const off = onCanvasTier(cb)
  setCanvasTier('far')
  setCanvasTier('far')
  expect(canvasTier()).toBe('far')
  expect(cb).toHaveBeenCalledTimes(1)
  off()
  setCanvasTier('near')
  expect(cb).toHaveBeenCalledTimes(1)
})
