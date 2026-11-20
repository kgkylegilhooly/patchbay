import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createVerifyRunner } from '../../src/main/compare/verifyRunner'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-verify-'))
})
afterEach(() => removeTemp(dir))

const runner = () =>
  createVerifyRunner({
    launcher: resolve(__dirname, '../../resources/launch-run.cjs'),
    planDir: join(dir, 'plans'),
    node: process.execPath,
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
  })

test('runs the argument list in the worktree, with no shell, and gives back its exit code and output', async () => {
  writeFileSync(join(dir, 'check.cjs'), "console.log('cwd=' + process.cwd()); console.log('arg=' + process.argv[2]); process.exit(3)")
  const r = await runner()(['node', 'check.cjs', '$HOME&&x'], dir)
  expect(r.code).toBe(3)
  expect(r.stdout).toContain(`cwd=${dir}`)
  // A shell would have expanded or split this; it arrives as written.
  expect(r.stdout).toContain('arg=$HOME&&x')
})

test('a program that is not on PATH fails with a reason, and the plan file is removed', async () => {
  const r = await runner()(['no-such-program-xyz'], dir)
  expect(r.code).not.toBe(0)
  expect(r.stdout).toMatch(/Couldn't find no-such-program-xyz/)
  const { readdirSync } = await import('node:fs')
  expect(readdirSync(join(dir, 'plans'))).toEqual([])
})

test('the command does not inherit Electron-as-Node from the launcher', async () => {
  writeFileSync(join(dir, 'env.cjs'), "console.log('run-as-node=' + (process.env.ELECTRON_RUN_AS_NODE ?? 'unset'))")
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), ELECTRON_RUN_AS_NODE: '1' }
  const run = createVerifyRunner({ launcher: resolve(__dirname, '../../resources/launch-run.cjs'), planDir: join(dir, 'plans'), node: process.execPath, env })
  const r = await run(['node', 'env.cjs'], dir)
  expect(r.stdout).toContain('run-as-node=unset')
})

test('keeps the end of the output, stdout and stderr in the order they came', async () => {
  writeFileSync(
    join(dir, 'loud.cjs'),
    [
      'const NL = String.fromCharCode(10)',
      "for (let i = 0; i < 20000; i++) process.stdout.write('progress line ' + i + NL)",
      "setTimeout(() => { process.stderr.write('FAILED: 1 test' + NL); setTimeout(() => process.stdout.write('summary: 1 failed' + NL), 50) }, 50)"
    ].join('\n')
  )
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
  const run = createVerifyRunner({ launcher: resolve(__dirname, '../../resources/launch-run.cjs'), planDir: join(dir, 'plans'), node: process.execPath, env, keepBytes: 4096 })
  const r = await run(['node', 'loud.cjs'], dir)
  expect(r.truncated).toBe(true)
  expect(r.stdout.length).toBeLessThanOrEqual(4096)
  expect(r.totalBytes).toBeGreaterThan(200_000)
  // The summary at the very end survives, after the error line, after the last progress line.
  expect(r.stdout).toMatch(/progress line 19999\n[^]*FAILED: 1 test\n[^]*summary: 1 failed\n$/)
  expect(r.stdout).not.toContain('progress line 0\n')
})
