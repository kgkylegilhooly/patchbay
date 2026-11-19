import { describe, expect, test, vi } from 'vitest'

vi.mock('../../src/renderer/compareUi', () => ({ openTryApproach: vi.fn(), openComparisons: vi.fn() }))

import { ACTIONS } from '../../src/renderer/actions'
import { openComparisons, openTryApproach } from '../../src/renderer/compareUi'
import { nodeMenu, type Commands, type MenuEntry, type MenuItem } from '../../src/renderer/menus'
import type { ClaudeNode } from '../../src/shared/model'

const find = (menu: MenuEntry[], id: string): MenuItem | undefined => menu.find((e): e is MenuItem => e !== 'separator' && e.id === id)
const agent: ClaudeNode = { id: 'n', kind: 'claude', title: 'Fix it', cwd: 'C:/repo', prompt: 'Fix the login bug', sessionId: null, transcriptPath: null, after: [], x: 0, y: 0, width: 1, height: 1, parentId: null }

describe('where comparisons start', () => {
  test("an agent's menu starts from its folder and its prompt", () => {
    const commands = new Proxy({}, { get: () => vi.fn() }) as unknown as Commands
    find(nodeMenu(commands, agent, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }), 'try-approach')!.run()
    expect(openTryApproach).toHaveBeenCalledWith({ source: 'C:/repo', brief: 'Fix the login bug' })
  })

  test('the palette has Try another approach and Comparisons', () => {
    const commands = {} as Commands
    ACTIONS.find((a) => a.id === 'try-approach')!.run(commands)
    ACTIONS.find((a) => a.id === 'comparisons')!.run(commands)
    expect(openTryApproach).toHaveBeenCalled()
    expect(openComparisons).toHaveBeenCalled()
  })
})
