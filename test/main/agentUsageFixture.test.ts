import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyAgentUsageFixture } from '../../src/main/usage/agentUsageFixture'
import type { AgentAccount, CodexUsage } from '../../src/shared/usage'
import { removeTemp } from '../support/realProcess'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay usage fixture '))
})
afterEach(() => removeTemp(dir))

function fakeUsage() {
  const got: { claude: Array<AgentAccount | null>; codex: Array<CodexUsage | { problem: string; at: number }> } = { claude: [], codex: [] }
  return { got, setClaudeAccount: (a: AgentAccount | null) => void got.claude.push(a), setCodex: (c: CodexUsage | { problem: string; at: number }) => void got.codex.push(c) }
}

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)

test('without the variable, the programs are asked as usual', () => {
  const usage = fakeUsage()
  expect(applyAgentUsageFixture({}, usage, NOW)).toBe(false)
  expect(usage.got).toEqual({ claude: [], codex: [] })
})

test("a run's made-up numbers are shown instead of asking the person's own programs", () => {
  const file = join(dir, 'usage.json')
  writeFileSync(
    file,
    JSON.stringify({
      claudeAccount: { email: 'pat@example.invalid', plan: 'max' },
      codex: { account: { email: 'pat@example.invalid', plan: 'plus' }, windows: [{ percent: 62, minutes: 10080, resetsInMinutes: 3000 }, { percent: 23, minutes: 300, resetsInMinutes: 90 }] }
    })
  )
  const usage = fakeUsage()
  expect(applyAgentUsageFixture({ PATCHBAY_AGENT_USAGE: file }, usage, NOW)).toBe(true)
  expect(usage.got.claude).toEqual([{ email: 'pat@example.invalid', plan: 'max' }])
  expect(usage.got.codex).toEqual([
    {
      account: { email: 'pat@example.invalid', plan: 'plus' },
      // Shortest window first, as Codex's own answer is read, and resetting a fixed time from now so it never runs out.
      windows: [
        { percent: 23, minutes: 300, resetsAt: NOW / 1000 + 90 * 60 },
        { percent: 62, minutes: 10080, resetsAt: NOW / 1000 + 3000 * 60 }
      ],
      at: NOW,
      problem: null
    }
  ])
})

test('a missing or broken file still asks nothing: the run shows no account and no Codex limits', () => {
  for (const text of [null, 'not json', '[]']) {
    const file = join(dir, `u-${String(text).length}.json`)
    if (text !== null) writeFileSync(file, text)
    const usage = fakeUsage()
    expect(applyAgentUsageFixture({ PATCHBAY_AGENT_USAGE: file }, usage, NOW)).toBe(true)
    expect(usage.got).toEqual({ claude: [null], codex: [] })
  }
})

test('bad windows are left out rather than shown as numbers', () => {
  const file = join(dir, 'usage.json')
  writeFileSync(file, JSON.stringify({ codex: { windows: [{ percent: 'x', minutes: 300 }, { percent: 10, minutes: 300, resetsInMinutes: 5 }] } }))
  const usage = fakeUsage()
  applyAgentUsageFixture({ PATCHBAY_AGENT_USAGE: file }, usage, NOW)
  expect(usage.got.codex).toEqual([{ account: null, windows: [{ percent: 10, minutes: 300, resetsAt: NOW / 1000 + 300 }], at: NOW, problem: null }])
})
