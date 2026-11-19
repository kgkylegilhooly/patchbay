'use strict'
// Screenshot scenes for comparisons: `node screenshot.js <out.png> --scene compare` (or `compare-start`).
// The project folder is a small git repository inside the scene's folder, so the attempts' worktrees
// (`<folder>-worktrees/...`) are made, and removed, with it. Both attempts run fake-claude.cjs: nothing real starts.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore', windowsHide: true })

function seedCompare(doc) {
  const app = path.join(doc.projects[0].folder, 'app')
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'count.js'), 'module.exports = function count() {\n  return 2\n}\n')
  fs.writeFileSync(path.join(app, 'check.js'), "const n = require('./count.js')()\nconsole.log('count() =', n)\nif (n !== 3) {\n  console.error('FAIL: expected 3')\n  process.exit(1)\n}\nconsole.log('PASS')\n")
  fs.writeFileSync(path.join(app, 'README.md'), '# Counter\n')
  git(app, 'init', '-q', '-b', 'main')
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'Counter that stops at two')
  // Work in progress in the source checkout, which the attempts leave out.
  fs.writeFileSync(path.join(app, 'README.md'), '# Counter\n\nDraft notes, not committed.\n')
  doc.projects[0].folder = app
}

async function openStart(page) {
  await page.keyboard.down('Control')
  await page.keyboard.press('k')
  await page.keyboard.up('Control')
  await page.waitForSelector('.palette-input', { timeout: 5000 })
  await page.type('.palette-input', 'try another approach')
  await sleep(200)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.compare-start .compare-base-line', { timeout: 15000 })
  await page.type('.compare-start textarea', 'Make count() return 3, and keep check.js passing.')
}

const scenes = {
  // The start dialog, on a checkout with an uncommitted change.
  'compare-start': async (page) => {
    await openStart(page)
    await page.type('.compare-start [data-attempt="b"] .field input', 'Compute it instead of hard-coding it')
    await page.type('.compare-start input[placeholder="npm test"]', 'node check.js')
    await sleep(300)
  },
  // Two attempts made from the dialog, worked on, verified, and one chosen.
  compare: async (page) => {
    await openStart(page)
    await page.click('.compare-start [data-attempt="a"] .compare-agent:first-of-type')
    const agents = await page.$$('.compare-start [data-attempt="b"] .compare-agent')
    await agents[0].click()
    await page.type('.compare-start [data-attempt="b"] .field input', 'Compute it instead of hard-coding it')
    await page.type('.compare-start input[placeholder="npm test"]', 'node check.js')
    await page.click('.compare-dirty input[type="checkbox"]')
    await page.click('.compare-start .btn-solid')
    await page.waitForSelector('.compare-sheet .compare-attempt[data-attempt="b"]', { timeout: 30000 })

    // What the agents might have done: A commits a fix, and leaves a note; B edits without committing.
    const doc = await page.evaluate(async () => {
      const list = await window.patchbayCompare.list((await window.patchbay.getDoc()).activeProjectId)
      return list[0]
    })
    const [a, b] = doc.attempts
    fs.writeFileSync(path.join(a.path, 'count.js'), 'module.exports = function count() {\n  return 3\n}\n')
    git(a.path, 'commit', '-q', '-am', 'Return three')
    fs.writeFileSync(path.join(a.path, 'NOTES.md'), 'Hard-coded for now.\n')
    fs.writeFileSync(path.join(b.path, 'count.js'), 'module.exports = function count() {\n  return [1, 2].length\n}\n')

    const ran = await page.evaluate(async (id) => {
      const out = [await window.patchbayCompare.verify(id, 'a'), await window.patchbayCompare.verify(id, 'b')]
      await window.patchbayCompare.choose(id, 'a')
      return out
    }, doc.id)
    if (process.env.COMPARE_SCENE_DEBUG) console.log(JSON.stringify(ran, null, 1))
    // Opened again, so it reads the results just recorded.
    await page.keyboard.press('Escape')
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await page.waitForSelector('.palette-input', { timeout: 5000 })
    await page.type('.palette-input', 'comparisons')
    await sleep(200)
    await page.keyboard.press('Enter')
    await page.waitForSelector('.compare-attempt[data-attempt="a"] .compare-exit', { timeout: 15000 })
    await page.waitForSelector('.compare-attempt[data-attempt="b"] [data-side="uncommitted"] .compare-file', { timeout: 15000 })
    await page.click('.compare-attempt[data-attempt="b"] [data-side="uncommitted"] .compare-file')
    await page.waitForSelector('.compare-attempt[data-attempt="b"] .compare-diff', { timeout: 15000 })
    await sleep(500)
  },
  // Removing attempt A, which has an uncommitted note and an ignored env file: the second confirmation lists both.
  'compare-remove': async (page) => {
    await scenes.compare(page)
    const a = await page.evaluate(async () => (await window.patchbayCompare.list((await window.patchbay.getDoc()).activeProjectId))[0].attempts[0].path)
    fs.writeFileSync(path.join(a, '.gitignore'), '.env.local\n')
    fs.writeFileSync(path.join(a, '.env.local'), 'API_URL=http://localhost:3000\n')
    await page.click('[data-remove="a"]')
    await page.waitForSelector('.compare-remove .btn-danger', { timeout: 5000 })
    await page.click('.compare-remove .btn-danger')
    await page.waitForSelector('.compare-loss', { timeout: 15000 })
    await page.evaluate(() => document.querySelector('.compare-remove').scrollIntoView({ block: 'center' }))
    await sleep(400)
  }
}

module.exports = { scenes, seeds: { compare: seedCompare, 'compare-start': seedCompare, 'compare-remove': seedCompare } }
