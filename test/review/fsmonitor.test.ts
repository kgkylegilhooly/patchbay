import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createReviewGit, systemReviewGit } from '../../src/main/review/git'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

// A repository can name a program for git to ask what changed (core.fsmonitor). A throwaway snapshot on a copied index
// must neither run it nor trust what it says, as files-touched snapshots already don't (docs/improvement-log.md, RV1).
test("a review snapshot never runs the repository's fsmonitor program, and still sees every change", async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-review-fsmon-'))
  dirs.push(root)
  const marker = join(root, 'fsmonitor-ran.txt')
  const hook = join(root, 'hook.sh')
  const slashes = (p: string): string => p.split('\\').join('/')
  writeFileSync(hook, `#!/bin/sh\necho ran > "${slashes(marker)}"\nexit 1\n`)
  const repo = join(root, 'repo')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  git('config', 'core.fsmonitor', slashes(hook))
  writeFileSync(join(repo, 'a.txt'), 'two\n')

  const review = createReviewGit(join(root, 'objects'), patientGit(systemReviewGit()))
  const tree = await review.snapshot(repo)
  expect(existsSync(marker)).toBe(false)
  // The changed file is in the snapshot as it is now.
  const blob = execFileSync('git', ['-C', repo, 'cat-file', '-p', `${tree}:a.txt`], { env: { ...process.env, GIT_OBJECT_DIRECTORY: (await review.storeDir(repo)), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, '.git', 'objects') }, encoding: 'utf8', windowsHide: true })
  expect(blob).toBe('two\n')
})
