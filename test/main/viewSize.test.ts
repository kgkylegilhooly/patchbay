import { afterEach, expect, test } from 'vitest'
import { reportViewArea, reportViewSize, viewSize } from '../../src/main/viewSize'

afterEach(() => reportViewSize(() => null))

test("the window's size stands in until the page reports its visible area, which then wins", () => {
  reportViewSize(() => ({ width: 1400, height: 900 }))
  expect(viewSize()).toEqual({ width: 1400, height: 900 })
  reportViewArea({ x: 330, y: 24, width: 1046, height: 792 })
  expect(viewSize()).toEqual({ x: 330, y: 24, width: 1046, height: 792 })
})

test('a report that is not a usable area is ignored', () => {
  reportViewArea({ x: 1, y: 2, width: 300, height: 200 })
  for (const bad of [null, 'x', { x: 1, y: 2, width: 0, height: 5 }, { x: 'a', y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: Infinity, height: 4 }]) reportViewArea(bad)
  expect(viewSize()).toEqual({ x: 1, y: 2, width: 300, height: 200 })
})
