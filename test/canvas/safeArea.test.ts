import { describe, expect, test } from 'vitest'
import { dockLayout, fitPadding, SAFE_GAP, SAFE_MARGIN, safeInsets, safeRect } from '../../src/core/canvas/safeArea'
import { placeNear, type Rect } from '../../src/core/canvas/place'
import type { CanvasDoc } from '../../src/shared/model'

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height

/** The chrome as the app draws it on a stage of this size: sidebar at the left, dock bottom centre, minimap bottom right. */
function chrome(width: number, height: number, o: { sidebar?: boolean; legend?: boolean; dockLeft?: number } = {}): Rect[] {
  const out: Rect[] = []
  if (o.sidebar !== false) out.push({ x: 14, y: 14, width: 300, height: height - 28 })
  out.push({ x: o.dockLeft ?? (width - 560) / 2, y: height - 16 - 46, width: 560, height: 46 })
  out.push({ x: width - 15 - 200, y: height - 15 - 150, width: 200, height: 150 })
  if (o.legend) out.push({ x: width - 14 - 520, y: 26, width: 520, height: 26 })
  return out
}

describe('safeRect', () => {
  test('with no chrome it is the stage less the margin', () => {
    expect(safeRect({ width: 1000, height: 600 }, [])).toEqual({ x: SAFE_MARGIN, y: SAFE_MARGIN, width: 1000 - 2 * SAFE_MARGIN, height: 600 - 2 * SAFE_MARGIN })
  })

  test('the sidebar comes off the left, the dock off the bottom', () => {
    const r = safeRect({ width: 1280, height: 760 }, [
      { x: 14, y: 14, width: 300, height: 732 },
      { x: 500, y: 698, width: 560, height: 46 }
    ])!
    expect(r.x).toBe(314 + SAFE_GAP)
    expect(r.y).toBe(SAFE_MARGIN)
    expect(r.y + r.height).toBe(698 - SAFE_GAP)
    expect(r.x + r.width).toBe(1280 - SAFE_MARGIN)
  })

  test('the minimap and the legend are kept clear of, not only the sidebar and dock', () => {
    for (const [w, h] of [[1280, 760], [1024, 660], [1680, 960]]) {
      const covers = chrome(w, h, { legend: true })
      const r = safeRect({ width: w, height: h }, covers)!
      expect(r.width).toBeGreaterThan(300)
      for (const c of covers) expect(overlaps(r, c), `${w}x${h} clear of ${JSON.stringify(c)}`).toBe(false)
    }
  })

  test('a corner box is cut off the side that loses least', () => {
    // Wide: a column off the right costs less than a strip off the bottom.
    const wide = safeRect({ width: 1600, height: 600 }, [{ x: 1385, y: 435, width: 200, height: 150 }])!
    expect(wide.x + wide.width).toBe(1385 - SAFE_GAP)
    expect(wide.y + wide.height).toBe(600 - SAFE_MARGIN)
    // Tall and narrow: a strip off the bottom.
    const tall = safeRect({ width: 700, height: 1400 }, [{ x: 485, y: 1235, width: 200, height: 150 }])!
    expect(tall.x + tall.width).toBe(700 - SAFE_MARGIN)
    expect(tall.y + tall.height).toBe(1235 - SAFE_GAP)
  })

  test('with the sidebar closed, the dock and minimap come off the bottom together rather than costing a column too', () => {
    const r = safeRect({ width: 1280, height: 760 }, chrome(1280, 760, { sidebar: false }))!
    expect(r.x + r.width).toBe(1280 - SAFE_MARGIN)
    expect(r.y + r.height).toBe(760 - 15 - 150 - SAFE_GAP)
  })

  test('a panel on the right comes off the right', () => {
    const r = safeRect({ width: 1280, height: 760 }, [{ x: 826, y: 14, width: 440, height: 732 }])!
    expect(r.x + r.width).toBe(826 - SAFE_GAP)
  })

  test('a view filling the canvas is left out rather than emptying the area', () => {
    const r = safeRect({ width: 1280, height: 760 }, [{ x: 0, y: 0, width: 1280, height: 760 }, { x: 14, y: 14, width: 300, height: 732 }])!
    expect(r.x).toBe(314 + SAFE_GAP)
    expect(r.width).toBeGreaterThan(800)
  })

  test('null for a stage too small to use', () => {
    expect(safeRect({ width: 90, height: 600 }, [])).toBeNull()
  })
})

