import { describe, expect, it } from 'vitest'
import { FAR_BELOW, HYSTERESIS, MAX_HEAD_SCALE, NEAR_READABLE, OVERVIEW_BELOW, headScale, headerFolder, keyBadge, nextTier } from '../../src/renderer/zoomTier'
import { headerMenuEntries, type HeaderMenuActions, type HeaderMenuState } from '../../src/renderer/nodes/headerMenu'
import type { MenuItem } from '../../src/renderer/menus'

describe('zoom tiers', () => {
  it('starts in the tier its zoom is in', () => {
    expect(nextTier(null, 1)).toBe('near')
    expect(nextTier(null, FAR_BELOW)).toBe('near')
    expect(nextTier(null, 0.72)).toBe('near')
    expect(nextTier(null, 0.5)).toBe('far')
    expect(nextTier(null, OVERVIEW_BELOW)).toBe('far')
    expect(nextTier(null, 0.2)).toBe('overview')
  })

  it('switches at the line going out', () => {
    expect(nextTier('near', FAR_BELOW - 0.001)).toBe('far')
    expect(nextTier('far', OVERVIEW_BELOW - 0.001)).toBe('overview')
    expect(nextTier('near', 0.1)).toBe('overview')
  })

  it('needs the margin to come back in, so a zoom resting on the line does not flicker', () => {
    expect(nextTier('far', FAR_BELOW + HYSTERESIS / 2)).toBe('far')
    expect(nextTier('far', FAR_BELOW + HYSTERESIS + 0.001)).toBe('near')
    expect(nextTier('overview', OVERVIEW_BELOW + HYSTERESIS / 2)).toBe('overview')
    expect(nextTier('overview', OVERVIEW_BELOW + HYSTERESIS + 0.001)).toBe('far')
    // A big jump in goes straight to where it lands.
    expect(nextTier('overview', 1.2)).toBe('near')
  })

  it('draws a far header at its on-screen size, up to a cap', () => {
    expect(headScale(1, 'near')).toBe(1)
    expect(headScale(0.5, 'far')).toBe(2)
    expect(headScale(0.55, 'far')).toBeCloseTo(1.8, 5)
    expect(headScale(0.1, 'overview')).toBe(MAX_HEAD_SCALE)
    // Coming back in while still far: the scale follows the zoom, and is never below 1.
    expect(headScale(0.62, 'far')).toBe(1.6)
    expect(headScale(1.2, 'far')).toBe(1)
    expect(headScale(0, 'far')).toBe(1)
  })

  it('keeps a near header readable at the zooms people scan at, with no jump in text size at the far line', () => {
    // At or above NEAR_READABLE, a near header is its own size.
    expect(headScale(NEAR_READABLE, 'near')).toBe(1)
    expect(headScale(1.5, 'near')).toBe(1)
    // At 72% the title (13 px) draws at about 11 px on screen, not 9.
    const at72 = headScale(0.72, 'near')
    expect(at72).toBeCloseTo(1.2, 5)
    expect(13 * at72 * 0.72).toBeGreaterThanOrEqual(11)
    // Down to the far line it grows smoothly, a step of 0.05 at a time, and never shrinks as the zoom falls.
    let last = 1
    for (let z = 1; z >= FAR_BELOW - HYSTERESIS; z -= 0.005) {
      const s = headScale(z, 'near')
      expect(s).toBeGreaterThanOrEqual(last)
      expect(s - last).toBeLessThanOrEqual(0.05 + 1e-9)
      last = s
    }
    // Just above the far line, near text is within a few px of the far tile's.
    const nearText = 13 * headScale(0.6, 'near') * 0.6
    const farText = 15 * headScale(0.59, 'far') * 0.59
    expect(farText - nearText).toBeLessThan(5)
  })

  it('quantizes the scale, so a wheel zoom re-lays headers out a few times, not every frame', () => {
    const scales = new Set<number>()
    for (let z = 0.5; z < 0.55; z += 0.001) scales.add(headScale(z, 'far'))
    expect(scales.size).toBeLessThanOrEqual(5)
  })
})

