import { describe, expect, test } from 'vitest'
import { codeBlock, link, prefixLines, toggleTask, wrap, type TextEdit } from '../../src/renderer/noteEdit'

const apply = (text: string, e: TextEdit): { text: string; selected: string } => {
  const next = text.slice(0, e.from) + e.insert + text.slice(e.to)
  return { text: next, selected: next.slice(e.select[0], e.select[1]) }
}

describe('wrap', () => {
  test('wraps the selection and keeps it selected', () => {
    expect(apply('a word here', wrap('a word here', 2, 6, '**', 'bold'))).toEqual({ text: 'a **word** here', selected: 'word' })
  })

  test('with nothing selected, selects a placeholder to type over', () => {
    expect(apply('x ', wrap('x ', 2, 2, '_', 'italic'))).toEqual({ text: 'x _italic_', selected: 'italic' })
  })

  test('takes the marks off again', () => {
    expect(apply('a **word** here', wrap('a **word** here', 4, 8, '**', 'bold'))).toEqual({ text: 'a word here', selected: 'word' })
  })
})

test('link selects the address', () => {
  expect(apply('see docs', link('see docs', 4, 8))).toEqual({ text: 'see [docs](https://)', selected: 'https://' })
})

describe('prefixLines', () => {
  test('starts each selected line with the prefix', () => {
    expect(apply('one\ntwo\nthree', prefixLines('one\ntwo\nthree', 1, 6, '- ')).text).toBe('- one\n- two\nthree')
  })

  test('toggles it off when every line has it', () => {
    expect(apply('- one\n- two', prefixLines('- one\n- two', 0, 11, '- ')).text).toBe('one\ntwo')
  })

  test('swaps another list marker for the new one', () => {
    expect(apply('- one', prefixLines('- one', 0, 0, '- [ ] ')).text).toBe('- [ ] one')
    expect(apply('## Title', prefixLines('## Title', 3, 3, '> ')).text).toBe('> Title')
  })

  test('an empty line keeps the caret after the prefix', () => {
    const e = prefixLines('a\n', 2, 2, '- ')
    expect(apply('a\n', e).text).toBe('a\n- ')
    expect(e.select).toEqual([4, 4])
  })
})

describe('codeBlock', () => {
  test('puts the selection in a fenced block on its own lines', () => {
    expect(apply('see {"a":1} ok', codeBlock('see {"a":1} ok', 4, 11, 'json'))).toEqual({ text: 'see \n```json\n{"a":1}\n```\n ok', selected: '{"a":1}' })
  })

  test('with nothing selected, leaves the caret inside', () => {
    const e = codeBlock('', 0, 0, 'python')
    expect(apply('', e).text).toBe('```python\n\n```')
    expect(e.select).toEqual([10, 10])
  })

  test('uses tildes when the code has backtick fences of its own', () => {
    expect(apply('```x```', codeBlock('```x```', 0, 7, '')).text).toBe('~~~\n```x```\n~~~')
  })
})

describe('toggleTask', () => {
  const text = '- [ ] one\n```\n- [ ] not a task\n```\n> 1. [x] two\n* [X] three'

  test('ticks and clears boxes by their place in the render, skipping code', () => {
    expect(toggleTask(text, 0, 3)).toBe(text.replace('- [ ] one', '- [x] one'))
    expect(toggleTask(text, 1, 3)).toBe(text.replace('[x] two', '[ ] two'))
    expect(toggleTask(text, 2, 3)).toBe(text.replace('[X] three', '[ ] three'))
  })

  test('changes nothing when the count disagrees with what is shown', () => {
    expect(toggleTask(text, 0, 4)).toBeNull()
    expect(toggleTask(text, 5, 3)).toBeNull()
  })
})
