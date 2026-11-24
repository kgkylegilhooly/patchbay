import { expect, test } from 'vitest'
import { copyLabel, restoreCanvasSubmenu } from '../../src/renderer/canvasHistoryUi'

test('a copy reads as its day, windows and projects; with no copies yet there is no menu row', () => {
  expect(copyLabel({ name: 'canvas-2026-11-23.json', day: '2026-11-23', savedAt: 0, windows: 1, projects: 3 })).toMatch(/23.*· 1 window, 3 projects$/)
  expect(restoreCanvasSubmenu()).toEqual([])
})
