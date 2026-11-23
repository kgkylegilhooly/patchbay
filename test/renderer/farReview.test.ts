import { describe, expect, it } from 'vitest'
import { askReview, REVIEW_ZOOM, reviewShown, reviewViewport, useFarReview } from '../../src/renderer/farReview'

const area = { x: 322, y: 0, width: 940, height: 640 }
const onScreen = (v: { x: number; y: number; zoom: number }, p: { x: number; y: number }) => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y })

describe('reviewing a prompt from a far tile', () => {
  it('centres a window that fits, at full size at most', () => {
    const node = { x: 2000, y: 1500, width: 620, height: 420 }
    const v = reviewViewport(node, area)
    expect(v.zoom).toBe(REVIEW_ZOOM.max)
    const tl = onScreen(v, node)
    expect(tl.x).toBeCloseTo(area.x + (area.width - 620) / 2)
    expect(tl.y).toBeCloseTo(area.y + (area.height - 420) / 2)
  })

  it('never zooms out below a readable size, and keeps the header and strip in view on a big window', () => {
    const node = { x: -400, y: 300, width: 1600, height: 1200 }
    const v = reviewViewport(node, area)
    expect(v.zoom).toBe(REVIEW_ZOOM.min)
    const tl = onScreen(v, node)
    expect(tl.x).toBeCloseTo(area.x + 32)
    expect(tl.y).toBeCloseTo(area.y + 32)
  })

  it('remembers which request to open on its whole command, until it has been shown', () => {
    askReview('r1')
    expect(useFarReview.getState().requestId).toBe('r1')
    reviewShown()
    expect(useFarReview.getState().requestId).toBeNull()
  })
})
