'use strict'
// Terminals kept across project switches, maximize and the overview (perf-terminals): the same terminal comes back with
// its scrollback, takes keys, finds text, selects, resizes, follows a font change, and catches up on what it printed
// while away. Quiet window, throwaway profile, plain shells only.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

if (require.main === module) U.watchdog(6 * 60_000)
const { check, finish } = L.checker()
const shots = process.env.SHOTS
const sel = U.nodeSel

function canvas(cwd) {
  const t = (id, x, y, projectId) => ({ id, kind: 'terminal', title: id, x, y, width: 520, height: 320, parentId: null, cwd, projectId })
  return {
    version: 3,
    projects: [
      { id: 'p1', name: 'One', folder: cwd, viewport: { x: 40, y: 40, zoom: 0.9 } },
      { id: 'p2', name: 'Two', folder: cwd, viewport: { x: 40, y: 40, zoom: 0.9 } },
      // Never drawn before the reveal check: many terminals to build, and the one asked for off-screen at its view.
      { id: 'p3', name: 'Three', folder: cwd, viewport: { x: 40, y: 40, zoom: 0.9 } }
    ],
    activeProjectId: 'p1',
    viewport: { x: 40, y: 40, zoom: 0.9 },
    edges: [],
    closed: [],
    // Clear of the sessions sidebar on the left, so a click lands on the terminal.
    nodes: [
      t('a', 380, 0, 'p1'),
      t('b', 940, 0, 'p1'),
      t('c', 380, 0, 'p2'),
      ...Array.from({ length: 12 }, (_, i) => t(`p3t${i}`, 380 + (i % 4) * 560, Math.floor(i / 4) * 360, 'p3')),
      t('p3far', 8000, 3000, 'p3')
    ]
  }
}

const mark = (page, id) => page.$eval(`${sel(id)} .xterm`, (el) => (el.dataset.mark = 'kept'))
const marked = (page, id) => page.$eval(`${sel(id)} .xterm, .unit-maximized .xterm`, (el) => el.dataset.mark === 'kept').catch(() => false)
const rowsText = (page, id) => page.$eval(`${sel(id)} .xterm-rows`, (r) => r.textContent).catch(() => '')
/** Switches project and waits for one of its terminals to be drawn: a busy machine takes longer than any fixed pause. */
const switchTo = async (page, id, shows) => {
  await page.evaluate((p) => window.patchbay.dispatch({ op: 'switchProject', id: p }), id)
  await L.waitFor(`project ${id} on show`, async () => (await L.doc(page)).activeProjectId === id && !!(await page.$(`${sel(shows)} .xterm`)), 30000, 100)
}
const tier = (page) => page.$eval('.react-flow', (f) => f.dataset.zoomTier)
const transform = (page) => page.$eval('.react-flow__viewport', (v) => v.style.transform)
const zoomTo = async (page, want, cmd) => {
  for (let i = 0; i < 25 && (await tier(page)) !== want; i++) {
    const was = await transform(page)
    await page.click(`.dock [data-cmd="${cmd}"]`)
    // Each step's animation (160 ms) is waited out, however slow the frames: a click during one starts the next step
    // from part of the way, so the steps ran out before the overview on a busy machine.
    await L.waitFor('the zoom to change', async () => (await transform(page)) !== was, 3000, 50).catch(() => {})
    let last = await transform(page)
    await L.waitFor('the zoom to settle', async () => {
      await L.sleep(120)
      const now = await transform(page)
      const still = now === last
      last = now
      return still
    }, 5000, 0).catch(() => {})
  }
}
/**
 * Clicks a window's tool button once it's inside the window. Node b's buttons sat a few pixels past the right edge of
 * the 1280-px window: Puppeteer then scrolled the canvas to reach them, which under load failed with "Node is either
 * not clickable or not an Element". The view is fitted first, so the button is really there to click.
 */
async function clickTool(page, id, tool) {
  const button = `${sel(id)} [data-tool="${tool}"]`
  const inside = () =>
    page.$eval(button, (b) => {
      const r = b.getBoundingClientRect()
      return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    }).catch(() => false)
  if (!(await inside())) await L.fitView(page)
  await L.waitFor(`${id}'s ${tool} button inside the window`, inside, 10000, 100)
  await page.click(button)
}
const print = (page, id, text) => L.input(page, id, `node -e "for(let i=1;i<=200;i++)console.log('${text}'+i)"\r`)

