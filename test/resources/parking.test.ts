import { describe, expect, test } from 'vitest'
import { nearScreen, PARKING, planParking, type Box } from '../../src/renderer/terminalParking'

const screen = { width: 1000, height: 800 }
const at = (left: number, top: number): Box => ({ left, top, right: left + 400, bottom: top + 300 })
const ON = at(100, 100)
/** Within a screen of the edge: kept, so a pan never meets an empty window. */
const NEAR = at(1800, 100)
const FAR = at(3000, 100)

describe('unloading windows far off-screen', () => {
  test('near means within one screen of the edge, any side', () => {
    expect(nearScreen(ON, screen)).toBe(true)
    expect(nearScreen(NEAR, screen)).toBe(true)
    expect(nearScreen(at(-1300, 0), screen)).toBe(true)
    expect(nearScreen(FAR, screen)).toBe(false)
    expect(nearScreen(at(0, 1700), screen)).toBe(false)
  })

  test('a far window is unloaded only once it has been far for the whole wait', () => {
    const boxes = new Map([['on', ON], ['near', NEAR], ['far', FAR]])
    let plan = planParking({ boxes, screen, keep: new Set(), lastNear: new Map(), now: 0 })
    expect([...plan.parked]).toEqual([])
    plan = planParking({ boxes, screen, keep: new Set(), lastNear: plan.lastNear, now: PARKING.afterMs - 1 })
    expect([...plan.parked]).toEqual([])
    plan = planParking({ boxes, screen, keep: new Set(), lastNear: plan.lastNear, now: PARKING.afterMs })
    expect([...plan.parked]).toEqual(['far'])
  })

  test('coming near loads it again at once, and its wait starts over', () => {
    const far = planParking({ boxes: new Map([['w', FAR]]), screen, keep: new Set(), lastNear: new Map([['w', 0]]), now: PARKING.afterMs })
    expect(far.parked.has('w')).toBe(true)
    const back = planParking({ boxes: new Map([['w', NEAR]]), screen, keep: new Set(), lastNear: far.lastNear, now: PARKING.afterMs + 1 })
    expect(back.parked.size).toBe(0)
    const away = planParking({ boxes: new Map([['w', FAR]]), screen, keep: new Set(), lastNear: back.lastNear, now: PARKING.afterMs + 2 })
    expect(away.parked.size).toBe(0)
  })

  test("the window being typed in, and one that can't be found, stay loaded", () => {
    const plan = planParking({ boxes: new Map<string, Box | null>([['typing', FAR], ['lost', null]]), screen, keep: new Set(['typing']), lastNear: new Map([['typing', 0], ['lost', 0]]), now: 10 * PARKING.afterMs })
    expect(plan.parked.size).toBe(0)
  })

  test('short of memory, far windows go at once and stay gone until they come near', () => {
    const boxes = new Map([['on', ON], ['far', FAR]])
    const urgent = planParking({ boxes, screen, keep: new Set(), lastNear: new Map(), now: 5, urgent: true })
    expect([...urgent.parked]).toEqual(['far'])
    const next = planParking({ boxes, screen, keep: new Set(), lastNear: urgent.lastNear, now: 6 })
    expect([...next.parked]).toEqual(['far'])
  })

  test('windows that went away drop out of the record', () => {
    const plan = planParking({ boxes: new Map([['a', ON]]), screen, keep: new Set(), lastNear: new Map([['gone', 0]]), now: 1 })
    expect([...plan.lastNear.keys()]).toEqual(['a'])
  })
})
