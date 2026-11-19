'use strict'
// Screenshot scenes for file icons and the Files shelf:
//   node screenshot.js <out.png> --scene files        icons on the canvas, one of them missing
//   node screenshot.js <out.png> --scene file-shelf   the same, with the shelf open
// The files are made in the scene's own throwaway folder, which screenshot.js removes afterwards.
const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FILES = ['Q3 report.pdf', 'login-bug.png', 'résumé final.docx', 'notes.md', 'parser.ts', 'build.cmd', 'export.csv']

const seedFiles = (doc) => {
  const cwd = doc.projects[0].folder
  const dir = path.join(cwd, 'Shared files')
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true })
  for (const name of FILES) fs.writeFileSync(path.join(dir, name), 'x')
  const icon = (id, file, x, y, extra = {}) => ({ id, kind: 'file', title: path.basename(file), path: file, x, y, width: 120, height: 112, parentId: null, projectId: 'p1', ...extra })
  doc.nodes = doc.nodes.filter((n) => ['idle', 'term', 'note'].includes(n.id))
  Object.assign(doc.nodes.find((n) => n.id === 'idle'), { x: 0, y: 0 })
  Object.assign(doc.nodes.find((n) => n.id === 'term'), { x: 0, y: 360 })
  Object.assign(doc.nodes.find((n) => n.id === 'note'), { x: 1100, y: 330 })
  const at = (i) => ({ x: 620 + (i % 3) * 136, y: 20 + Math.floor(i / 3) * 128 })
  const paths = [...FILES.map((f) => path.join(dir, f)), path.join(dir, 'screenshots'), path.join(dir, 'old plan.md')]
  // For a "before" picture on a build without file icons, which would refuse a canvas holding them.
  if (process.env.PATCHBAY_SCENE_NO_FILES) return
  paths.forEach((p, i) => doc.nodes.push(icon(`file${i}`, p, at(i).x, at(i).y, i === 1 ? { openedBy: 'idle' } : {})))
  doc.edges = [{ id: 'e-file', from: 'idle', to: 'file1', kind: 'link' }]
  doc.viewport = { x: 60, y: 80, zoom: 0.9 }
  doc.projects[0].viewport = doc.viewport
}

/** What the shelf would have collected: pasted pictures, drops, pins and an evidence shot, over the last days. */
const seedShelf = (page) =>
  page.evaluate(async () => {
    const doc = await window.patchbay.getDoc()
    const files = doc.nodes.filter((n) => n.kind === 'file')
    const now = Date.now()
    const dir = files[0].path.replace(/[\\/][^\\/]+$/, '')
    const entries = [
      { path: files[0].path, source: 'drop', at: now - 3 * 60_000, nodeTitle: 'Review the docs' },
      { path: files[1].path, source: 'agent', at: now - 25 * 60_000, nodeTitle: 'Review the docs' },
      { path: `${dir}\\paste-1f3a.png`, source: 'paste', at: now - 2 * 3600_000, nodeTitle: 'Dev shell' },
      { path: files[2].path, source: 'drop', at: now - 5 * 3600_000 },
      { path: files[4].path, source: 'pin', at: now - 26 * 3600_000, nodeTitle: 'Dev shell' },
      { path: `${dir}\\screenshots\\checkout-step-2.png`, source: 'evidence', at: now - 30 * 3600_000, nodeTitle: 'Browser' },
      { path: files[3].path, source: 'drop', at: now - 3 * 86400_000 },
      { path: files[6].path, source: 'pin', at: now - 4 * 86400_000 },
      { path: files[8].path, source: 'drop', at: now - 6 * 86400_000 }
    ]
    await window.patchbayFileShelf.note(doc.activeProjectId, entries.reverse())
  })

const seeds = {
  files: seedFiles,
  'file-shelf': seedFiles,
  'file-drag': seedFiles,
  'file-menu': seedFiles
}

const center = (page, id) =>
  page.evaluate((id) => {
    const r = document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id)

const scenes = {
  // Drags "résumé final.docx" onto the terminal: its path is typed there, quoted for the shell, and the icon goes back.
  'file-drag': async (page) => {
    await page.evaluate(() => document.querySelector('.sidebar .icon-btn[aria-label*="Close"], .sidebar button[aria-label*="lose"]')?.click())
    await sleep(2500)
    const from = await center(page, 'file2')
    const to = await center(page, 'term')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12)
      await sleep(30)
    }
    await page.mouse.up()
    await sleep(1200)
  },
  'file-menu': async (page) => {
    const at = await center(page, 'file0')
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await sleep(400)
  },
  files: async (page) => {
    await sleep(600)
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="file0"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await sleep(300)
  },
  'file-shelf': async (page) => {
    await seedShelf(page)
    await page.evaluate(() => document.querySelector('.bar-files')?.click())
    await sleep(900)
  }
}

module.exports = { scenes, seeds }
