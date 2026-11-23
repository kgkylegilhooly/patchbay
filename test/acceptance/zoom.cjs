'use strict'
// Semantic zoom and the header ⋯ menu on the real app, with real shells and fake-claude (no quota).
// Zoomed out, headers become readable tiles and nothing in a window changes size; at full size the header keeps
// Find, Maximize, ⋯ and Close, and ⋯ (or Shift+F10) holds the rest.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { canvas } = require('./scenes.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)

/** Each session window's body size in its own layout pixels, which the canvas zoom doesn't change. */
const bodySizes = (page) =>
  page.$$eval('.react-flow__node', (nodes) =>
    Object.fromEntries(nodes.filter((n) => n.querySelector('.unit-head-session')).map((n) => {
      const b = n.querySelector('.unit-body')
      return [n.dataset.id, `${b.offsetWidth}x${b.offsetHeight}`]
    }))
  )
const tier = (page) => page.$eval('.react-flow', (f) => f.dataset.zoomTier)
const zoomTo = async (page, want) => {
  for (let i = 0; i < 20 && (await tier(page)) !== want; i++) {
    await page.click('.dock [data-cmd="zoom-out"]')
    await L.sleep(250)
  }
}
/** How tall a title draws on screen, in pixels. */
const titlePx = (page, id) =>
  page.$eval(`${U.nodeSel(id)} .unit-head .title`, (t) => {
    const canvas = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a
    const head = parseFloat(getComputedStyle(t.closest('.unit-head')).zoom) || 1
    return parseFloat(getComputedStyle(t).fontSize) * head * canvas
  })

