import { describe, expect, it } from 'vitest'
import { noteTile, plainLine, triggerTileLine } from '../../src/renderer/farTiles'
import { relative } from '../../src/renderer/triggerView'

describe('a note tile', () => {
  it('reads markdown as words', () => {
    expect(plainLine('## Plan')).toBe('Plan')
    expect(plainLine('- [ ] Fix **login** now')).toBe('Fix login now')
    expect(plainLine('1. [x] Ship it')).toBe('Ship it')
    expect(plainLine('> See [the notes](./notes.md) and `npm test`')).toBe('See the notes and npm test')
    expect(plainLine('   ')).toBe('')
  })

  it('leads with the first line when the note is still called Note', () => {
    expect(noteTile('Note', '## Plan\n\n- Fix login\n- Ship')).toEqual({ title: 'Plan', lines: ['Fix login', 'Ship'] })
  })

  it('keeps a title the person gave it, with the first lines under it', () => {
    expect(noteTile('Release', '- Tag\n- Notes')).toEqual({ title: 'Release', lines: ['Tag', 'Notes'] })
  })

  it('skips fences and rules, keeps code lines as they are, and stops after a few lines', () => {
    const tile = noteTile('Run', '```sh\nnpm test\n```\n---\na\nb\nc\nd\ne\nf')
    expect(tile.lines[0]).toBe('npm test')
    expect(tile.lines).toHaveLength(4)
  })

  it('says an empty note is empty', () => {
    expect(noteTile('Note', '')).toEqual({ title: 'Note', lines: ['Empty'] })
    expect(noteTile('Ideas', '  \n')).toEqual({ title: 'Ideas', lines: [] })
  })

  it('cuts a very long line', () => {
    const tile = noteTile('Note', 'x'.repeat(500))
    expect(tile.title.length).toBeLessThanOrEqual(120)
    expect(tile.title.endsWith('…')).toBe(true)
  })
})

describe('a trigger tile', () => {
  const now = 1_000_000
  it('says what it waits for, and when it next runs once armed', () => {
    expect(triggerTileLine('Every 10 minutes.', { armed: true, nextAt: now + 4 * 60_000 }, now, relative)).toBe('Next in 4 min · Every 10 minutes')
    expect(triggerTileLine('When npm test finishes', { armed: true, nextAt: null }, now, relative)).toBe('When npm test finishes')
    expect(triggerTileLine('Every 10 minutes', { armed: false, nextAt: now + 1000 }, now, relative)).toBe('Every 10 minutes')
    expect(triggerTileLine('Every minute', { armed: true, nextAt: now - 5 }, now, relative)).toBe('Runs now · Every minute')
  })
})
