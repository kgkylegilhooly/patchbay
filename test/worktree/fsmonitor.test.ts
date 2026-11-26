import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createWorktree, removeWorktree } from '../../src/core/worktree/service'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

// WT1 (docs/improvement-log.md, 2026-11-26 worktree audit): an agent can write its repository's config, so a program
// it names as core.fsmonitor must not run when Patchbay adds or removes a worktree (a group's, or compare's attempts).
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

test("adding and removing a worktree runs no fsmonitor program the repository's config names", async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-wt1-'))
  dirs.push(root)
  const slashes = (p: string): string => p.split('\\').join('/')
  const marker = join(root, 'fsmonitor-ran.txt')
  const hook = join(root, 'hook.sh')
  writeFileSync(hook, `#!/bin/sh\necho ran >> "${slashes(marker)}"\nexit 1\n`)
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  git('config', 'core.fsmonitor', slashes(hook))

  const wt = await createWorktree({ repo, branch: 'try-a', path: join(root, 'wt-a') })
  expect(existsSync(marker)).toBe(false)
  expect(await removeWorktree(wt)).toEqual({ ok: true })
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(join(root, 'wt-a'))).toBe(false)
})
