import { describe, expect, test } from 'vitest'
import { afterMove, isEmptyHeaderPart, onEscape, onHeaderDoubleClick, sameViewport, viewportFor, type ZoomMemory } from '../../src/renderer/headerZoom'

const limits = { margin: 32, minZoom: 0.1, maxZoom: 2 }
const area = { x: 0, y: 0, width: 1000, height: 800 }
const start = { x: 120, y: -40, zoom: 0.72 }

describe('fitting a node to the view', () => {
  test('a node is centered and as large as fits, with the margin around it', () => {
    const v = viewportFor({ x: 100, y: 200, width: 600, height: 400 }, area, limits)
    // Width limits it: (1000 - 64) / 600.
    expect(v.zoom).toBeCloseTo(936 / 600)
    // The node's center lands on the area's center.
    expect(v.x + (100 + 300) * v.zoom).toBeCloseTo(500)
    expect(v.y + (200 + 200) * v.zoom).toBeCloseTo(400)
  })

  test("a whole group fits, and a group too big to fit is held to the canvas's smallest zoom", () => {
    const group = viewportFor({ x: -50, y: 0, width: 1400, height: 1000 }, area, limits)
    expect(group.zoom).toBeCloseTo((1000 - 64) / 1400)
    const huge = viewportFor({ x: 0, y: 0, width: 100000, height: 100000 }, area, limits)
    expect(huge.zoom).toBe(0.1)
    const tiny = viewportFor({ x: 0, y: 0, width: 20, height: 10 }, area, limits)
    expect(tiny.zoom).toBe(2)
  })

  test('the area past the sidebar is what the node is centered in', () => {
    const v = viewportFor({ x: 0, y: 0, width: 200, height: 200 }, { x: 330, y: 0, width: 670, height: 800 }, limits)
    expect(v.x + 100 * v.zoom).toBeCloseTo(330 + 335)
  })
})

describe('the way back', () => {
  const target = { x: -300, y: -500, zoom: 1.5 }

  test('double-click zooms in and remembers the view before; again goes back to exactly it', () => {
    const first = onHeaderDoubleClick(null, 'n1', start, target)
    expect(first.go).toEqual(target)
    expect(first.memory).toEqual({ nodeId: 'n1', previous: start, zoomed: target })
    const second = onHeaderDoubleClick(first.memory, 'n1', target, target)
    expect(second.go).toEqual(start)
    expect(second.memory).toBeNull()
  })

  test('Esc goes back while still zoomed there, and does nothing otherwise', () => {
    const memory: ZoomMemory = { nodeId: 'n1', previous: start, zoomed: target }
    expect(onEscape(memory, { ...target, x: target.x + 0.3 })).toEqual({ go: start })
    expect(onEscape(null, target)).toBeNull()
    expect(onEscape(memory, start)).toBeNull()
  })

  test('a manual pan or zoom forgets the way back; then double-click zooms to the node again', () => {
    const memory: ZoomMemory = { nodeId: 'n1', previous: start, zoomed: target }
    // Where the zoom animation ends keeps it.
    expect(afterMove(memory, target)).toBe(memory)
    const moved = { ...target, x: target.x + 40 }
    expect(afterMove(memory, moved)).toBeNull()
    expect(afterMove(memory, { ...target, zoom: 1.2 })).toBeNull()
    const again = onHeaderDoubleClick(null, 'n1', moved, target)
    expect(again.go).toEqual(target)
    expect(again.memory?.previous).toEqual(moved)
  })

  test('zooming from one node straight to another still goes back to the view from before the first', () => {
    const first = onHeaderDoubleClick(null, 'n1', start, target).memory
    const other = { x: 10, y: 20, zoom: 1.1 }
    const second = onHeaderDoubleClick(first, 'n2', target, other)
    expect(second.go).toEqual(other)
    expect(second.memory).toEqual({ nodeId: 'n2', previous: start, zoomed: other })
  })

  test('views equal give or take rounding count as the same', () => {
    expect(sameViewport({ x: 1, y: 2, zoom: 1 }, { x: 1.4, y: 2.6, zoom: 1.0004 })).toBe(true)
    expect(sameViewport({ x: 1, y: 2, zoom: 1 }, { x: 3, y: 2, zoom: 1 })).toBe(false)
  })
})

describe("the header's empty part", () => {
  /** Just enough of an element for the walk: tag-like classes, a parent, and contains. */
  const el = (classes: string[], parent: FakeEl | null): FakeEl => ({
    classes,
    parentElement: parent,
    matches(selector: string) {
      return selector.split(',').some((s) => {
        const t = s.trim()
        return t.startsWith('.') ? this.classes.includes(t.slice(1)) : this.classes.includes(`<${t}>`)
      })
    },
    contains(other: FakeEl | null) {
      for (let e = other; e; e = e.parentElement) if (e === this) return true
      return false
    }
  })
  interface FakeEl { classes: string[]; parentElement: FakeEl | null; matches(s: string): boolean; contains(o: FakeEl | null): boolean }
  const header = el(['unit-head'], null)
  const cwd = el(['cwd'], header)
  const title = el(['title'], header)
  const button = el(['<button>', 'btn'], header)
  const icon = el(['icon'], button)
  const elsewhere = el(['unit-body'], null)
  const empty = (t: FakeEl | null) => isEmptyHeaderPart(t as unknown as Element, header as unknown as Element)

  test('the bar itself and plain text in it zoom', () => {
    expect(empty(header)).toBe(true)
    expect(empty(cwd)).toBe(true)
  })

  test('the title (rename), buttons and what is inside them keep their own double-click', () => {
    expect(empty(title)).toBe(false)
    expect(empty(button)).toBe(false)
    expect(empty(icon)).toBe(false)
  })

  test('outside the header, such as the body, never counts', () => {
    expect(empty(elsewhere)).toBe(false)
    expect(empty(null)).toBe(false)
  })
})
