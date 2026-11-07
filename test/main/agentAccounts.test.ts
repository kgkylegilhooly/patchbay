import { expect, test } from 'vitest'
import { parseClaudeAccount, parseCodexAccount, parseCodexLimits } from '../../src/main/usage/agentAccounts'

test('the Claude account comes from claude auth status --json', () => {
  const text = JSON.stringify({ loggedIn: true, email: 'me@example.com', orgName: 'Acme', subscriptionType: 'pro', orgId: 'x' })
  expect(parseClaudeAccount(text)).toEqual({ email: 'me@example.com', organization: 'Acme', plan: 'pro' })
  expect(parseClaudeAccount(JSON.stringify({ loggedIn: false }))).toBeNull()
  expect(parseClaudeAccount('not json')).toBeNull()
})

test("Codex's limits come shortest window first, and a malformed one is left out", () => {
  const result = {
    rateLimits: {
      primary: { usedPercent: 13, windowDurationMins: 43200, resetsAt: 1796513466 },
      secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1796500000 }
    }
  }
  expect(parseCodexLimits(result)).toEqual([
    { percent: 40, minutes: 300, resetsAt: 1796500000 },
    { percent: 13, minutes: 43200, resetsAt: 1796513466 }
  ])
  expect(parseCodexLimits({ rateLimits: { primary: { usedPercent: 'x' }, secondary: null } })).toEqual([])
  expect(parseCodexLimits(null)).toEqual([])
})

test('the Codex account comes from account/read', () => {
  expect(parseCodexAccount({ account: { type: 'chatgpt', email: 'me@example.com', planType: 'free', workspaceName: null } })).toEqual({ email: 'me@example.com', plan: 'free' })
  expect(parseCodexAccount({ account: null })).toBeNull()
})
