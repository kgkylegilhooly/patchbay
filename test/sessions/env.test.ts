import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { cleanEnv, notPassedPrefixes } from '../../src/main/sessions/env'
import { pickDefaultShell } from '../../src/main/sessions/shell'

test('cleanEnv removes CLAUDECODE and CLAUDE_CODE_* but keeps PATH', () => {
  const env = cleanEnv({ PATH: 'a;b', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: 'h' }, {}, [])
  expect(env).toEqual({ PATH: 'a;b', HOME: 'h' })
})

test('cleanEnv also removes the prefixes in the envNotPassed setting', () => {
  const env = cleanEnv({ PATH: 'a', OTHERAPP_NODE_ID: 'x', OtherApp_Port: '1', OTHER: 'kept' }, {}, notPassedPrefixes('OTHERAPP_'))
  expect(env).toEqual({ PATH: 'a', OTHER: 'kept' })
})

test('notPassedPrefixes reads a list separated by spaces or commas, and skips what is not a name', () => {
  expect(notPassedPrefixes(' one_, Two_  bad-name *  ')).toEqual(['ONE_', 'TWO_'])
  expect(notPassedPrefixes(undefined)).toEqual([])
})

test('cleanEnv matches variable names case-insensitively, as Windows does', () => {
  const env = cleanEnv({ claudecode: '1', Claude_Code_X: '1', Keep: 'y' }, {}, [])
  expect(env).toEqual({ Keep: 'y' })
})

test('cleanEnv does not inherit a parent Patchbay identity', () => {
  expect(cleanEnv({ PATCHBAY_NODE_ID: 'parent', PATCHBAY_TOKEN: 't' }, {})).toEqual({})
})

test('cleanEnv applies extras, replacing a base variable that differs only in case', () => {
  const env = cleanEnv({ Path: 'old', A: undefined }, { PATH: 'new', PATCHBAY_NODE_ID: 'n' })
  expect(env).toEqual({ PATH: 'new', PATCHBAY_NODE_ID: 'n' })
})

test('pickDefaultShell honors a shell from settings', () => {
  expect(pickDefaultShell('C:\\tools\\nu.exe')).toEqual({ file: 'C:\\tools\\nu.exe', args: [] })
})

test('pickDefaultShell prefers Git Bash when present, otherwise PowerShell', () => {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  expect(pickDefaultShell()).toEqual(
    existsSync(gitBash) ? { file: gitBash, args: ['--login', '-i'] } : { file: 'powershell.exe', args: [] }
  )
})
