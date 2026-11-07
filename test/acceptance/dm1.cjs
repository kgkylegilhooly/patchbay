'use strict'
// Done means 1. Ten live nodes, with real pan, zoom, drag, resize and group input while one terminal
// prints continuously. Every session must survive it.
const L = require('./lib.cjs')

async function frameStats(page, during) {
  await page.evaluate(() => {
    window.__frames = []
    window.__frameRun = true
    let last = performance.now()
    const tick = (now) => {
      window.__frames.push(now - last)
      last = now
      if (window.__frameRun) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await during()
  return page.evaluate(() => {
    window.__frameRun = false
    const f = [...window.__frames].sort((a, b) => a - b)
    return { frames: f.length, p50: Math.round(f[Math.floor(f.length * 0.5)]), p95: Math.round(f[Math.floor(f.length * 0.95)]), max: Math.round(f[f.length - 1]) }
  })
}

async function boxOf(page, selector) {
  const el = await page.$(selector)
  if (!el) throw new Error(`Not on screen: ${selector}`)
  return el.boundingBox()
}

async function main() {
  const c = L.checker()
  const work = L.workDir('dm1')
  const profile = L.newProfile()
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = app
  try {
    const terminals = ['t0', 't1', 't2', 't3', 't4', 't5', 't6']
    const agents = ['c0', 'c1', 'c2']
    const all = [...terminals, ...agents]
    for (const [i, id] of all.entries()) {
      const make = id.startsWith('t') ? L.terminal : L.claude
      await L.openNode(page, make(id, work, (i % 4) * 660, Math.floor(i / 4) * 460, { width: 620, height: 420 }))
    }
    await page.evaluate(() => window.patchbay.dispatch({ op: 'setViewport', viewport: { x: 0, y: 0, zoom: 0.45 } }))
    await L.waitFor('every Claude node to be idle', async () => {
      const s = await L.statuses(page)
      return agents.every((id) => s[id] === 'idle')
    }, 90000)
    c.check('10 live nodes opened: 7 terminals and 3 Claude', (await L.doc(page)).nodes.length === 10, await L.statuses(page))

    await L.sleep(1000)
    await L.submit(page, 't0', 'i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.01; done')
    await L.waitFor('the noisy terminal', async () => (await L.snapshot(page, 't0')).includes('tick-20'), 20000)

    const stage = await boxOf(page, '.react-flow__pane')
    const cx = stage.x + stage.width * 0.5
    const cy = stage.y + stage.height * 0.5
    const empty = { x: stage.x + stage.width - 40, y: stage.y + stage.height - 240 }

    const panned = await frameStats(page, async () => {
      for (let round = 0; round < 3; round++) {
        await page.mouse.move(empty.x, empty.y)
        await page.mouse.down()
        for (let i = 1; i <= 25; i++) await page.mouse.move(empty.x - i * 8, empty.y - i * 3)
        await page.mouse.up()
      }
    })
    c.check('panning while one terminal prints', panned.frames > 0, panned)

    const zoomed = await frameStats(page, async () => {
      await page.mouse.move(cx, cy)
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel({ deltaY: i < 6 ? 120 : -120 })
        await L.sleep(40)
      }
    })
    c.check('zooming while one terminal prints', zoomed.frames > 0, zoomed)

    await page.evaluate(() => document.querySelector('.dock [data-cmd="fit-view"]')?.click())
    await L.sleep(500)

    const before = await L.nodeOf(page, 't2')
    const head = await boxOf(page, '.react-flow__node[data-id="t2"] .unit-head')
    const dragged = await frameStats(page, async () => {
      const x = head.x + head.width * 0.4
      const y = head.y + head.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      for (let i = 1; i <= 25; i++) await page.mouse.move(x + i * 2, y + i)
      await page.mouse.up()
    })
    await L.sleep(300)
    const after = await L.nodeOf(page, 't2')
    c.check('dragging moved the node', after.x !== before.x && after.y !== before.y, { dragged, from: [before.x, before.y], to: [after.x, after.y] })

    const widthBefore = (await L.nodeOf(page, 't3')).width
    await page.click('.react-flow__node[data-id="t3"] .unit-head .title')
    await L.sleep(200)
    const grip = await boxOf(page, '.react-flow__node[data-id="t3"] .react-flow__resize-control.handle.bottom.right')
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(grip.x + i * 4, grip.y + i * 3)
    await page.mouse.up()
    await L.sleep(300)
    c.check('resizing changed the node', (await L.nodeOf(page, 't3')).width > widthBefore, [widthBefore, (await L.nodeOf(page, 't3')).width])

    // Ctrl-click selects several, then the toolbar groups them.
    await page.keyboard.down('Control')
    await page.click('.react-flow__node[data-id="t4"] .unit-head .title')
    // t5, since t3 was just resized and can now cover the title bar of the node below it.
    await page.click('.react-flow__node[data-id="t5"] .unit-head .title')
    await page.keyboard.up('Control')
    await L.sleep(200)
    await page.evaluate(() => document.querySelector('.dock [data-cmd="group"]')?.click())
    const grouped = await L.waitFor('the group to form', async () => {
      const d = await L.doc(page)
      const g = d.nodes.find((n) => n.kind === 'group')
      return g && d.nodes.filter((n) => n.parentId === g.id).map((n) => n.id).sort()
    }, 5000)
    c.check('grouping took the selected nodes', grouped.length >= 2, grouped)

    // No session may be lost: each terminal answers, and the noisy one is still counting.
    const seen = async () => Number(((await L.snapshot(page, 't0')).match(/tick-(\d+)/g) ?? ['tick-0']).pop().slice(5))
    const a = await seen()
    await L.sleep(1500)
    const b = await seen()
    c.check('the noisy terminal is still printing', b > a, [a, b])

    // ConPTY and Git Bash can drop a character typed just after a resize, even with no Patchbay code
    // involved. One retry tells that apart from a lost session, and it's counted.
    let retried = 0
    for (const id of terminals.slice(1)) {
      const answered = async () => (await L.snapshot(page, id)).includes(`alive-${id}-2`)
      await L.submit(page, id, `echo alive-${id}-$((1+1))`)
      await L.sleep(1200)
      if (!(await answered())) {
        retried++
        await L.submit(page, id, `echo alive-${id}-$((1+1))`)
      }
      await L.waitFor(`${id} to answer`, answered, 10000)
    }
    c.check('all 6 other terminals still answer', true, { neededARetry: retried })
    const finalStatus = await L.statuses(page)
    c.check('all 3 Claude nodes are still up', agents.every((id) => finalStatus[id] === 'idle'), agents.map((id) => finalStatus[id]))

    console.log('screenshot:', await L.shot(page, 'dm1-ten-nodes'))
    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(page, 'dm1-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
