'use strict'
// Review notes on the real app: leave notes on diff lines in the git panel, and send them to an agent as one message.
// The agent is fake-claude.cjs, so no quota is used. Run after npm run build.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
for (const k of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k) || L.inheritNot(k)) delete gitEnv[k]
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function note(page, index, text) {
  await page.hover(`[data-diff-line="${index}"]`)
  await page.click(`[data-review-add="${index}"]`)
  await page.type('.review-edit textarea', text)
  await page.click('.review-save')
}

async function main() {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-review-')))
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Accept'], ['user.email', 'accept@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')

  const profile = L.newProfile({ claudeCommand: `node "${fakeClaude}"`, notifications: 'off', sound: 'off' })
  const box = { parentId: null, width: 520, height: 300, projectId: 'p1' }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3,
    projects: [{ id: 'p1', name: 'Widget', folder: repo, viewport: { x: 0, y: 0, zoom: 0.8 } }],
    activeProjectId: 'p1',
    viewport: { x: 40, y: 40, zoom: 0.8 },
    edges: [],
    closed: [],
    nodes: [{ ...box, id: 'c1', kind: 'claude', title: 'Helper', x: 0, y: 0, cwd: repo, prompt: 'idle', sessionId: null, transcriptPath: null, after: [] }]
  }))
  const app = await L.launch({ profile })
  const page = app.page
  try {
    await L.waitFor('the agent to be idle', async () => (await L.statusOf(page, 'c1')) === 'idle', 30000)
    await page.click('.react-flow__pane')
    await U.chord(page, 'ctrl+shift', 'KeyH')
    await page.waitForSelector('.git-panel', { timeout: 5000 })
    await L.waitFor('the change', () => page.$('[data-git-entry="unstaged:a.txt"]'), 10000)
    await page.click('[data-git-entry="unstaged:a.txt"] .git-entry-name')
    await page.waitForSelector('.review-diff', { timeout: 10000 })
    const lines = await page.$$eval('[data-diff-line]', (ls) => ls.map((l) => ({ i: Number(l.dataset.diffLine), text: l.textContent })))
    const added = lines.find((l) => l.text.endsWith('+TWO\n'))
    const removed = lines.find((l) => l.text.endsWith('-two\n'))
    c.check('The diff shows line numbers and a note button on each line', !!added && !!removed && (await page.$$('[data-review-add]')).length >= 4, lines)

    await note(page, added.i, 'Keep this lower case')
    await note(page, removed.i, 'Why was this removed?')
    const shown = await page.$$eval('.review-note-text', (ns) => ns.map((n) => n.textContent))
    c.check('Notes show under their lines', JSON.stringify(shown) === JSON.stringify(['Why was this removed?', 'Keep this lower case']), shown)
    c.check('The review bar counts them', (await page.$eval('.review-count', (e) => e.textContent)) === '2 notes')
    const target = await page.$eval('.review-bar select', (s) => s.selectedOptions[0].textContent)
    c.check('It offers the agent working in this repository', target === 'Helper (Claude Code)', target)
    console.log('SHOT', await L.shot(page, 'review-after-notes'))

    await page.click('[data-review="send"]')
    const result = await L.waitFor('the result', () => page.$eval('.review-result', (e) => e.textContent).catch(() => null), 10000)
    c.check('Send review says where it went', /Helper/.test(result), result)
    const received = await L.waitFor('the agent to receive it', async () => {
      const s = await L.snapshot(page, 'c1')
      return s.includes('Review of the changes') && s.includes('Keep this lower case') ? s : null
    }, 15000).catch((e) => e.message)
    c.check('The agent receives every note with its file and line', typeof received === 'string' && /line 2/.test(received) && /removed line 2/.test(received), String(received).slice(-400))
    c.check('Sending clears the notes', (await page.$$('.review-note')).length === 0)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
