'use strict'
// Register for one screenshot run: node -r ./test/review/screenshotScene.cjs screenshot.js <png> --scene review
// (or review-diff). A throwaway git repository with a branch, committed work and local changes, and two submitted
// tasks, one ready and one with a stale check. No real agents or app data are used.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const scenes = require(path.join(process.cwd(), 'test', 'acceptance', 'scenes.cjs'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const openInbox = async (page) => {
  await page.waitForSelector('[data-cmd="toggle-board"]')
  await page.click('[data-cmd="toggle-board"]')
  await page.waitForSelector('[data-task="task-ready"]', { timeout: 10000 })
  // The inbox is opened from the board's task outcomes. Before it existed, the picture is the board itself.
  if (!(await page.$('.task-outcomes [data-cmd="review-inbox"]'))) return false
  await page.click('.task-outcomes [data-cmd="review-inbox"]')
  await page.waitForSelector('[data-review-detail="task-ready"] [data-check-state="passed"]', { timeout: 15000 })
  await page.waitForSelector('[data-section="committed"] [data-review-file]', { timeout: 15000 })
  return true
}

const comment = async (page, file, text, on) => {
  await page.click(`[data-section="committed"] [data-review-file="${file}"]`)
  await page.waitForFunction((on) => [...document.querySelectorAll('.rvi-diff .review-line')].some((l) => l.textContent.includes(on)), { timeout: 10000 }, on)
  await page.evaluate((on) => {
    const line = [...document.querySelectorAll('.rvi-diff .review-line')].find((l) => l.textContent.includes(on))
    line.querySelector('.review-add').click()
  }, on)
  await page.waitForSelector('.rvi-diff textarea')
  await page.type('.rvi-diff textarea', text)
  await page.evaluate(() => [...document.querySelectorAll('.rvi-diff .review-save')][0].click())
  await page.waitForFunction((t) => [...document.querySelectorAll('.rvi-comment .rvi-text')].some((e) => e.textContent === t), { timeout: 10000 }, text)
}

scenes.scenes.review = async (page) => {
  if (!(await openInbox(page))) return
  await comment(page, 'src/auth.js', 'Reject expired tokens here too, not only malformed ones.', 'if (!validToken(token))')
  await page.evaluate(() => document.querySelector('.rvi-detail').scrollTo(0, 0))
  await sleep(300)
}

// Fixes requested, the agent's change made on disk, then "Since last review" shows only that change, and the
// comment, moved by the lines added above it, says where it went.
// A file the branch renamed and changed: listed once as a rename, its diff showing both names and the changed line.
// Before renames were shown, the same branch lists a deleted file and an added one.
scenes.scenes['review-rename'] = async (page) => {
  if (!(await openInbox(page))) return
  await page.click('[data-section="committed"] [data-review-file="src/sessions-create.js"]')
  await page.waitForSelector('.rvi-diff .review-line', { timeout: 10000 })
  await page.evaluate(() => document.querySelector('.rvi-changes').scrollIntoView())
  await sleep(300)
}

scenes.scenes['review-diff'] = async (page) => {
  if (!(await openInbox(page))) return
  await comment(page, 'src/auth.js', 'Reject expired tokens here too, not only malformed ones.', 'if (!validToken(token))')
  await comment(page, 'src/token.js', 'Name the allowed characters in a constant.', 'A-Za-z0-9')
  await page.click('[data-review="request-fixes"]')
  await page.waitForSelector('.rvi-result', { timeout: 15000 })
  const said = await page.evaluate(() => document.querySelector('.rvi-result').textContent)
  if (!/queued|sent/.test(said)) throw new Error(`Request fixes failed: ${said}`)
  const folder = await page.evaluate(async () => (await window.patchbay.getDoc()).projects[0].folder)
  const auth = path.join(folder, 'src', 'auth.js')
  const fixed = fs.readFileSync(auth, 'utf8')
    .replace('export function login', 'const MAX_AGE_MS = 15 * 60_000\n\nexport function login')
    .replace('  return createSession', "  if (Date.now() - issuedAt(token) > MAX_AGE_MS) throw new Error('Expired token')\n  return createSession")
  fs.writeFileSync(auth, fixed)
  // Past P1's few seconds of reusing a folder's identity, so the queue shows the submission is no longer current.
  await sleep(3500)
  await page.waitForFunction(() => [...document.querySelectorAll('.rvi-mode')].some((b) => b.textContent === 'Since last review' && !b.disabled), { timeout: 10000 })
  await page.evaluate(() => [...document.querySelectorAll('.rvi-mode')].find((b) => b.textContent === 'Since last review').click())
  await page.waitForSelector('[data-section="since-review"] [data-review-file="src/auth.js"]', { timeout: 15000 })
  await page.click('[data-section="since-review"] [data-review-file="src/auth.js"]')
  await page.waitForSelector('.rvi-diff .review-line', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('.rvi-comment')?.textContent.includes('moved from'), { timeout: 10000 })
  await page.evaluate(() => document.querySelector('.rvi-changes').scrollIntoView())
  await sleep(300)
}

