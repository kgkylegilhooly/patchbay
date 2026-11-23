import { describe, expect, it } from 'vitest'
import { isBlankPage } from '../../src/renderer/nodes/browserEmpty'

describe('a browser with nothing in it', () => {
  it('is blank on about:blank, from the node before main reports, and from main after', () => {
    expect(isBlankPage(undefined, 'about:blank')).toBe(true)
    expect(isBlankPage({ url: '', loading: false }, 'about:blank')).toBe(true)
    expect(isBlankPage({ url: 'about:blank', loading: false }, 'http://localhost:5173/')).toBe(true)
  })

  it('is not blank once a page is open or on its way', () => {
    expect(isBlankPage(undefined, 'http://localhost:5173/')).toBe(false)
    expect(isBlankPage({ url: 'http://localhost:5173/', loading: false }, 'about:blank')).toBe(false)
    expect(isBlankPage({ url: 'about:blank', loading: true }, 'about:blank')).toBe(false)
  })
})
