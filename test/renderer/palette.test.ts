import { describe, expect, test } from 'vitest'
import { fuzzyScore, noteRecent, rankPalette } from '../../src/renderer/palette'
import { nearestInDirection } from '../../src/renderer/nodeNav'
import { teamLeadPrompt } from '../../src/renderer/teamPrompt'
import { clampFontSize, FONT_SIZE, steppedFontSize, windowFontSize } from '../../src/renderer/prefs'

const items = [
  { id: 'new-terminal', label: 'New terminal', keywords: ['shell'] },
  { id: 'new-claude', label: 'New Claude Code…', keywords: ['agent'] },
  { id: 'fit-view', label: 'Fit view' },
  { id: 'session:1', label: 'Parser tests', detail: 'Website' }
]

describe('fuzzy matching', () => {
  test('letters must appear in order', () => {
    expect(fuzzyScore('nt', 'New terminal')).not.toBeNull()
    expect(fuzzyScore('tn', 'Fit')).toBeNull()
    expect(fuzzyScore('xyz', 'New terminal')).toBeNull()
  })

  test('an empty query matches anything', () => {
    expect(fuzzyScore('  ', 'whatever')).toBe(0)
  })

  test('the starts of words and runs of letters score higher', () => {
    expect(fuzzyScore('nt', 'New terminal')!).toBeGreaterThan(fuzzyScore('nt', 'Mint')!)
    expect(fuzzyScore('term', 'New terminal')!).toBeGreaterThan(fuzzyScore('term', 'tea room')!)
  })

  test('case does not matter', () => {
    expect(fuzzyScore('FIT', 'fit view')).toBe(fuzzyScore('fit', 'FIT VIEW'))
  })
})

describe('palette ranking', () => {
  const ids = (query: string, recent: string[] = []) => rankPalette(query, items, recent).map((i) => i.id)

  test('with no query, recent actions come first, most recent first', () => {
    expect(ids('', ['fit-view', 'new-claude'])).toEqual(['fit-view', 'new-claude', 'new-terminal', 'session:1'])
  })

  test('a query leaves only matches', () => {
    expect(ids('fit')).toEqual(['fit-view'])
    expect(ids('zzz')).toEqual([])
  })

  test('keywords and details are searched', () => {
    expect(ids('shell')).toEqual(['new-terminal'])
    expect(ids('website')).toEqual(['session:1'])
  })

  test('a folder path or project matches only on unbroken letters, not letters scattered through it', () => {
    const session = [{ id: 's', label: 'Docs', detail: 'Website', keywords: ['C:\\Users\\me\\code\\patchbay'] }]
    expect(rankPalette('fit', session, []).map((i) => i.id)).toEqual([])
    expect(rankPalette('wbe', session, []).map((i) => i.id)).toEqual([])
    expect(rankPalette('patch', session, []).map((i) => i.id)).toEqual(['s'])
    expect(rankPalette('web', session, []).map((i) => i.id)).toEqual(['s'])
  })

  test('recent breaks a tie', () => {
    expect(ids('new', ['new-claude'])[0]).toBe('new-claude')
    expect(ids('new', ['new-terminal'])[0]).toBe('new-terminal')
  })

  test('noting one moves it to the front, and the list stays short', () => {
    expect(noteRecent(['a', 'b'], 'b')).toEqual(['b', 'a'])
    const long = Array.from({ length: 8 }, (_, i) => `x${i}`)
    expect(noteRecent(long, 'new')).toHaveLength(8)
    expect(noteRecent(long, 'new')[0]).toBe('new')
  })
})

describe('moving between windows', () => {
  const rect = (id: string, x: number, y: number) => ({ id, x, y, width: 100, height: 100 })
  const rects = [rect('a', 0, 0), rect('b', 200, 0), rect('c', 0, 200), rect('d', 400, 300)]

  test('goes to the nearest window that way', () => {
    expect(nearestInDirection(rects, 'a', 'right')).toBe('b')
    expect(nearestInDirection(rects, 'a', 'down')).toBe('c')
    expect(nearestInDirection(rects, 'b', 'left')).toBe('a')
    expect(nearestInDirection(rects, 'c', 'up')).toBe('a')
  })

  test('prefers the window in line over one nearer but off to the side', () => {
    const line = [rect('from', 0, 0), rect('beside', 300, 10), rect('diagonal', 150, 150)]
    expect(nearestInDirection(line, 'from', 'right')).toBe('beside')
  })

  test('is null at the edge', () => {
    expect(nearestInDirection(rects, 'a', 'left')).toBeNull()
    expect(nearestInDirection(rects, 'a', 'up')).toBeNull()
  })

  test('with nothing focused it starts at the first window', () => {
    expect(nearestInDirection(rects, null, 'right')).toBe('a')
    expect(nearestInDirection([], null, 'right')).toBeNull()
  })
})

describe('the team lead prompt', () => {
  const prompt = teamLeadPrompt('  Add dark mode  ')

  test('holds the task', () => {
    expect(prompt).toContain('Add dark mode')
  })

  test('names the commands and asks for dependencies and reconciling', () => {
    expect(prompt).toContain('patchbay spawn-team')
    expect(prompt).toContain('patchbay open-agent')
    expect(prompt).toContain('--after')
    expect(prompt).toMatch(/reconcile/i)
  })

  test('fits the limit on prompts', () => {
    expect(teamLeadPrompt('x'.repeat(100)).length).toBeLessThan(28000)
  })
})

describe('per-window font size', () => {
  test('a window with no size of its own follows the global setting', () => {
    expect(windowFontSize(undefined, 15)).toBe(15)
    expect(windowFontSize('big', 15)).toBe(15)
    expect(windowFontSize(Number.NaN, 15)).toBe(15)
  })

  test("a window's own size wins, clamped to the same range as the setting", () => {
    expect(windowFontSize(11, 15)).toBe(11)
    expect(windowFontSize(99, 15)).toBe(FONT_SIZE.max)
    expect(windowFontSize(1, 15)).toBe(FONT_SIZE.min)
    expect(clampFontSize(FONT_SIZE.max)).toBe(FONT_SIZE.max)
  })

  test('a step goes from what it draws at now, and stops at the ends', () => {
    expect(steppedFontSize(undefined, 15, 1)).toBe(16)
    expect(steppedFontSize(12, 15, -1)).toBe(11)
    expect(steppedFontSize(FONT_SIZE.max, 15, 1)).toBe(FONT_SIZE.max)
    expect(steppedFontSize(FONT_SIZE.min, 15, -1)).toBe(FONT_SIZE.min)
  })
})
