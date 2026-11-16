import { expect, test } from 'vitest'
import { startupQuestion } from '../../src/core/status/startupQuestion'

test.each([
  ['Codex', 'Folder access\n  Trust this folder? Codex can read, edit, and run files here', 'folder-trust'],
  ['Codex, older', 'Do you trust the contents of this directory?', 'folder-trust'],
  ['Claude', 'Do you trust the files in this folder?', 'folder-trust'],
  ['Claude, newer', 'Is this a project you created or one you trust?', 'folder-trust'],
  ['Codex sign-in', 'Sign in with ChatGPT to use Codex', 'sign-in'],
  ['words placed without spaces', 'Trustthisfolder?', 'folder-trust']
])('%s', (_name, screen, kind) => {
  expect(startupQuestion(screen)).toBe(kind)
})

test('an ordinary start, or a prompt that only mentions trust, is no question', () => {
  expect(startupQuestion('Welcome to Claude Code! /help for help')).toBeNull()
  expect(startupQuestion('Review the trust model in auth.ts')).toBeNull()
})
