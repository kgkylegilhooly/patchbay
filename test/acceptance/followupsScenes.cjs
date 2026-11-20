'use strict'
// Screenshot scenes for the follow-up integration (docs/plans/followups-integration.md). Register only for the
// screenshot process:
//   node -r ./test/acceptance/followupsScenes.cjs screenshot.js out.png --scene task-compare   (or review-compare, files-origins)
// Throwaway git repositories and pretend agents only (fake-claude.cjs): no real agent quota.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const scenes = require('./scenes.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true })

function repoIn(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'slug.js'), 'export const slugify = (s) => s.toLowerCase().replace(" ", "-")\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'Slugify')
  return git(dir, 'rev-parse', 'HEAD').trim()
}

/** A task with a submission, and a comparison started for it: two attempts, their runs, and attempt B chosen. */
function seedTaskCompare(scene) {
  const cwd = scene.cwd
  const base = repoIn(cwd)
  const now = Date.now()
  const rev = { revision: base, uncommitted: false, fingerprint: null }
  const output = path.join(cwd, '.git', 'run.log')
  fs.writeFileSync(output, 'ok\n')
  const task = {
    id: 'task-slug', projectId: 'p1', brief: 'Make slugify handle every space and accent', acceptanceCriteria: ['All whitespace becomes one dash', 'Accents are dropped'],
    assignedSessionIds: ['idle'], cwd, state: 'ready-for-review', requiredChecks: [{ id: 'unit', command: 'npm test', cwd }], dependsOn: [], createdAt: now - 3600_000, updatedAt: now - 60_000,
    createdBy: { kind: 'person' }, submissionId: 'sub', acceptances: []
  }
  const attempt = (key, agent, branch, chosen) => ({
    kind: 'comparison', id: `comparison-cmp1-${key}`, taskId: task.id, sessionId: `n-${key}`, startedAt: now - 1800_000, comparisonId: 'cmp1', key,
    title: 'Make slugify handle every space and accent', agent, branch, path: path.join(cwd, '..', `wt-${key}`), base, revision: rev,
    ...(chosen ? { chosen: { at: now - 120_000, head: '4c1e9a7d2b' } } : {})
  })
  const run = (id, key, exitCode, mins) => ({
    kind: 'command', id, taskId: task.id, sessionId: `n-${key}`, checkId: `comparison ${key.toUpperCase()}`, command: 'npm test', cwd: path.join(cwd, '..', `wt-${key}`),
    startedAt: now - mins * 60_000, endedAt: now - mins * 60_000 + 9000, exitCode, status: exitCode === 0 ? 'passed' : 'failed', outputRef: output, revision: rev, endRevision: rev,
    comparison: { id: 'cmp1', key }
  })
  scene.doc.projects[0].folder = cwd
  scene.doc.projects[0].tasks = {
    tasks: [task],
    attempts: [
      attempt('a', 'claude', 'try/slugify-a', false),
      attempt('b', 'codex', 'try/slugify-b', true),
      run('r1', 'a', 1, 20),
      run('r2', 'b', 1, 19),
      run('r3', 'b', 0, 8),
      { kind: 'agent-report', id: 'sub', taskId: task.id, sessionId: 'idle', summary: 'Merged try/slugify-b: every space and accent is handled.', startedAt: now - 60_000, endedAt: now - 60_000, revision: rev }
    ]
  }
}

/** One pretend agent whose turn edits a file itself, has a subagent edit another, and runs a "command" that writes a third. */
function seedFilesOrigins(scene) {
  const repo = path.join(scene.cwd, 'shop')
  fs.mkdirSync(repo, { recursive: true })
  repoIn(repo)
  const doc = scene.doc
  doc.projects[0].folder = repo
  // Nothing else on the canvas works in this checkout, so the end-of-turn check runs.
  doc.nodes = doc.nodes.filter((n) => n.projectId === 'p2')
  doc.nodes.push({ id: 'cart', kind: 'claude', title: 'Fix slugify', x: 0, y: 0, width: 620, height: 340, parentId: null, cwd: repo, prompt: 'edits=src/slug.js writes=package-lock.json subedits=test/slug.test.js', sessionId: null, transcriptPath: null, after: [], projectId: 'p1' })
  doc.viewport = { x: 360, y: 80, zoom: 1 }
  doc.projects[0].viewport = doc.viewport
}

const openBoard = async (page) => {
  await page.waitForSelector('[data-cmd="toggle-board"]')
  await page.click('[data-cmd="toggle-board"]')
  await page.waitForSelector('[data-task="task-slug"]')
  await sleep(800)
}

scenes.scenes['task-compare'] = openBoard
scenes.scenes['review-compare'] = async (page) => {
  await openBoard(page)
  await page.click('[data-cmd="review-inbox"]')
  await page.waitForSelector('[data-review-detail="task-slug"]', { timeout: 15000 })
  await page.waitForSelector('[data-task-comparison]', { timeout: 5000 }).catch(() => {})
  await page.evaluate(() => document.querySelector('[data-task-comparison]')?.scrollIntoView({ block: 'center' }))
  await sleep(800)
}
scenes.scenes['files-origins'] = async (page) => {
  // The pretend turn waits 2.5 s, then edits; the end of the turn takes a second snapshot.
  const chip = await page.waitForSelector('.react-flow [data-files-chip="cart"]', { timeout: 20000 }).catch(() => null)
  if (!chip) return
  await page.waitForFunction(() => /3 files/.test(document.querySelector('[data-files-chip="cart"]')?.textContent ?? ''), { timeout: 15000 }).catch(() => {})
  await chip.click()
  await page.waitForSelector('.files-popover .files-row', { timeout: 20000 }).catch(() => {})
  await sleep(600)
}

const prepare = scenes.prepare
scenes.prepare = (name, cwdRoot) => {
  const scene = prepare(name, cwdRoot)
  if (name === 'task-compare' || name === 'review-compare') seedTaskCompare(scene)
  if (name === 'files-origins') seedFilesOrigins(scene)
  return scene
}
