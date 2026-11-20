import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createVerifyRunner } from '../../src/main/compare/verifyRunner'
import { createFileBatcher, watchFolder, type FileBatch } from '../../src/main/triggers/fileWatch'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

test('a real folder: matching changes arrive as one batch, ignored folders never do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-trigger-watch-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules'))
  const batches: FileBatch[] = []
  const batcher = createFileBatcher({ glob: '*.ts', quietMs: 300, now: Date.now, onBatch: (b) => batches.push(b) })
  const w = watchFolder(dir, (rel) => batcher.change(rel), () => {})
  try {
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(dir, 'src', 'a.ts'), 'one')
    writeFileSync(join(dir, 'src', 'b.ts'), 'two')
    writeFileSync(join(dir, 'notes.md'), 'skip')
    writeFileSync(join(dir, 'node_modules', 'c.ts'), 'skip')
    const deadline = Date.now() + 5000
    while (!batches.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(batches).toHaveLength(1)
    expect(batches[0].files.sort()).toEqual(['src/a.ts', 'src/b.ts'])
  } finally {
    w.close()
    batcher.close()
  }
})

test('a check runs without a shell, through the launcher, and reports its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-trigger-check-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'check.js'), 'console.log("checked"); process.exit(3)')
  const run = createVerifyRunner({ launcher: resolve('resources/launch-run.cjs'), planDir: join(dir, 'plans'), node: process.execPath, env: { ...(process.env as Record<string, string>) }, timeoutMs: 20_000 })
  const r = await run([process.execPath, 'check.js'], dir)
  expect(r.code).toBe(3)
  expect(r.stdout).toContain('checked')
})
