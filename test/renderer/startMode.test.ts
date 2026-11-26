import { expect, test } from 'vitest'
import { newClaude } from '../../src/renderer/newNodes'
import { modelNameOf, startChipText, startModeOf } from '../../src/shared/startMode'

const place = { doc: { nodes: [], edges: [], projects: [], activeProjectId: 'p1' }, group: null } as never

test('a Claude window keeps how the form said to start it; Codex has its own modes, so it keeps neither', () => {
  expect(newClaude(place, 'a', { cwd: 'C:\repo', startMode: 'plan', model: 'sonnet' })).toMatchObject({ startMode: 'plan', model: 'sonnet' })
  const codex = newClaude(place, 'b', { cwd: 'C:\repo', agent: 'codex', startMode: 'plan', model: 'sonnet' })
  expect(codex.startMode).toBeUndefined()
  expect(codex.model).toBeUndefined()
})

test('the chip says how it was started, and nothing when it follows Settings', () => {
  expect(startChipText({ startMode: 'plan', model: 'sonnet' })).toBe('Plans first · sonnet')
  expect(startChipText({ model: 'opus' })).toBe('opus')
  expect(startChipText({})).toBeNull()
  expect(startChipText({ agent: 'codex', startMode: 'plan' })).toBeNull()
  // A value that wouldn't be used isn't shown as if it were.
  expect(startChipText({ startMode: 'bypassPermissions', model: '--x' })).toBeNull()
})

test('only the fixed modes and one-word model names count', () => {
  expect(startModeOf('acceptEdits')).toBe('acceptEdits')
  expect(startModeOf('bypassPermissions')).toBeUndefined()
  expect(modelNameOf(' claude-opus-5-5 ')).toBe('claude-opus-5-5')
  expect(modelNameOf('opus sonnet')).toBeUndefined()
  expect(modelNameOf('-m')).toBeUndefined()
})
