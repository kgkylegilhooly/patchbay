'use strict'
// The focus view on the real app: windows in split panes, split and close panes, choose what a pane shows, drag a
// divider, keep typing in a terminal there, and come back to the same layout. Terminals only, so no quota.
// `node focusview.cjs before` only takes a picture of the canvas in the packaged build. Run after npm run build.
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const before = process.argv[2] === 'before'
const c = L.checker()
U.watchdog(3 * 60_000)

/**
 * What the shell printed, without its escape sequences. Bash wraps each command in bracketed-paste switches, and whether
 * one lands between a line break and the command's output varies, so matching the raw text failed now and then.
 */
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
const shown = async (page, id) => plain(await L.snapshot(page, id))
/** A UI change, waited for rather than slept on: a busy machine draws later. Gives back what it waited for, or null. */
const until = (what, fn, ms = 10000) => L.waitFor(what, fn, ms, 100).catch(() => null)
const panes = (page) => page.$$eval('[data-focus-pane]', (ps) => ps.map((p) => ({ id: p.dataset.focusPane, shows: p.querySelector('select').value, card: !!p.querySelector('.unit-in-pane') })))

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const cwd = L.workDir('focusview')
  const app = await L.launch({ profile, exe: before ? L.packagedExe : undefined })
  const page = app.page
  try {
    for (const [i, id] of ['one', 'two', 'three'].entries()) await L.openNode(page, L.terminal(id, cwd, i * 520, 0))
    await L.waitFor('the shells', async () => (await Promise.all(['one', 'two', 'three'].map((id) => L.snapshot(page, id)))).every((s) => s.length > 0), 60000)
    await L.fitView(page)
    if (before) {
      console.log('SHOT', await L.shot(page, 'focusview-before'))
      return
    }

    await page.click('.dock [data-cmd="toggle-focus"]')
    await page.waitForSelector('.focus-view', { timeout: 15000 })
    await until('the panes', async () => (await panes(page)).filter((p) => p.card).length === 3)
    let now = await panes(page)
    c.check('The focus view puts the windows in panes', JSON.stringify(now.map((p) => p.shows)) === JSON.stringify(['one', 'two', 'three']) && now.every((p) => p.card), now)
    console.log('SHOT', await L.shot(page, 'focusview-after-open'))

    await page.click('[data-focus-pane="a"] .xterm-screen')
    await page.keyboard.type('echo in-a-pane')
    await page.keyboard.press('Enter')
    // The command's output, alone on its line. The echoed command itself can come back with redraws inside it.
    const typed = await L.waitFor('the echo', async () => /[\r\n]in-a-pane\r?\n/.test(await shown(page, 'one')), 30000).catch(() => false)
    c.check('A terminal in a pane takes typing as usual', !!typed, typed ? undefined : JSON.stringify((await L.snapshot(page, 'one')).slice(-300)))

    // Leaving and opening the view resizes every terminal, and Git Bash used to drop the first key typed after that.
    // Typing at once, several times over, nothing is lost, and the byte that guards against it never shows.
    for (let i = 0; i < 6; i++) {
      await page.click('.focus-view [data-focus="leave"]')
      await L.sleep(250)
      await page.click('.dock [data-cmd="toggle-focus"]')
      await page.waitForSelector('[data-focus-pane="a"] .xterm-screen', { timeout: 15000 })
      await L.sleep(150)
      await page.click('[data-focus-pane="a"] .xterm-screen')
      await page.keyboard.type(`echo first-key-${i}`)
      await page.keyboard.press('Enter')
      await L.sleep(500)
    }
    const after = await L.waitFor('the echoes', async () => {
      const s = await shown(page, 'one')
      return (s.match(/\r?\nfirst-key-\d/g) ?? []).length >= 6 ? s : null
    }, 30000).catch(async () => shown(page, 'one'))
    const ran = new Set((after.match(/(?<=[\r\n])first-key-\d(?=\r?\n)/g) ?? []))
    c.check('The first key typed after a resize is never lost', !/command not found/.test(after) && ran.size === 6, { ran: [...ran], lost: after.match(/[^\r\n]{0,8}cho first-key-\d[^\r\n]*\r?\n[^\r\n]*/g)?.filter((l) => /not found/.test(l)) })
    c.check('The guard byte never shows on screen', !/\^@/.test((await L.screen(page, 'one')).join('\n')))

    await page.click('[data-focus-pane="a"] [data-focus="split-down"]')
    await until('the new pane', async () => (await panes(page)).length === 4)
    now = await panes(page)
    c.check('Split down adds an empty pane under it', now.length === 4 && now[1].shows === '', now)
    await page.select('[data-focus-pane="ab"] select', 'three')
    await until('the window to move', async () => (await panes(page))[1]?.shows === 'three')
    now = await panes(page)
    c.check('Choosing a window for a pane moves it there', now[1].shows === 'three' && now.filter((p) => p.shows === 'three').length === 1, now)

    const width = () => page.$eval('[data-focus-pane="aa"]', (p) => p.getBoundingClientRect().width)
    const w1 = await width()
    const bar = await (await page.$('[data-focus-divider="root"]')).boundingBox()
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(bar.x + 200, bar.y + bar.height / 2, { steps: 6 })
    await page.mouse.up()
    await until('the panes to resize', async () => (await width()) > w1 + 120)
    const w2 = await width()
    c.check('Dragging a divider resizes the panes', w2 > w1 + 120, { w1, w2 })
    console.log('SHOT', await L.shot(page, 'focusview-after-split'))

    await page.click('[data-focus-pane="bb"] [data-focus="close-pane"]')
    await until('the pane to close', async () => (await panes(page)).length === 3)
    now = await panes(page)
    c.check('Closing a pane gives its space to the others', now.length === 3 && now.some((p) => p.id === 'b' && p.shows === 'two'), now)

    // Which pane has the keyboard, and moving it with Ctrl+Shift+arrows by where the panes are on screen.
    const typingIn = () => page.evaluate(() => document.activeElement?.closest('[data-focus-pane]')?.dataset.focusPane ?? null)
    const edge = (id) => page.$eval(`[data-focus-pane="${id}"]`, (p) => getComputedStyle(p).borderTopColor)
    await page.click('[data-focus-pane="aa"] .xterm-screen')
    await until('the keyboard in the pane', async () => (await typingIn()) === 'aa')
    c.check('The pane being typed in is marked out from the others', (await edge('aa')) !== (await edge('b')), { typing: await edge('aa'), other: await edge('b') })
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    const right = await typingIn()
    await page.keyboard.press('ArrowLeft')
    const left = await typingIn()
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')
    c.check('Ctrl+Shift+Right and Left move the keyboard between panes on screen', right === 'b' && left?.startsWith('a'), { right, left })

    // An empty pane offers the windows that aren't in the view, one click each.
    await page.click('[data-focus-pane="ab"] [data-focus="close-pane"]')
    await until('the pane to close', async () => !(await page.$('[data-focus-pane="ab"]')))
    await page.click('[data-focus-pane="b"] [data-focus="split-down"]')
    await until('the empty pane', () => page.$('[data-focus-pane="bb"] [data-focus-choice]'))
    const offered = await page.$$eval('[data-focus-pane="bb"] [data-focus-choice]', (bs) => bs.map((b) => b.dataset.focusChoice))
    c.check('An empty pane lists the windows not in the view', JSON.stringify(offered) === '["three"]', offered)
    console.log('SHOT', await L.shot(page, 'focusview-empty-pane'))
    await page.click('[data-focus-pane="bb"] [data-focus-choice="three"]')
    await until('it to show there', async () => (await panes(page)).find((p) => p.id === 'bb')?.shows === 'three' && (await typingIn()) === 'bb')
    now = await panes(page)
    c.check('Choosing one shows it there and gives it the keyboard', now.find((p) => p.id === 'bb')?.shows === 'three' && (await typingIn()) === 'bb', { now, typing: await typingIn() })

    // The sidebar, while the view covers the canvas, brings a window to a pane rather than centering the hidden canvas.
    await page.click('[data-focus-pane="bb"] [data-focus="close-pane"]')
    await until('the pane to close', async () => !(await page.$('[data-focus-pane="bb"]')))
    if (!(await page.$('.sidebar [data-session="three"]'))) await page.click('.dock [data-cmd="toggle-sidebar"]').catch(() => {})
    await page.click('[data-session="three"]')
    await until('it in a pane with the keyboard', async () => (await panes(page)).find((p) => p.shows === 'three')?.id === (await typingIn()))
    now = await panes(page)
    c.check('Clicking a session in the sidebar puts it in a pane, ready to type in', now.some((p) => p.shows === 'three') && now.find((p) => p.shows === 'three')?.id === (await typingIn()), { now, typing: await typingIn() })
    console.log('SHOT', await L.shot(page, 'focusview-after-sidebar'))

    await page.click('[data-focus="leave"]')
    await until('the windows back on the canvas', async () => (await page.$$eval('.react-flow__node .unit', (us) => us.length)) === 3 && !(await page.$('.focus-view')))
    const back = await page.$$eval('.react-flow__node .unit', (us) => us.length)
    c.check('Back to canvas puts every window back on it', back === 3 && !(await page.$('.focus-view')), back)

    await page.click('.dock [data-cmd="toggle-focus"]')
    await page.waitForSelector('.focus-view', { timeout: 15000 })
    await until('the same layout', async () => JSON.stringify((await panes(page)).map((p) => p.id)) === JSON.stringify(now.map((p) => p.id)))
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
