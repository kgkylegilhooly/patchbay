import { describe, expect, it } from 'vitest'
import { popoverPlace } from '../../src/renderer/popoverPlace'

const win = { width: 1280, height: 800 }
const size = { width: 460, height: 700 }

describe('the Files edited popover', () => {
  it('opens under its chip and stops above the dock and minimap', () => {
    const p = popoverPlace({ x: 732, y: 126 }, size, win, 633)
    expect(p).toEqual({ x: 732, y: 126, maxHeight: 633 - 126 })
  })

  it('stays inside the window on the right', () => {
    expect(popoverPlace({ x: 1100, y: 100 }, size, win, 633).x).toBe(1280 - 460 - 8)
  })

  it('moves up when there is little room under the chip', () => {
    const p = popoverPlace({ x: 100, y: 520 }, { width: 460, height: 400 }, win, 633)
    expect(p.y).toBe(633 - 400)
    expect(p.y + p.maxHeight).toBe(633)
  })

  it('never starts above the window, however tall it is', () => {
    const p = popoverPlace({ x: 100, y: 520 }, { width: 460, height: 2000 }, win, 633)
    expect(p.y).toBe(8)
    expect(p.maxHeight).toBe(625)
  })

  it('uses the window edge when the chrome is above the chip, or unknown', () => {
    expect(popoverPlace({ x: 100, y: 100 }, size, win, null).maxHeight).toBe(800 - 8 - 100)
    expect(popoverPlace({ x: 100, y: 660 }, { width: 460, height: 100 }, win, 633)).toEqual({ x: 100, y: 660, maxHeight: 800 - 8 - 660 })
  })
})
