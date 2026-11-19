import { afterEach, describe, expect, test } from 'vitest'
import { agentChoice, agentOffReason, commandAllowed, defaultAgentNote, defaultAgentOf, withAgent } from '../../src/shared/agents'
import { mergeSettings, parseSettings } from '../../src/main/lifecycle'
import { ACTIONS, actionReady } from '../../src/renderer/actions'
import { noteAgentSettings } from '../../src/renderer/agentChoice'
import type { MenuState } from '../../src/renderer/menus'

afterEach(() => noteAgentSettings({}))

describe('the setting', () => {
  test('a settings file from before it existed has every agent on, and its default unchanged', () => {
    const old = parseSettings(JSON.stringify({ defaultAgent: 'codex', shell: 'pwsh.exe' }))
    expect(old.agentsOff).toBeUndefined()
    expect(agentChoice(old)).toEqual({ enabled: ['claude', 'codex'], default: 'codex' })
    expect(agentChoice({})).toEqual({ enabled: ['claude', 'codex'], default: 'claude' })
    expect(agentChoice(parseSettings(null))).toEqual({ enabled: ['claude', 'codex'], default: 'claude' })
  })

  test('agentsOff is read, kept by a save, and left out again once every agent is on', () => {
    const off = withAgent({ defaultAgent: 'codex' }, 'codex', false)!
    expect(off.agentsOff).toBe('codex')
    const text = mergeSettings(JSON.stringify({ mine: 1 }), off)!
    expect(JSON.parse(text)).toMatchObject({ mine: 1, agentsOff: 'codex', defaultAgent: 'codex' })
    expect(agentChoice(parseSettings(text)).enabled).toEqual(['claude'])
    const on = withAgent(parseSettings(text), 'codex', true)!
    expect(on.agentsOff).toBeUndefined()
    expect(JSON.parse(mergeSettings(text, on)!)).not.toHaveProperty('agentsOff')
  })

  test('unknown words are ignored, and spaces or commas separate them', () => {
    expect(agentChoice({ agentsOff: 'gpt, codex' }).enabled).toEqual(['claude'])
    expect(agentChoice({ agentsOff: 'nothing' }).enabled).toEqual(['claude', 'codex'])
  })
})

describe('at least one agent stays on', () => {
  test('turning off the last one is refused', () => {
    const codexOnly = withAgent({}, 'claude', false)!
    expect(agentChoice(codexOnly).enabled).toEqual(['codex'])
    expect(withAgent(codexOnly, 'codex', false)).toBeNull()
  })

  test('a hand-edited file turning every agent off reads as every agent on', () => {
    expect(agentChoice({ agentsOff: 'claude codex' }).enabled).toEqual(['claude', 'codex'])
  })
})

describe('the default agent', () => {
  test('when it is turned off, the one still on stands in, and Settings says so', () => {
    const s = { defaultAgent: 'codex', agentsOff: 'codex' }
    expect(defaultAgentOf(s)).toBe('claude')
    expect(defaultAgentNote(s)).toBe('Codex is turned off, so Claude Code is the default until Codex is on again.')
    expect(defaultAgentNote({ defaultAgent: 'codex' })).toBeNull()
    // The person's choice is kept, so turning it back on makes it the default again.
    expect(defaultAgentOf(withAgent(s, 'codex', true)!)).toBe('codex')
  })

  test('with Claude Code off, the default is Codex even when none was chosen', () => {
    expect(defaultAgentOf({ agentsOff: 'claude' })).toBe('codex')
  })
})

test('the refusal names the setting and the agents still on', () => {
  const choice = agentChoice({ agentsOff: 'codex' })
  expect(agentOffReason('codex', choice)).toBe("Codex is turned off in Settings > Agents, so Patchbay won't start it. Patchbay may use Claude Code.")
  expect(agentOffReason('claude', choice)).toBeNull()
})

describe('the canvas offers only agents that are on', () => {
  const state = { hasWindow: false, selectedCount: 0 } as unknown as MenuState
  const ready = (id: string) => actionReady(ACTIONS.find((a) => a.id === id)!, state)

  test('menu items, dock buttons and palette actions for an agent that is off are left out', () => {
    const choice = agentChoice({ agentsOff: 'codex' })
    expect(commandAllowed('new-codex', choice)).toBe(false)
    expect(commandAllowed('new-claude', choice)).toBe(true)
    expect(commandAllowed('new-terminal', choice)).toBe(true)
    expect(ready('new-codex')).toBe(true)
    noteAgentSettings({ agentsOff: 'codex' })
    expect(ready('new-codex')).toBe(false)
    expect(ready('new-claude')).toBe(true)
    noteAgentSettings({ agentsOff: 'claude' })
    expect(ready('new-claude')).toBe(false)
    expect(ready('new-codex')).toBe(true)
  })
})
