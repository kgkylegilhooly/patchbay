'use strict'
// The focus view on the real app: windows in split panes, split and close panes, choose what a pane shows, drag a
// divider, keep typing in a terminal there, and come back to the same layout. Terminals only, so no quota.
// `node focusview.cjs before` only takes a picture of the canvas in the packaged build. Run after npm run build.
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const before = process.argv[2] === 'before'
const c = L.checker()
U.watchdog(3 * 60_000)

const panes = (page) => page.$$eval('[data-focus-pane]', (ps) => ps.map((p) => ({ id: p.dataset.focusPane, shows: p.querySelector('select').value, card: !!p.querySelector('.unit-in-pane') })))

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const cwd = L.workDir('focusview')
  const app = await L.launch({ profile, exe: before ? L.packagedExe : undefined })
  const page = app.page
  try {
    for (const [i, id] of ['one', 'two', 'three'].entries()) await L.openNode(page, L.terminal(id, cwd, i * 520, 0))
    await L.waitFor('the shells', async () => (await Promise.all(['one', 'two', 'three'].map((id) => L.snapshot(page, id)))).every((s) => s.length > 0), 20000)
    await L.fitView(page)
    if (before) {
      console.log('SHOT', await L.shot(page, 'focusview-before'))
      return
    }

    await page.click('.dock [data-cmd="toggle-focus"]')
    await page.waitForSelector('.focus-view', { timeout: 5000 })
    await L.sleep(500)
    let now = await panes(page)
    c.check('The focus view puts the windows in panes', JSON.stringify(now.map((p) => p.shows)) === JSON.stringify(['one', 'two', 'three']) && now.every((p) => p.card), now)
    console.log('SHOT', await L.shot(page, 'focusview-after-open'))

    await page.click('[data-focus-pane="a"] .xterm-screen')
    await page.keyboard.type('echo in-a-pane')
    await page.keyboard.press('Enter')
    const typed = await L.waitFor('the echo', async () => ((await L.snapshot(page, 'one')).match(/in-a-pane/g) ?? []).length >= 2, 8000).catch(() => false)
    c.check('A terminal in a pane takes typing as usual', !!typed)

    await page.click('[data-focus-pane="a"] [data-focus="split-down"]')
    await L.sleep(300)
    now = await panes(page)
    c.check('Split down adds an empty pane under it', now.length === 4 && now[1].shows === '', now)
    await page.select('[data-focus-pane="ab"] select', 'three')
    await L.sleep(300)
    now = await panes(page)
    c.check('Choosing a window for a pane moves it there', now[1].shows === 'three' && now.filter((p) => p.shows === 'three').length === 1, now)

    const width = () => page.$eval('[data-focus-pane="aa"]', (p) => p.getBoundingClientRect().width)
    const w1 = await width()
    const bar = await (await page.$('[data-focus-divider="root"]')).boundingBox()
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(bar.x + 200, bar.y + bar.height / 2, { steps: 6 })
    await page.mouse.up()
    await L.sleep(300)
    const w2 = await width()
    c.check('Dragging a divider resizes the panes', w2 > w1 + 120, { w1, w2 })
    console.log('SHOT', await L.shot(page, 'focusview-after-split'))

    await page.click('[data-focus-pane="bb"] [data-focus="close-pane"]')
    await L.sleep(300)
    now = await panes(page)
    c.check('Closing a pane gives its space to the others', now.length === 3 && now.some((p) => p.id === 'b' && p.shows === 'two'), now)

    await page.click('[data-focus="leave"]')
    await L.sleep(500)
    const back = await page.$$eval('.react-flow__node .unit', (us) => us.length)
    c.check('Back to canvas puts every window back on it', back === 3 && !(await page.$('.focus-view')), back)

    await page.click('.dock [data-cmd="toggle-focus"]')
    await page.waitForSelector('.focus-view', { timeout: 5000 })
    await L.sleep(300)
    const again = await panes(page)
    c.check('Opening it again brings back the same layout', JSON.stringify(again.map((p) => p.id)) === JSON.stringify(now.map((p) => p.id)), again)
    const still = await L.snapshot(page, 'one')
    c.check('The sessions kept running through all of it', /in-a-pane/.test(still))
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
