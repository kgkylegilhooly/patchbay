import { describe, expect, test, vi } from 'vitest'
import { menuLeftWithin, waitingForReview, workLabel, workMenu } from '../../src/renderer/workDock'
import type { MenuItem } from '../../src/renderer/menus'
import { ACTIONS } from '../../src/renderer/actions'

describe('waitingForReview', () => {
  test('counts submitted work, ready or blocked, as the inbox does', () => {
    expect(
      waitingForReview([
        { state: 'ready-for-review', submissionId: 's1' },
        { state: 'blocked', submissionId: 's2' },
        // Blocked before anything was submitted isn't waiting for the person.
        { state: 'blocked' },
        { state: 'running', submissionId: 's3' },
        { state: 'accepted', submissionId: 's4' }
      ])
    ).toBe(2)
  })

  test('none with no task records', () => {
    expect(waitingForReview(undefined)).toBe(0)
  })
})

describe('workMenu', () => {
  const items = (waiting: number): MenuItem[] => workMenu({ toggleRecent: vi.fn() }, { waiting }).filter((e): e is MenuItem => e !== 'separator')

  test('gives one-click access to search, recipes and workflows, review, comparisons, files, closed conversations and projects', () => {
    expect(items(0).map((i) => i.id)).toEqual(['search', 'new-from-recipe', 'review-inbox', 'comparisons', 'file-shelf', 'recent', 'manage-projects'])
    expect(items(0).map((i) => i.label)).toContain('Recipes and workflows…')
  })

  test('each item is an action, so it shows the same shortcut as everywhere else', () => {
    const ids = new Set(ACTIONS.map((a) => a.id))
    for (const item of items(0)) expect(ids.has(item.id), item.id).toBe(true)
  })

  test('the review inbox says how many wait, and nothing when none do', () => {
    expect(items(2).find((i) => i.id === 'review-inbox')?.shortcut).toBe('2 waiting')
    expect(items(0).find((i) => i.id === 'review-inbox')?.shortcut).toBeUndefined()
  })

  test('closed conversations runs the canvas command', () => {
    const toggleRecent = vi.fn()
    const recent = workMenu({ toggleRecent }, { waiting: 0 }).find((e) => e !== 'separator' && e.id === 'recent') as MenuItem
    recent.run()
    expect(toggleRecent).toHaveBeenCalledOnce()
  })

  test('the button names what waits', () => {
    expect(workLabel(0)).toBe('Work')
    expect(workLabel(3)).toBe('Work: 3 waiting for review')
  })
})

describe('menuLeftWithin', () => {
  test('stays at its button when it fits', () => {
    expect(menuLeftWithin({ dockLeft: 300, button: 100, width: 340, windowWidth: 1280 })).toBe(100)
  })

  test('moves left so its right edge stays inside the window, as at 1024 px', () => {
    const left = menuLeftWithin({ dockLeft: 380, button: 370, width: 340, windowWidth: 1024 })
    expect(380 + left + 340).toBeLessThanOrEqual(1024 - 8)
  })

  test('never past the window left edge', () => {
    expect(380 + menuLeftWithin({ dockLeft: 380, button: 370, width: 2000, windowWidth: 1024 })).toBe(8)
  })
})