/** The folder's identity exactly as P1's readRevision works it out, so the ready task really is ready. */
function revisionOf(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true })
  const status = git('status', '--porcelain=v1', '-z', '--untracked-files=all')
  const hash = createHash('sha256').update(status)
  hash.update(git('diff', '--binary', 'HEAD', '--'))
  hash.update(git('diff', '--cached', '--binary', '--'))
  const untracked = git('ls-files', '--others', '--exclude-standard', '--full-name', '-z').toString('utf8').split('\0').filter(Boolean).sort()
  for (const f of untracked) hash.update(f).update('\0').update(fs.readFileSync(path.join(cwd, f))).update('\0')
  return { revision: git('rev-parse', 'HEAD').toString().trim(), uncommitted: status.length > 0, fingerprint: hash.digest('hex') }
}

const prepare = scenes.prepare
scenes.prepare = (name, cwdRoot) => {
  const scene = prepare(name, cwdRoot)
  if (name !== 'review' && name !== 'review-diff' && name !== 'review-rename') return scene
  const rename = name === 'review-rename'
  const cwd = scene.cwd
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, windowsHide: true, encoding: 'utf8' })
  const write = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true })
    fs.writeFileSync(path.join(cwd, f), text)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Screenshot fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  write('README.md', '# Login service\n')
  write('src/auth.js', 'export function login(token) {\n  return createSession(token)\n}\n')
  const SESSION = [
    "import { randomUUID } from 'node:crypto'",
    '',
    'const sessions = new Map()',
    '',
    '/** A new session for a valid token. */',
    'export function createSession(token) {',
    '  const id = randomUUID()',
    '  sessions.set(id, { token, at: Date.now() })',
    '  return id',
    '}',
    '',
    'export function endSession(id) {',
    '  sessions.delete(id)',
    '}',
    ''
  ].join('\n')
  if (rename) write('src/session.js', SESSION)
  git('add', '-A')
  git('commit', '-q', '-m', 'Login service')
  git('switch', '-q', '-c', 'feat/token-checks')
  write('src/auth.js', "import { validToken } from './token.js'\n\nexport function login(token) {\n  if (!validToken(token)) throw new Error('Invalid token')\n  return createSession(token)\n}\n")
  if (rename) {
    // Moved into a folder of its own, with one line changed: one rename, not a deleted and an added file.
    git('mv', 'src/session.js', 'src/sessions-create.js')
    write('src/sessions-create.js', SESSION.replace('at: Date.now() }', 'at: Date.now(), expiresAt: Date.now() + 15 * 60_000 }'))
  }
  write('src/token.js',"export function validToken(token) {\n  return typeof token === 'string' && /^[A-Za-z0-9._-]{20,}$/.test(token)\n}\n")
  git('add', '-A')
  git('commit', '-q', '-m', 'Validate tokens before creating a session')
  write('README.md', '# Login service\n\nTokens are validated before a session starts.\n')
  write('notes/todo.md', '- expiry\n')
  const revision = revisionOf(cwd)
  const older = { ...revision, fingerprint: 'an-earlier-state' }
  const t = Date.now() - 20 * 60_000
  const output = path.join(cwd, '.git', 'unit.log')
  fs.writeFileSync(output, 'Test Files 4 passed (4)\n')
  const doc = scene.doc
  Object.assign(doc.nodes.find((n) => n.id === 'idle'), { title: 'Token checks' })
  const task = {
    id: 'task-ready', projectId: 'p1', brief: 'Reject invalid login tokens', acceptanceCriteria: ['Malformed tokens are refused before a session starts', 'Unit tests pass'],
    assignedSessionIds: ['idle'], cwd, state: 'ready-for-review', requiredChecks: [{ id: 'unit', command: 'npm test', cwd }], dependsOn: [], createdAt: t, updatedAt: t + 600_000,
    submissionId: 'sub-ready', acceptances: [], createdBy: { kind: 'person' }
  }
  const blocked = {
    ...task, id: 'task-blocked', brief: 'Write parser tests', acceptanceCriteria: ['Unicode input is covered'], assignedSessionIds: ['work'], state: 'blocked',
    requiredChecks: [{ id: 'lint', command: 'npm run lint', cwd }], submissionId: 'sub-blocked', createdBy: { kind: 'agent', sessionId: 'work' }
  }
  doc.projects[0].tasks = {
    tasks: [blocked, task],
    attempts: [
      { id: 'run-unit', taskId: task.id, sessionId: 'idle', kind: 'command', checkId: 'unit', command: 'npm test', cwd, startedAt: t + 500_000, endedAt: t + 540_000, exitCode: 0, status: 'passed', outputRef: output, revision, endRevision: revision },
      { id: 'sub-ready', taskId: task.id, sessionId: 'idle', kind: 'agent-report', summary: 'Tokens are validated before a session is created. Added validToken with a format check. All unit tests pass.', startedAt: t + 600_000, endedAt: t + 600_000, revision },
      { id: 'run-lint', taskId: blocked.id, sessionId: 'work', kind: 'command', checkId: 'lint', command: 'npm run lint', cwd, startedAt: t, endedAt: t + 30_000, exitCode: 0, status: 'passed', outputRef: output, revision: older, endRevision: older },
      { id: 'sub-blocked', taskId: blocked.id, sessionId: 'work', kind: 'agent-report', summary: 'Parser tests written; lint ran earlier.', startedAt: t + 60_000, endedAt: t + 60_000, revision }
    ]
  }
  return scene
}
