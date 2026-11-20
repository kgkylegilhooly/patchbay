'use strict'
// Screenshot scenes for the panels with no scene of their own: `node screenshot.js <out.png> --scene board` (and
// board-remove, git-diff, review-inbox). The board has a submitted task, so its outcome chips show; the git panel
// opens on a small repository with a changed README.md and its diff.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore', windowsHide: true })

function seedBoard(doc) {
  const cwd = doc.projects[0].folder
  // One session in a folder inside the project, so its card shows the path from the project.
  const api = path.join(cwd, 'packages', 'api')
  fs.mkdirSync(api, { recursive: true })
  doc.nodes.find((n) => n.id === 'work').cwd = api
  const at = Date.now() - 20 * 60_000
  const revision = { revision: null, uncommitted: null, fingerprint: null, noRepo: true }
  doc.projects[0].tasks = {
    tasks: [
      {
        id: 't1', projectId: 'p1', brief: 'Fix the login redirect', acceptanceCriteria: ['Signing in returns you to the page you came from'],
        assignedSessionIds: ['needs'], cwd, state: 'ready-for-review', requiredChecks: [{ id: 'test', command: 'npm test', cwd }], dependsOn: [],
        createdAt: at, updatedAt: at, createdBy: { kind: 'person' }, submissionId: 's1', acceptances: []
      }
    ],
    attempts: [{ kind: 'agent-report', id: 's1', taskId: 't1', sessionId: 'needs', startedAt: at, endedAt: at + 60_000, summary: 'The redirect target is kept through sign-in, with a test for it.', revision }]
  }
}

function seedRepo(doc) {
  const cwd = doc.projects[0].folder
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Counter\n')
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'add', 'README.md')
  git(cwd, 'commit', '-q', '-m', 'First')
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Counter\n\nCounts to three now.\n')
}

const openBoard = async (page) => {
  await page.evaluate(() => document.querySelector('.dock [data-cmd="toggle-board"]').click())
  await sleep(1500)
}

const scenes = {
  board: openBoard,
  'board-remove': async (page) => {
    await openBoard(page)
    await page.evaluate(() => document.querySelector('[data-col-tool="remove"]:not(:disabled)').click())
    await sleep(300)
  },
  'git-diff': async (page) => {
    await page.evaluate(() => document.querySelector('.dock [data-cmd="toggle-git"]').click())
    await page.waitForSelector('[data-git-entry$="README.md"] .git-entry-name', { timeout: 15000 })
    await page.click('[data-git-entry$="README.md"] .git-entry-name')
    await sleep(1200)
  },
  'review-inbox': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
    await sleep(200)
    await page.click('.menu-panel [data-cmd="review-inbox"]')
    await sleep(1500)
  }
}

const seeds = {
  board: seedBoard,
  'board-remove': seedBoard,
  'git-diff': seedRepo
}

module.exports = { scenes, seeds }
