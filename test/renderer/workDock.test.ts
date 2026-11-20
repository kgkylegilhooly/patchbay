import { describe, expect, test, vi } from 'vitest'
import { waitingForReview, workLabel, workMenu } from '../../src/renderer/workDock'
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