async function main() {
  const cwd = L.workDir('termshelf')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(canvas(cwd)))
  const app = await L.launch({ profile })
  const { page } = app
  const step = U.stepper(check)
  try {
    await L.waitFor('the shells', async () => (await Promise.all(['a', 'b'].map((id) => rowsText(page, id)))).every((t) => /[$>]/.test(t)), 90000)
    await print(page, 'a', 'line')
    await L.waitFor('a to print', async () => (await rowsText(page, 'a')).includes('line200'), 60000)
    await mark(page, 'a')

    await step('a project switch keeps the terminal', async () => {
      await switchTo(page, 'p2', 'c')
      await L.waitFor('c to show its shell', async () => /[$>]/.test(await rowsText(page, 'c')), 60000)
      check('the other project draws its own terminal', true)
      // b prints while its project isn't on show.
      await print(page, 'b', 'away')
      await L.sleep(1500)
      await switchTo(page, 'p1', 'a')
      check('coming back, the same terminal is drawn, not a new one', await marked(page, 'a'))
      check('its screen is there at once', (await rowsText(page, 'a')).includes('line200'))
      await L.waitFor('b to show what it printed while away', async () => (await rowsText(page, 'b')).includes('away200'), 30000).then(
        () => check('a terminal catches up on what it printed while its project was away', true),
        (e) => check('a terminal catches up on what it printed while its project was away', false, e.message)
      )
    })

    await step('scrollback, find and selection', async () => {
      await U.focusTerminal(page, 'a')
      await U.chord(page, 'ctrl', 'KeyF')
      await page.waitForSelector(`${sel('a')} .find input`, { timeout: 3000 })
      await page.keyboard.type('line1')
      const countNow = () => page.$eval(`${sel('a')} .find-count`, (o) => o.textContent).catch(() => '')
      await L.waitFor('the matches to be counted', async () => /of 1\d\d|1\d\d\+? matches/.test(await countNow()), 10000, 100).catch(() => {})
      const count = await countNow()
      // line1, line10-19 and line100-199: 111 in all, nearly all scrolled out of view.
      const found = Number(/of (\d+)|(\d+)\+? matches/.exec(count)?.slice(1).find(Boolean))
      check('the scrollback is kept, and find searches it', found >= 100, count)
      await page.keyboard.press('Escape')
      await L.sleep(200)
      const box = await page.$eval(`${sel('a')} .xterm-screen`, (s) => {
        const r = s.getBoundingClientRect()
        return { x: r.left + 10, y: r.top + 20, w: r.width }
      })
      await page.mouse.move(box.x, box.y)
      await page.mouse.down()
      await page.mouse.move(box.x + box.w / 2, box.y + 40, { steps: 6 })
      await page.mouse.up()
      await L.waitFor('a selection', () => page.evaluate(() => !!window.getSelection()?.toString() || document.querySelectorAll('.xterm-selection div').length > 0), 5000, 100).catch(() => {})
      const selected = await page.evaluate(() => window.getSelection()?.toString() || document.querySelectorAll('.xterm-selection div').length)
      check('a drag selects text', !!selected, selected)
    })

    await step('typing', async () => {
      await U.focusTerminal(page, 'a')
      await U.typeLine(page, 'echo typed-ok')
      await L.waitFor('the echo', async () => (await rowsText(page, 'a')).includes('typed-ok'), 30000)
      check('keys reach the kept terminal and it echoes', true)
    })

    await step('resize and font', async () => {
      const before = await page.$eval(`${sel('a')} .xterm-screen`, (s) => s.offsetWidth)
      await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 'a', patch: { width: 700 } }))
      await L.waitFor('a wider screen', async () => (await page.$eval(`${sel('a')} .xterm-screen`, (s) => s.offsetWidth)) > before + 100, 15000)
      check('a resize refits the kept terminal', true)
      const font = await U.fontSizeOf(page, 'a')
      await U.focusTerminal(page, 'a')
      await U.chord(page, 'ctrl+shift', 'Equal')
      await L.waitFor('a larger font', async () => (await U.fontSizeOf(page, 'a')) > font, 10000)
      check('a font change applies', true)
    })

    await step('maximize', async () => {
      await clickTool(page, 'b', 'maximize')
      await page.waitForSelector('.unit-maximized .xterm', { timeout: 15000 })
      await mark(page, 'b').catch(() => {})
      const text = await page.$eval('.unit-maximized .xterm-rows', (r) => r.textContent)
      check('maximized, the terminal keeps its screen', text.includes('away'), text.slice(0, 60))
      if (shots) await page.screenshot({ path: path.join(shots, 'termshelf-maximized.png') })
      await page.keyboard.press('F11')
      const restored = () => page.$('.unit-maximized').then((m) => !m)
      await L.waitFor('F11 to restore it', restored, 5000, 100).catch(() => {})
      if (!(await restored())) await page.click('.unit-maximized [data-tool="maximize"]').catch(() => {})
      // Back on the canvas and drawn there, which takes a frame or two more.
      await L.waitFor('it to be restored', async () => (await restored()) && (await rowsText(page, 'b')).includes('away'), 10000, 100).catch(() => {})
      check('restored, it is back on the canvas', !(await page.$('.unit-maximized')) && (await rowsText(page, 'b')).includes('away'))
    })

    await step('reveal in a project not drawn yet', async () => {
      await page.$eval('[data-session="p3far"]', (el) => el.scrollIntoView({ block: 'center' }))
      await page.click('[data-session="p3far"]')
      await L.waitFor('p3far to have the keyboard', () => page.evaluate(() => document.activeElement?.closest('.react-flow__node')?.dataset.id === 'p3far'), 20000).then(
        () => check('revealing a session in a project not drawn yet gives its terminal the keyboard', true),
        async () => check('revealing a session in a project not drawn yet gives its terminal the keyboard', false, await page.evaluate(() => document.activeElement?.className))
      )
      await switchTo(page, 'p1', 'a')
    })

    await step('overview', async () => {
      await zoomTo(page, 'overview', 'zoom-out')
      check('zoomed out to the overview', (await tier(page)) === 'overview')
      await L.input(page, 'b', 'echo while-overview\r')
      await L.sleep(1500)
      if (shots) await page.screenshot({ path: path.join(shots, 'termshelf-overview.png') })
      await zoomTo(page, 'near', 'zoom-in')
      await L.fitView(page)
      await L.waitFor('b to show what it printed in the overview', async () => (await rowsText(page, 'b')).includes('while-overview'), 20000)
      check('back from the overview, a terminal shows what it printed there', true)
    })
    if (shots) await page.screenshot({ path: path.join(shots, 'termshelf-end.png') })
    const problems = app.problems.filter((p) => !/ResizeObserver/.test(p))
    check('no page errors', problems.length === 0, problems.slice(0, 3))
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  finish()
}

if (require.main === module) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
