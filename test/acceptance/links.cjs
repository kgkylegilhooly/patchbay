'use strict'
// Animated one-way links on the real app: direction, reduced motion, pausing, and what the animation costs with ten
// live nodes and one noisy terminal. Uses the stand-in Claude, so no quota. Run after npm run build.
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { seedLinks, showLegend } = require('./scenes.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)
const step = U.stepper(c.check)

/** Frames drawn and the longest gap between two, over a stretch of time, while `during` runs. */
async function frames(page, ms, during) {
  await page.evaluate((ms) => {
    window.__frames = { count: 0, worst: 0 }
    let last = performance.now()
    const end = last + ms
    const tick = (t) => {
      window.__frames.count++
      window.__frames.worst = Math.max(window.__frames.worst, t - last)
      last = t
      if (t < end) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ms)
  await during()
  await L.sleep(100)
  return page.evaluate(() => window.__frames)
}

/** Drags the empty canvas around for a while, as panning by hand does. */
async function pan(page, ms) {
  const box = await page.$eval('.react-flow__pane', (p) => {
    const r = p.getBoundingClientRect()
    return { x: r.left + r.width - 120, y: r.top + 60 }
  })
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  const end = Date.now() + ms
  for (let i = 0; Date.now() < end; i++) {
    await page.mouse.move(box.x - 60 + Math.sin(i / 6) * 60, box.y + 40 + Math.cos(i / 6) * 40, { steps: 2 })
  }
  await page.mouse.up()
}

async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

async function main() {
  const { cwd, profile } = U.seeded('links')
  const app = await L.launch({ profile })
  const page = app.page
  try {
    await step('setup', async () => {
      await L.waitFor('the canvas', async () => (await L.doc(page)).nodes.length >= 8, 20000)
      await seedLinks(page)
      // Ten live sessions, one of them printing nonstop.
      await L.openNode(page, L.terminal('noisy', cwd, 0, 1100, { command: 'while true; do echo "noise $RANDOM $RANDOM $RANDOM"; sleep 0.01; done' }))
      await L.openNode(page, L.terminal('extra', cwd, 640, 1100))
      await page.evaluate(async () => {
        const edge = (id, from, to, kind) => window.patchbay.dispatch({ op: 'addEdge', edge: { id, from, to, kind } })
        await edge('e2', 'needs', 'work', 'opened')
        await edge('e3', 'work', 'noisy', 'opened')
        await edge('e4', 'noisy', 'extra', 'after')
        await edge('e5', 'idle', 'run', 'opened')
        await edge('e6', 'term', 'extra', 'opened')
        await edge('e7', 'needs', 'idle', 'link')
        await edge('e8', 'unk', 'extra', 'opened')
        // A browser page on the canvas too, opened by an agent, with a link to it.
        await window.patchbay.dispatch({ op: 'addNode', node: { id: 'page', kind: 'browser', title: 'Page', url: 'about:blank', x: 1280, y: 1100, width: 560, height: 360, parentId: null } })
        await edge('e9', 'idle', 'page', 'opened')
        await edge('e10', 'idle', 'page', 'link')
      })
      await showLegend(page)
      await page.click('[data-cmd="toggle-sidebar"]')
      await L.fitView(page)
      await L.waitFor('the noise', async () => (await L.snapshot(page, 'noisy')).includes('noise'), 15000)
      const sessions = (await L.doc(page)).nodes.filter((n) => ['terminal', 'claude', 'run'].includes(n.kind)).length
      c.check('About ten sessions are on the canvas', sessions >= 9, sessions)
    })

    await step('direction', async () => {
      // The dots move only while a node at either end is under way (working, starting, queued); see cableActivity.ts.
      // Each cable's offset now and 250 ms later, kept only for cables that were moving, or still, both times.
      const sample = () =>
        page.$$eval('.cable-opened .cable-flow', async (ps) => {
          const read = () => ps.map((p) => ({ still: p.classList.contains('cable-still'), at: parseFloat(getComputedStyle(p).strokeDashoffset) }))
          const before = read()
          await new Promise((r) => setTimeout(r, 250))
          const after = read()
          const pairs = before.map((x, i) => ({ still: x.still, a: x.at, b: after[i].at, same: x.still === after[i].still })).filter((x) => x.same)
          return { moving: pairs.filter((x) => !x.still), still: pairs.filter((x) => x.still) }
        })
      // The stand-in agents start up first: wait for one to be working.
      const { moving, still } = await L.waitFor('a moving cable', async () => {
        const s = await sample()
        return s.moving.length > 0 && s
      }, 20000)
      const [a, b] = [moving.map((x) => x.a), moving.map((x) => x.b)]
      const [stillA, stillB] = [still.map((x) => x.a), still.map((x) => x.b)]
      // The offset falls toward 0 and wraps, so a move forward reads as smaller, or as a wrap back to the top.
      const forward = a.every((v, i) => b[i] < v || b[i] - v > 20)
      c.check('One-way cables animate', a.length > 0 && a.some((v, i) => v !== b[i]), { a, b })
      c.check('They move from start to end', a.length > 0 && forward, { a, b })
      c.check('A cable with nothing under way at either end keeps its dots still', stillA.length > 0 && stillA.every((v, i) => v === stillB[i]), { stillA, stillB })
      c.check('Links have no moving dots', (await page.$$('.cable-link .cable-flow')).length === 0)
      c.check('One-way cables have an arrowhead, links do not', (await page.$$('.cable-opened [marker-end]')).length > 0 && (await page.$$('.cable-link [marker-end]')).length === 0)
      const legend = await page.$eval('.legend', (l) => l.textContent)
      c.check('The legend explains it', /one-way/.test(legend) && /both ways/.test(legend), legend)
      await L.shot(page, 'links-after-frame1')
      await L.sleep(400)
      await L.shot(page, 'links-after-frame2')
    })

    await step('cost', async () => {
      await app.cdp.send('Performance.enable')
      const idle = async () => {
        const before = await metrics(app.cdp)
        await L.sleep(3000)
        const after = await metrics(app.cdp)
        return { script: after.ScriptDuration - before.ScriptDuration, style: after.RecalcStyleDuration - before.RecalcStyleDuration, layout: after.LayoutDuration - before.LayoutDuration }
      }
      const animated = await idle()
      const panAnimated = await frames(page, 3000, () => pan(page, 3000))
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      await L.sleep(300)
      const still = await idle()
      const panStill = await frames(page, 3000, () => pan(page, 3000))
      console.log('MEASURE idle 3 s, animated:', JSON.stringify(animated), 'still:', JSON.stringify(still))
      console.log('MEASURE panning 3 s, animated:', JSON.stringify(panAnimated), 'still:', JSON.stringify(panStill))
      c.check('The animation adds almost no script time (no React renders for it)', animated.script - still.script < 0.15, { animated: animated.script, still: still.script })
      c.check('Panning stays smooth with it on', panAnimated.count >= panStill.count * 0.85 && panAnimated.worst < 120, { panAnimated, panStill })
      const anim = await page.$eval('.cable-flow', (p) => getComputedStyle(p).animationName)
      c.check('Reduced motion turns the animation off', anim === 'none', anim)
      await L.shot(page, 'links-after-reduced-motion')
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
    })

    await step('pausing', async () => {
      const box = await page.$eval('.react-flow__pane', (p) => {
        const r = p.getBoundingClientRect()
        return { x: r.left + r.width - 100, y: r.top + 50 }
      })
      await page.mouse.move(box.x, box.y)
      await page.mouse.down()
      await page.mouse.move(box.x - 40, box.y + 30, { steps: 4 })
      const paused = await page.$eval('.stage', (s) => s.hasAttribute('data-canvas-moving') && getComputedStyle(s.querySelector('.cable-flow')).animationPlayState)
      await page.mouse.up()
      await L.sleep(200)
      c.check('It pauses while the view moves', paused === 'paused', paused)
      c.check('And carries on after', !(await page.$eval('.stage', (s) => s.hasAttribute('data-canvas-moving'))))
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => [...document.querySelectorAll('[data-cmd="zoom-out"]')].find((b) => b.closest('.dock')).click())
        await L.sleep(220)
      }
      c.check('It pauses when zoomed far out', await page.$eval('.stage', (s) => s.hasAttribute('data-canvas-far')))
    })

    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
