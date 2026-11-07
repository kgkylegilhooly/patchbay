'use strict'
// Milestone 6's new settings on the real app: terminal font, cursor, copy on select, scrollback, the scroll wheel and
// the default agent. They apply to open windows straight away. No quota. `node settings6.cjs before` only takes a
// picture of the Terminals section in the packaged build, for comparison. Run after npm run build.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const before = process.argv[2] === 'before'
const c = L.checker()

async function openSection(page, section) {
  await page.evaluate(() => [...document.querySelectorAll('.bar button')].find((b) => b.textContent.trim() === 'Settings').click())
  await page.click('[data-cmd="open-settings"]')
  await page.waitForSelector('.settings')
  await page.click(`[data-section="${section}"]`)
  await L.sleep(200)
}

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const cwd = L.workDir('settings6')
  const app = await L.launch({ profile, exe: before ? L.packagedExe : undefined })
  const page = app.page
  try {
    await L.openNode(page, L.terminal('t', cwd, 0, 0))
    await L.waitFor('the shell', () => L.snapshot(page, 't').then((s) => s.length > 0), 20000)
    await openSection(page, 'terminals')
    if (before) {
      console.log('SHOT', await L.shot(page, 'settings6-before'))
      return
    }
    console.log('SHOT', await L.shot(page, 'settings6-after-terminals'))
    await page.type('#set-font-family', 'Consolas')
    await page.select('#set-cursor-style', 'bar')
    await page.click('#set-cursor-blink')
    await page.click('#set-copy-select')
    await page.focus('#set-scrollback')
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.type('#set-scrollback', '25000')
    await page.click('#set-copy-select') // leaves the field, so its value applies
    await page.click('#set-copy-select')
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('patchbay.prefs')).terminal)
    c.check('Terminal settings are saved', prefs.fontFamily === 'Consolas' && prefs.cursorStyle === 'bar' && prefs.cursorBlink && prefs.copyOnSelect && prefs.scrollback === 25000, prefs)
    await page.keyboard.press('Escape')
    await L.sleep(400)
    const font = await page.$eval('.react-flow__node[data-id="t"] .xterm-rows', (r) => getComputedStyle(r).fontFamily)
    c.check('An open terminal takes the new font straight away', /^"?Consolas/.test(font), font)
    // xterm draws the chosen cursor while the terminal has the keyboard.
    await page.click('.react-flow__node[data-id="t"] .xterm-screen')
    await L.sleep(300)
    const cursor = await page.$eval('.react-flow__node[data-id="t"] .xterm', (x) => [...x.querySelectorAll('[class*="xterm-cursor-"]')].map((e) => e.className).join(' ') + ' ' + x.className)
    c.check('And the bar cursor', /cursor-bar/.test(cursor), cursor)

    await openSection(page, 'canvas')
    await page.select('#set-wheel', 'pan')
    await openSection(page, 'claude')
    await page.select('#defaultAgent', 'codex')
    await page.evaluate(() => [...document.querySelectorAll('.settings button')].find((b) => /^Save/.test(b.textContent.trim()))?.click())
    await L.sleep(600)
    const wheel = await page.evaluate(() => JSON.parse(localStorage.getItem('patchbay.prefs')).wheel)
    c.check('The scroll wheel choice is saved', wheel === 'pan', wheel)
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'))
    c.check('The default agent is saved to settings.json', saved.defaultAgent === 'codex', saved)
    console.log('SHOT', await L.shot(page, 'settings6-after-agents'))
    await page.keyboard.press('Escape')

    // Panning with the wheel: the view moves and the zoom stays.
    const pane = await page.$eval('.react-flow__pane', (p) => {
      const r = p.getBoundingClientRect()
      // Clear of the minimap in the corner, which zooms on the wheel whatever this says.
      return { x: r.right - 150, y: r.top + 120 }
    })
    const at = await page.$eval('.react-flow__viewport', (v) => v.style.transform)
    await page.mouse.move(pane.x, pane.y)
    await page.mouse.wheel({ deltaY: 300 })
    await L.sleep(500)
    const after = await page.$eval('.react-flow__viewport', (v) => v.style.transform)
    const scale = (t) => /scale\(([\d.]+)\)/.exec(t)?.[1]
    c.check('With Moves the canvas, the wheel pans and leaves the zoom alone', after !== at && scale(after) === scale(at), { at, after })
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
