import { describe, expect, test } from 'vitest'
import { upcomingText } from '../../src/renderer/upcomingText'

const at = (day: number, hour: number, minute: number, second = 0): number => new Date(2026, 10, day, hour, minute, second).getTime()
const now = at(20, 13, 45)

describe('upcomingText', () => {
  test('times today read as clock times, with the day said once', () => {
    expect(upcomingText([at(20, 13, 49), at(20, 13, 54), at(20, 13, 59)], now, 'en-US')).toBe('1:49 PM, 1:54 PM, 1:59 PM today')
  })

  test('a run across midnight names each day', () => {
    expect(upcomingText([at(20, 23, 30), at(21, 0, 0), at(21, 0, 30)], now, 'en-US')).toBe('11:30 PM today; 12:00 AM, 12:30 AM tomorrow')
  })

  test('later days get a short date', () => {
    const text = upcomingText([at(23, 9, 0)], now, 'en-US')
    expect(text).toMatch(/^9:00 AM \S+/)
    expect(text).not.toMatch(/today|tomorrow/)
  })

  test('seconds show only when two times share a minute', () => {
    expect(upcomingText([at(20, 13, 46, 0), at(20, 13, 46, 20), at(20, 13, 46, 40)], now, 'en-US')).toBe('1:46:00 PM, 1:46:20 PM, 1:46:40 PM today')
  })

  test('nothing coming says nothing', () => {
    expect(upcomingText([], now)).toBe('')
  })
})
