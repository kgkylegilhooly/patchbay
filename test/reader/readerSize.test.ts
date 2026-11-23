import { describe, expect, it } from 'vitest'
import { FOLD_COMMENTS_BELOW, READER_DEFAULT, READER_MAX, READER_MIN, readerColumns, readerSize } from '../../src/core/reader/readerSize'

describe('a new reader fits the window', () => {
  it('keeps its old size when the window is unknown', () => {
    expect(readerSize(null, 1)).toEqual(READER_DEFAULT)
    expect(readerSize({ width: 0, height: 0 }, 1)).toEqual(READER_DEFAULT)
  })

  it('fits the visible area at 1280x800 with the sidebar open, at a readable zoom', () => {
    // The canvas at 72%: read at 80%, the closest readable zoom, so the fit after opening shows it all at 80%.
    const area = { width: 930, height: 640 }
    const size = readerSize(area, 0.72)
    expect(size.width * 0.8).toBeLessThanOrEqual(area.width - 64 + 1)
    expect(size.height * 0.8).toBeLessThanOrEqual(area.height - 64 + 1)
    expect(size.width).toBeGreaterThan(READER_DEFAULT.width)
  })

  it('fits a 1024x700 window too, rather than opening larger than the view', () => {
    const area = { width: 680, height: 540 }
    const size = readerSize(area, 0.85)
    expect(size.width * 0.85).toBeLessThanOrEqual(area.width)
    expect(size.height * 0.85).toBeLessThanOrEqual(area.height)
  })

  it('reads at no more than 100%, and stays within its smallest and largest sizes', () => {
    expect(readerSize({ width: 3000, height: 2000 }, 1.6)).toEqual(READER_MAX)
    expect(readerSize({ width: 200, height: 150 }, 1)).toEqual(READER_MIN)
    // Zoomed far out, it's sized for 80%, not for 20%, so it doesn't open huge.
    expect(readerSize({ width: 900, height: 600 }, 0.2)).toEqual(readerSize({ width: 900, height: 600 }, 0.8))
  })
})

describe('the side columns', () => {
  const none = { outlineOpen: null, commentsOpen: null, openCount: 0, drafting: false }
  it('folds open comments into the header button on a narrow reader, so the page keeps its room', () => {
    expect(readerColumns(FOLD_COMMENTS_BELOW - 1, { ...none, openCount: 3 }).comments).toBe(false)
    expect(readerColumns(FOLD_COMMENTS_BELOW, { ...none, openCount: 3 }).comments).toBe(true)
  })

  it('shows the column while a comment is being written, at any width', () => {
    expect(readerColumns(600, { ...none, drafting: true }).comments).toBe(true)
  })

  it('lets the person decide either way', () => {
    expect(readerColumns(600, { ...none, commentsOpen: true }).comments).toBe(true)
    expect(readerColumns(1400, { ...none, openCount: 2, commentsOpen: false }).comments).toBe(false)
    expect(readerColumns(600, { ...none, outlineOpen: true }).outline).toBe(true)
    expect(readerColumns(1000, none).outline).toBe(true)
    expect(readerColumns(800, none).outline).toBe(false)
  })
})
