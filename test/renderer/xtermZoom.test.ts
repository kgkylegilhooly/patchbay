import { expect, test } from 'vitest'
import { routeEvent } from '../../src/renderer/xtermZoom'

test('a press on a terminal starts a drag there', () => {
  expect(routeEvent('mousedown', 'A', null)).toEqual({ host: 'A', dragging: 'A' })
  expect(routeEvent('mousedown', null, 'A')).toEqual({ host: null, dragging: null })
})

test('a drag stays with the terminal it started in, even over another, until the button comes up', () => {
  expect(routeEvent('mousemove', 'B', 'A')).toEqual({ host: 'A', dragging: 'A' })
  expect(routeEvent('mousemove', null, 'A')).toEqual({ host: 'A', dragging: 'A' })
  expect(routeEvent('mouseup', 'B', 'A')).toEqual({ host: 'A', dragging: null })
})

test('with no drag, an event belongs to the terminal under it, or none', () => {
  expect(routeEvent('mousemove', 'B', null)).toEqual({ host: 'B', dragging: null })
  expect(routeEvent('click', null, null)).toEqual({ host: null, dragging: null })
  expect(routeEvent('contextmenu', 'A', null)).toEqual({ host: 'A', dragging: null })
})
