'use strict'
// Screenshot scene for the files each session edited: `node screenshot.js <out.png> --scene files-touched`.
// The project folder is a small git repository. Three fake agents (fake-claude.cjs, no quota) each run one turn that
// edits files there; two of them edit the same file, so it shows as shared.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Scene', '-c', 'user.email=scene@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore', windowsHide: true })

function seedFiles(doc) {
  const repo = path.join(doc.projects[0].folder, 'shop')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'cart.ts'), 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n')
  fs.writeFileSync(path.join(repo, 'src', 'login.ts'), 'export const login = () => true\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Shop')
  doc.projects[0].folder = repo
  doc.nodes = doc.nodes.filter((n) => n.id === 'term' || n.projectId === 'p2')
  const agent = (id, title, x, y, prompt) => ({ id, kind: 'claude', title, x, y, width: 560, height: 300, parentId: null, cwd: repo, prompt, sessionId: null, transcriptPath: null, after: [], projectId: 'p1' })
  doc.nodes.find((n) => n.id === 'term').cwd = repo
  doc.nodes.find((n) => n.id === 'term').x = 1240
  doc.nodes.push(
    agent('cart', 'Fix cart totals', 0, 0, 'edits=src/cart.ts,src/money.ts,test/cart.test.ts'),
    agent('login', 'Login redirect', 620, 0, 'edits=src/login.ts,src/cart.ts,?src/session.ts'),
    agent('docs', 'Update the README', 0, 340, 'edits=README.md')
  )
  doc.viewport = { x: 60, y: 60, zoom: 0.85 }
  doc.projects[0].viewport = doc.viewport
}

const scenes = {
  'files-touched': async (page) => {
    // Each fake turn waits 2.5 s, then edits. Only drawn once this feature is there.
    const chip = await page.waitForSelector('[data-files-chip="login"]', { timeout: 20000 }).catch(() => null)
    if (!chip) return
    await page.waitForFunction(() => document.querySelector('[data-files-chip="login"]')?.textContent.includes('shared'), { timeout: 10000 }).catch(() => {})
    await chip.click()
    await page.waitForSelector('.files-popover .files-row', { timeout: 10000 })
    await sleep(300)
    const diff = await page.$('.files-popover .files-row-shared [data-diff]')
    if (diff) {
      await diff.click()
      await page.waitForSelector('.files-popover .files-diff-text, .files-popover .files-problem', { timeout: 15000 }).catch(() => {})
    }
    await sleep(300)
  }
}

module.exports = { scenes, seeds: { 'files-touched': seedFiles } }
