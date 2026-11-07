import { expect, test } from 'vitest'
import { findSsh, sshArgs } from '../../src/main/sessions/ssh'

const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\tools;C:\\Program Files\\Git\\usr\\bin' }

test("prefers Windows' own OpenSSH client", () => {
  expect(findSsh(env, () => true)).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe')
})

test('falls back to an ssh.exe on PATH', () => {
  const only = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe'
  expect(findSsh(env, (p) => p === only)).toBe(only)
})

test('is null when there is none', () => {
  expect(findSsh(env, () => false)).toBeNull()
})

test('ends options before the host', () => {
  expect(sshArgs('build-box')).toEqual(['--', 'build-box'])
})