describe('the key badge', () => {
  const context = { text: '71% context', level: 'warn' }
  it('shows what is being asked first', () => {
    expect(keyBadge({ approval: { tool: 'Bash', summary: 'npm run build' }, context, folder: 'site' })).toEqual({ text: 'Bash: npm run build', tone: 'needs', title: 'Bash: npm run build' })
  })
  it('then a context that is filling up, but not one that is fine', () => {
    expect(keyBadge({ context, folder: 'site' })).toEqual({ text: '71% context', tone: 'warn' })
    expect(keyBadge({ context: { text: '12% context', level: 'ok' }, folder: 'site' })).toEqual({ text: 'site', tone: 'plain' })
  })
  it('and nothing when there is nothing to say', () => {
    expect(keyBadge({ context: { text: '12% context', level: 'ok' }, folder: '' })).toBeNull()
    expect(keyBadge({})).toBeNull()
  })
})

describe('the folder a header shows', () => {
  it("is hidden when it is the project's own", () => {
    expect(headerFolder('C:\\Code\\site', 'C:\\Code\\site')).toBe('')
    expect(headerFolder('c:/code/site/', 'C:\\Code\\site')).toBe('')
  })
  it("is the folder's own name otherwise, not the tail of its path", () => {
    expect(headerFolder('C:\\Code\\site\\.claude\\worktrees\\ux-zoom', 'C:\\Code\\site')).toBe('ux-zoom')
    expect(headerFolder('/home/me/api', null)).toBe('api')
  })
  it('keeps an SSH host as it is', () => {
    expect(headerFolder('ssh build-box', 'C:\\Code\\site')).toBe('ssh build-box')
    expect(headerFolder('', 'C:\\Code\\site')).toBe('')
  })
})

describe('the header ⋯ menu', () => {
  const base: HeaderMenuState = { kind: 'claude', chat: false, naming: false, size: 13, global: 13, own: false, min: 8, max: 20, folder: 'C:\\Code\\site' }
  const calls: string[] = []
  const act: HeaderMenuActions = {
    refresh: () => calls.push('refresh'),
    toggleChat: () => calls.push('chat'),
    name: () => calls.push('name'),
    step: (by) => calls.push(`step ${by}`),
    resetSize: () => calls.push('reset'),
    copyFolder: () => calls.push('copy')
  }
  const items = (s: Partial<HeaderMenuState> = {}): MenuItem[] => headerMenuEntries({ ...base, ...s }, act).filter((e): e is MenuItem => e !== 'separator')
  const tools = (s: Partial<HeaderMenuState> = {}): (string | undefined)[] => items(s).map((i) => i.tool)

  it('holds the tools that left the header, by window kind', () => {
    expect(tools()).toEqual(['refresh', 'chat', 'name', 'font-size', 'copy-path'])
    expect(tools({ kind: 'terminal' })).toEqual(['refresh', 'name', 'font-size', 'copy-path'])
    expect(tools({ kind: 'run' })).toEqual(['refresh', 'font-size', 'copy-path'])
    expect(tools({ folder: '' })).toEqual(['refresh', 'chat', 'name', 'font-size'])
  })

  it('names the chat toggle by what it will show', () => {
    expect(items().find((i) => i.tool === 'chat')!.label).toBe('Show as a chat')
    expect(items({ chat: true }).find((i) => i.tool === 'chat')!.label).toBe('Show the terminal')
  })

  it('says when Name with AI is already running, and does not start it twice', () => {
    const name = items({ naming: true }).find((i) => i.tool === 'name')!
    expect(name.disabled).toBe(true)
    expect(name.label).toMatch(/Asking Claude/)
  })

  it('steps the text size within its range, and only offers the global size when the window has its own', () => {
    const row = items().find((i) => i.tool === 'font-size')!
    expect(row.steps!.value).toBe('13')
    expect(row.steps!.canRun).toBe(false)
    row.steps!.up.run()
    row.steps!.down.run()
    expect(calls.slice(-2)).toEqual(['step 1', 'step -1'])
    const own = items({ size: 20, own: true }).find((i) => i.tool === 'font-size')!
    expect(own.steps!.canRun).toBe(true)
    expect(own.steps!.up.disabled).toBe(true)
    expect(own.steps!.down.disabled).toBe(false)
    expect(own.steps!.runLabel).toMatch(/global size, 13/)
    own.run()
    expect(calls.at(-1)).toBe('reset')
  })
})
