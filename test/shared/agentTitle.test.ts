import { expect, test } from 'vitest'
import { hasDefaultTitle, titleFromPrompt } from '../../src/shared/agentTitle'

// F29: an agent still called "Claude" or "Codex" takes its name from the first thing it was asked.
test('the title is the first line that says something, without Markdown marks, quotes or extra spaces', () => {
  expect(titleFromPrompt('Fix the login redirect loop')).toBe('Fix the login redirect loop')
  expect(titleFromPrompt('\n\n  ## Write   parser tests  \nfor the CSV reader')).toBe('Write parser tests')
  expect(titleFromPrompt('- "Review the docs"')).toBe('Review the docs')
  expect(titleFromPrompt('> **Bump** the `electron` version')).toBe('Bump the electron version')
})

test('a long line is cut at a word, with an ellipsis', () => {
  const title = titleFromPrompt('Find out why the session sidebar sometimes shows a window twice after a restart')
  expect(title).toBe('Find out why the session sidebar sometimes…')
  expect(title!.length).toBeLessThanOrEqual(45)
  expect(titleFromPrompt('a'.repeat(80))).toBe(`${'a'.repeat(44)}…`)
})

test("a team member's prompt is named from its brief, not the team rules put before it", () => {
  const prompt = 'Team rules (from the "Team rules" note on the canvas, for every member):\nNo force pushes.\n\nYour brief:\nAdd retries to the uploader'
  expect(titleFromPrompt(prompt)).toBe('Add retries to the uploader')
})

test('a slash command, a bare tag, or nothing to read gives no title', () => {
  expect(titleFromPrompt('/model opus')).toBeNull()
  expect(titleFromPrompt('<command-name>/clear</command-name>')).toBeNull()
  expect(titleFromPrompt('  \n ** \n')).toBeNull()
  expect(titleFromPrompt('ok')).toBeNull()
})

test("only the title a new agent is given is the default; a name someone chose isn't", () => {
  expect(hasDefaultTitle({ title: 'Claude' })).toBe(true)
  expect(hasDefaultTitle({ title: 'Codex', agent: 'codex' })).toBe(true)
  expect(hasDefaultTitle({ title: 'Codex' })).toBe(false)
  expect(hasDefaultTitle({ title: 'Claude', agent: 'codex' })).toBe(false)
  expect(hasDefaultTitle({ title: 'Release notes' })).toBe(false)
})
