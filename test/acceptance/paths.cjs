'use strict'
// Clicking a path printed in a terminal: it opens a menu to open it, start a terminal in its folder, copy it, or show it
// in File Explorer. Show in File Explorer isn't clicked, since it would open a window on the desktop of whoever runs this.
// Run after npm run build. `node paths.cjs before` only hovers a path in the packaged build, for a before picture.
const fs = require('fs')
const path = require('path')
const L = require('./lib.cjs')

const before = process.argv[2] === 'before'
const c = L.checker()

async function pathRow(page, id, text) {
  return L.waitFor(`${text} on screen`, () =>
    page.evaluate(
      (i, t) => {
        const rows = [...document.querySelectorAll(`.react-flow__node[data-id="${i}"] .xterm-rows > div`)]
        const row = rows.find((r) => r.textContent.replace(/ /g, ' ').trimEnd() === t)
        if (!row) return null
        const box = row.getBoundingClientRect()
        return { x: box.left + 24, y: box.top + box.height / 2 }
      },
      id,
      text
    ),
    15000
  )
}

async function openMenu(page, at) {
  await page.mouse.move(at.x - 40, at.y)
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await L.sleep(300)
  await page.mouse.click(at.x, at.y)
  await page.waitForSelector('.menu-panel[aria-label="notes/a.txt"]', { timeout: 5000 })
}

async function main() {
  const profile = L.newProfile()
  const cwd = L.workDir('paths')
  fs.mkdirSync(path.join(cwd, 'notes'))
  fs.writeFileSync(path.join(cwd, 'notes', 'a.txt'), 'hello\n')
  const app = await L.launch({ profile, exe: before ? L.packagedExe : undefined })
  const page = app.page
  try {
    await L.openNode(page, L.terminal('t', cwd, 0, 0, { width: 620, height: 340 }))
    await L.fitView(page)
    await L.sleep(1500)
    await L.submit(page, 't', 'echo notes/a.txt')
    const at = await pathRow(page, 't', 'notes/a.txt')

    if (before) {
      await page.mouse.move(at.x - 40, at.y)
      await page.mouse.move(at.x, at.y, { steps: 4 })
      await L.sleep(400)
      console.log('SHOT', await L.shot(page, 'paths-before'))
      return
    }

    await openMenu(page, at)
    const labels = await page.$$eval('.menu-panel .menu-label', (ls) => ls.map((l) => l.textContent))
    c.check('Clicking a path opens its menu', JSON.stringify(labels) === JSON.stringify(['Open', 'New terminal here', 'Copy path', 'Show in File Explorer']), labels)
    console.log('SHOT', await L.shot(page, 'paths-after-menu'))

    await page.click('[data-cmd="path-copy"]')
    const want = path.join(cwd, 'notes', 'a.txt')
    const copied = await L.waitFor('the copied path', () => page.evaluate(() => navigator.clipboard.readText()).then((t) => (t === want ? t : null)), 5000).catch((e) => e.message)
    c.check('Copy path copies the full path', copied === want, copied)

    await openMenu(page, at)
    await page.click('[data-cmd="path-new-terminal"]')
    const opened = await L.waitFor('the new terminal', async () => (await L.doc(page)).nodes.find((n) => n.kind === 'terminal' && n.id !== 't'), 10000).catch(() => null)
    c.check('New terminal here opens a terminal in the folder holding the file', opened?.cwd === path.join(cwd, 'notes'), opened?.cwd)
    const running = await L.waitFor('its shell prompt', async () => (await L.snapshot(page, opened.id)).includes('notes'), 15000).catch(() => false)
    c.check('And starts it', !!running)
    c.check('The canvas stays in view', !(await page.$('.board')))
    await L.sleep(800)
    console.log('SHOT', await L.shot(page, 'paths-after-terminal'))

    const revealed = await page.evaluate(() => window.patchbay.resolveTerminalPath('t', 'notes/missing.txt'))
    c.check('A path that is gone says so', revealed.ok === false && /not found/i.test(revealed.reason), revealed)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  if (!before) c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
