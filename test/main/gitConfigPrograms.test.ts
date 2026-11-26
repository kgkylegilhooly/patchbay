import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { diffArgs, gitEnvFrom } from '../../src/core/git/args'
import { createGitService } from '../../src/core/git/service'
import { compareGit, createCompareReads } from '../../src/main/compare/reads'
import { readRevision } from '../../src/main/tasks/verification'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

// GX1 (docs/improvement-log.md, 2026-11-26 compare audit): a repository's own config can name programs for git to run
// on a diff (diff.external, a textconv driver) or a status (core.fsmonitor). An agent can write that config in its own
// repository. Patchbay's own reads of it must run none of them.

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

const slashes = (p: string): string => p.split('\\').join('/')

/** A repository with one committed file changed since, and config naming a marker-writing program for each hook. */
function trappedRepo(): { repo: string; ran: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'pb-gx1-'))
  dirs.push(root)
  const marks = join(root, 'marks')
  execFileSync('git', ['init', '-q', '-b', 'main', join(root, 'repo')], { windowsHide: true })
  const repo = join(root, 'repo')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, '.gitattributes'), '*.txt diff=probe\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  // Each program leaves a file named for the hook that ran it, and fails, so nothing depends on what it prints.
  const program = (name: string): string => {
    const script = join(root, `${name}.sh`)
    writeFileSync(script, `#!/bin/sh\nmkdir -p "${slashes(marks)}"\necho ran > "${slashes(join(marks, name))}"\nexit 1\n`)
    return slashes(script)
  }
  git('config', 'core.fsmonitor', program('fsmonitor'))
  git('config', 'diff.external', program('external'))
  git('config', 'diff.probe.textconv', program('textconv'))
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  return { repo, ran: () => (existsSync(marks) ? readdirSync(marks).sort() : []) }
}

test("a task's revision reads the repository without running any program its config names", async () => {
  const { repo, ran } = trappedRepo()
  const r = await readRevision(repo)
  expect(ran()).toEqual([])
  expect(r.uncommitted).toBe(true)
  expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/)
})

test("a comparison's file diff and status run none of them either, and still show the change", async () => {
  const { repo, ran } = trappedRepo()
  const git = patientGit(compareGit(gitEnvFrom(process.env as Record<string, string>)))
  const reads = createCompareReads(git, createGitService(git))
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
  const d = await reads.fileDiff(repo, head, 'a.txt', 'uncommitted')
  await reads.ignored(repo)
  expect(ran()).toEqual([])
  expect(d.ok && d.text).toContain('+two')
})

test('the Git panel diff turns off textconv as well as external diff programs', () => {
  expect(diffArgs('a.txt', false)).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
  expect(diffArgs('a.txt', true)).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--cached']))
})
