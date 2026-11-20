import { expect, test } from 'vitest'
import { agentTypeLabel } from '../../src/renderer/subagents/subagentUi'

test('subagent types read as names, not ids', () => {
  expect(agentTypeLabel('general-purpose')).toBe('General')
  expect(agentTypeLabel('Explore')).toBe('Explore')
  expect(agentTypeLabel('code-reviewer')).toBe('Code-reviewer')
  expect(agentTypeLabel('')).toBe('Subagent')
})