describe('placement in the safe area', () => {
  const doc = { nodes: [], activeProjectId: 'p1' } as unknown as CanvasDoc
  test('a new node in the middle of the view lands clear of every piece of chrome, at 1024x700 too', () => {
    for (const [w, h] of [[1280, 760], [1024, 660]]) {
      const covers = chrome(w, h, { legend: true })
      // At zoom 1 with the viewport at 0,0, canvas and screen coordinates are the same.
      const view = safeRect({ width: w, height: h }, covers)!
      for (const size of [{ width: 280, height: 220 }, { width: 380, height: 300 }]) {
        const at = { x: view.x + (view.width - size.width) / 2, y: view.y + (view.height - size.height) / 2 }
        const spot = { ...placeNear(doc, { at, size, projectId: 'p1', view }), ...size }
        expect(inside(spot, view)).toBe(true)
        for (const c of covers) expect(overlaps(spot, c)).toBe(false)
      }
    }
  })
})

describe('fitPadding', () => {
  test('pads each side by how far in the safe area sits, plus air', () => {
    const stage = { width: 1280, height: 760 }
    const safe = { x: 326, y: 16, width: 938, height: 560 }
    expect(safeInsets(stage, safe)).toEqual({ top: 16, left: 326, right: 16, bottom: 184 })
    expect(fitPadding(stage, safe, 8)).toEqual({ top: '24px', left: '334px', right: '24px', bottom: '192px' })
  })

  test('falls back to the margin when the area is unknown', () => {
    expect(fitPadding({ width: 0, height: 0 }, null)).toEqual({ top: '16px', left: '16px', right: '16px', bottom: '16px' })
  })
})

describe('dockLayout', () => {
  const mapLeft = (w: number): number => w - SAFE_MARGIN - 200

  test('at 1280 with the sidebar open the dock and the minimap share the row, apart', () => {
    const d = dockLayout({ stageWidth: 1280, left: 314, right: 1280, dockWidth: 560, mapWidth: 200 })
    expect(d.foldMap).toBe(false)
    expect(d.left).toBeGreaterThanOrEqual(314 + SAFE_GAP)
    expect(d.left + 560).toBeLessThanOrEqual(mapLeft(1280) - SAFE_GAP)
  })

  test('at 1024 with the sidebar open the minimap folds into the dock, which never covers it', () => {
    const d = dockLayout({ stageWidth: 1024, left: 314, right: 1024, dockWidth: 560, mapWidth: 200, mapButton: 34 })
    expect(d.foldMap).toBe(true)
    expect(d.left).toBeGreaterThanOrEqual(314 + SAFE_GAP)
    expect(d.left + 560 + 34).toBeLessThanOrEqual(1024 - SAFE_GAP)
  })

  test('at 1024 with the sidebar closed there is room for both', () => {
    const d = dockLayout({ stageWidth: 1024, left: 0, right: 1024, dockWidth: 560, mapWidth: 200 })
    expect(d.foldMap).toBe(false)
    expect(d.left + 560).toBeLessThanOrEqual(mapLeft(1024) - SAFE_GAP)
  })

  test('centred on the visible canvas when there is room', () => {
    const d = dockLayout({ stageWidth: 1680, left: 314, right: 1680, dockWidth: 560, mapWidth: 200 })
    expect(d.left).toBe(Math.round((314 + SAFE_GAP + 1680 - SAFE_GAP) / 2 - 280))
  })

  test('with no minimap nothing folds', () => {
    expect(dockLayout({ stageWidth: 900, left: 314, right: 900, dockWidth: 560, mapWidth: null }).foldMap).toBe(false)
  })

  test('a panel on the right takes the minimap corner: the dock centres left of the panel and stays off the sidebar', () => {
    const roomy = dockLayout({ stageWidth: 1680, left: 314, right: 1226, dockWidth: 560, mapWidth: 200 })
    expect(roomy.foldMap).toBe(false)
    expect(roomy.left + 560).toBeLessThanOrEqual(1226 - SAFE_GAP)
    const tight = dockLayout({ stageWidth: 1280, left: 314, right: 826, dockWidth: 560, mapWidth: 200 })
    expect(tight.left).toBe(314 + SAFE_GAP)
  })
})