async function main() {
  // The usual seeded canvas, at full size with the Backend group clear of the sessions sidebar.
  const { profile, cwd } = U.seeded('zoom')
  const doc = canvas(cwd)
  // An agent asking to run a command, below the group, for Approve and Deny at every zoom.
  doc.nodes.push({ ...doc.nodes.find((n) => n.id === 'idle'), id: 'asks', title: 'Ship the fix', x: 0, y: 760, prompt: 'permission' })
  doc.viewport = { x: 340, y: 60, zoom: 1 }
  doc.projects[0].viewport = doc.viewport
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const app = await L.launch({ profile })
  const page = app.page
  try {
    await L.waitFor('the shell', async () => /\$/.test(await L.snapshot(page, 'term')), 20000)
    await L.waitFor('the agents', async () => (await L.statusOf(page, 'needs')) === 'needs-you', 20000)
    c.check('At full size the canvas is near', (await tier(page)) === 'near')
    const tools = await page.$$eval(`${U.nodeSel('idle')} .unit-head [data-tool]`, (b) => b.map((x) => x.dataset.tool))
    c.check('The header keeps Find, Maximize, ⋯ and Close', JSON.stringify(tools) === JSON.stringify(['find', 'maximize', 'more', 'close']), tools)
    c.check('No folder is shown for a session in the project folder', !(await page.$(`${U.nodeSel('idle')} .unit-head .cwd`)))

    await page.click(`${U.nodeSel('needs')} [data-tool="more"]`)
    await page.waitForSelector('.menu-panel', { timeout: 3000 })
    const rows = await page.$$eval('.menu-panel [data-tool]', (r) => r.map((x) => x.dataset.tool))
    c.check('⋯ holds refresh, chat, name, text size and copy path', ['refresh', 'chat', 'name', 'font-size', 'copy-path'].every((t) => rows.includes(t)), rows)
    const was = await U.fontSizeOf(page, 'needs')
    await page.click('.menu-panel [data-tool="font-larger"]')
    await L.sleep(200)
    c.check('Stepping the size keeps the menu open', !!(await page.$('.menu-panel')) && (await U.fontSizeOf(page, 'needs')) === was + 1)
    await page.click('.menu-panel [data-tool="font-reset"]')
    await page.keyboard.press('Escape')
    await L.sleep(200)
    c.check('Esc closes it', !(await page.$('.menu-panel')))

    await page.focus(`${U.nodeSel('work')}`)
    await U.chord(page, 'shift', 'F10')
    c.check('Shift+F10 on a focused window opens its ⋯ menu', (await page.$eval(`${U.nodeSel('work')} [data-tool="more"]`, (b) => b.getAttribute('aria-expanded'))) === 'true')
    await U.chord(page, '', 'ArrowDown')
    c.check('The arrows move through it', !!(await page.$('.menu-panel .menu-item-active')))
    await page.keyboard.press('Escape')
    await L.sleep(200)

    await U.focusTerminal(page, 'work')
    await U.chord(page, 'shift', 'F10')
    c.check('Shift+F10 from inside the terminal opens it too', (await page.$eval(`${U.nodeSel('work')} [data-tool="more"]`, (b) => b.getAttribute('aria-expanded'))) === 'true')
    await page.click('.dock [data-cmd="zoom-out"]')
    await L.sleep(300)
    c.check('Zooming the view closes it, rather than leave it behind its button', !(await page.$('.menu-panel')))
    await page.click('.dock [data-cmd="zoom-out"]')
    await L.sleep(300)
    const mid = await page.$eval('.dock-zoom', (z) => z.textContent)
    c.check('Between 60% and 100% a window is left as it is, readable terminal and all', parseInt(mid, 10) >= 60 && (await tier(page)) === 'near', { mid, tier: await tier(page) })
    await page.click('.dock [data-cmd="zoom-reset"]')
    await L.sleep(400)

    await page.click(`${U.nodeSel('work')} .unit-head .title`)
    await L.sleep(200)
    await U.chord(page, 'ctrl', 'KeyK')
    await page.type('.palette-input', 'chat')
    await L.sleep(200)
    const offered = await page.$$eval('.palette-item .palette-label', (l) => Array.from(l, (x) => x.textContent))
    c.check('The palette offers the chat toggle, so it has a key path', offered.some((t) => /as a chat/.test(t)), offered)
    await page.keyboard.press('Escape')
    await L.sleep(200)

    const near = await bodySizes(page)
    const pty = await U.ptySize(page, 'term', 'near')
    // Between 85% and the far line the header strip draws larger in its own slot: step out through that band and
    // check, at each step, that no body and no terminal changed size.
    const band = []
    for (let i = 0; i < 20 && (await tier(page)) !== 'far'; i++) {
      await page.click('.dock [data-cmd="zoom-out"]')
      await L.sleep(300)
      const scaled = await page.$eval('.react-flow', (f) => 'headScaled' in f.dataset)
      if ((await tier(page)) !== 'near' || !scaled) continue
      const at = await page.$eval('.dock-zoom', (z) => z.textContent)
      band.push({ at, title: Math.round((await titlePx(page, 'needs')) * 10) / 10, bodies: JSON.stringify(await bodySizes(page)) === JSON.stringify(near), pty: (await U.ptySize(page, 'term', `band${i}`)) === pty })
    }
    c.check('Inside the near band the header grows, and at every step no body or terminal changed size', band.length >= 1 && band.every((b) => b.bodies && b.pty), band)
    c.check('And its title reads at about 11 px there, not 8 or 9', band.every((b) => b.title >= 10.5), band)
    c.check('Zoomed out, the canvas is far', (await tier(page)) === 'far', await tier(page))
    await L.waitFor('the approval', () => page.$(`${U.nodeSel('asks')} .strip-approval`), 20000)
    // Every window in view, which is still far out.
    await L.fitView(page)
    await L.sleep(500)
    const approve = await page.$eval(`${U.nodeSel('asks')} .strip-approval .btn-solid`, (b) => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { hit: !!hit && b.contains(hit), text: b.textContent }
    })
    c.check('Approve is still there to press on a far window, not under its tile', approve.hit, approve)
    const asked = await page.$eval(`${U.nodeSel('asks')} .head-far .key-badge`, (m) => m.textContent)
    c.check("The tile's badge names the command", /^Bash: /.test(asked), asked)
    const zoom = await page.$eval('.dock-zoom', (b) => b.textContent)
    const px = await titlePx(page, 'needs')
    c.check('A far title still draws at a readable size', px >= 13, { zoom, px })
    const meta = await page.$eval(`${U.nodeSel('needs')} .head-far`, (m) => m.innerText)
    c.check('A far header says the status and the key badge', /Needs you/.test(meta) && /71% context/.test(meta), meta)
    c.check("No window's body changed size", JSON.stringify(await bodySizes(page)) === JSON.stringify(near), { near, far: await bodySizes(page) })

    // The tile can't show the whole command, so it never approves one: Deny, or Review…, which zooms to the window
    // with the whole command shown, where Approve is.
    const answers = await page.$$eval(`${U.nodeSel('asks')} .head-far [data-far-answer]`, (b) => b.map((x) => x.dataset.farAnswer))
    c.check('A far tile offers Review… and Deny, never Approve', JSON.stringify(answers) === JSON.stringify(['review', 'deny']), answers)
    await page.click(`${U.nodeSel('asks')} [data-far-answer="review"]`)
    await L.sleep(800)
    const reviewed = await page.evaluate((sel) => {
      const strip = document.querySelector(`${sel} .strip-approval`)
      const b = strip?.querySelector('.btn-solid')
      const r = b?.getBoundingClientRect()
      const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { open: !!strip?.classList.contains('strip-open'), hit: !!hit && b.contains(hit), tier: document.querySelector('.react-flow').dataset.zoomTier }
    }, U.nodeSel('asks'))
    c.check('Review… zooms in to the window with the whole command shown and Approve there to press', reviewed.open && reviewed.hit && reviewed.tier === 'near', reviewed)
    c.check('And nothing was answered on the way', !!(await page.$(`${U.nodeSel('asks')} .strip-approval`)))
    // The whole command takes the strip's room from the body; fold it back for the size checks that follow.
    await page.click(`${U.nodeSel('asks')} .strip-more`)
    await L.sleep(300)

    await zoomTo(page, 'overview')
    c.check('Further out, the canvas is the overview', (await tier(page)) === 'overview')
    const fill = await page.$eval(`${U.nodeSel('needs')} .unit-body`, (b) => getComputedStyle(b).backgroundColor)
    const idleFill = await page.$eval(`${U.nodeSel('idle')} .unit-body`, (b) => getComputedStyle(b).backgroundColor)
    c.check('In the overview a body is filled with its status colour', fill !== idleFill, { fill, idleFill })
    c.check('Still no body changed size', JSON.stringify(await bodySizes(page)) === JSON.stringify(near))
    c.check('And the terminal kept its size', (await U.ptySize(page, 'term', 'far')) === pty, { pty })

    const box = await page.$eval(`${U.nodeSel('idle')} .unit-head`, (h) => {
      const r = h.getBoundingClientRect()
      return { x: r.left + r.width * 0.3, y: r.top + r.height / 2 }
    })
    await page.mouse.move(box.x, box.y)
    await L.sleep(300)
    const shown = await page.$eval(`${U.nodeSel('idle')} .head-tools`, (t) => getComputedStyle(t).opacity)
    c.check('Hovering a far window brings its tools back', shown === '1', shown)

    await page.click('.dock [data-cmd="zoom-reset"]')
    await L.sleep(500)
    c.check('Back at full size the header is near again', (await tier(page)) === 'near')
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.forceKill().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
