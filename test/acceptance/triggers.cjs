'use strict'
// Trigger nodes on the real app. The Claude window runs fake-claude.cjs with "turns", so idle gating is checked
// through real hooks with no plan quota. Run: node test/acceptance/triggers.cjs (after npm run build)
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(6 * 60_000)
const step = U.stepper(c.check)
const fake = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

const trigger = (id, targetId, prompt, x, y, everyMs = 5000) => ({
  id, kind: 'trigger', title: id, x, y, width: 360, height: 400, parentId: null,
  schedule: { type: 'interval', everyMs }, prompt, targetId, armedSpec: null, armedAt: null, nextAt: null, runs: []
})
/** The same form canonicalSpec writes, so a check can arm exactly what it says it agreed to. */
const specOf = (n) => JSON.stringify([[n.schedule.type, n.schedule.everyMs], n.prompt, n.targetId])

async function main() {
  const cwd = L.workDir('triggers')
  const profile = L.newProfile({ claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off' })
  let app = await L.launch({ profile })
  let page = app.page
  const node = (id) => L.nodeOf(page, id)
  const count = async (id, text) => ((await L.snapshot(page, id)).split(text).length - 1)
  const sel = (id, what) => `.react-flow__node[data-id="${id}"] ${what}`
  try {
    await step('setup', async () => {
      await L.openNode(page, L.terminal('t1', cwd, 0, 0))
      await L.openNode(page, L.claude('c1', cwd, 0, 420, { prompt: 'turns' }))
      await L.waitFor('the shell prompt', async () => (await L.snapshot(page, 't1')).includes('$'), 20000)
      await L.waitFor('the stand-in Claude to be idle', async () => (await L.statusOf(page, 'c1')) === 'idle', 20000)
      await page.evaluate((n) => window.patchbay.dispatch({ op: 'addNode', node: n }), trigger('trA', 't1', 'echo TRIG-A', 640, 0))
      await L.fitView(page)
    })

    await step('disarmed', async () => {
      c.check('A new trigger starts disarmed', (await node('trA')).armedSpec === null)
      await L.sleep(7000)
      c.check('A disarmed interval trigger sends nothing', (await count('t1', 'TRIG-A')) === 0 && (await node('trA')).runs.length === 0)
      c.check('Run now is off until it is armed', await page.$eval(sel('trA', '[data-trigger-action="run"]'), (b) => b.disabled))
      await page.evaluate(() => window.patchbay.dispatch({ op: 'setTriggerState', id: 'trA', state: { armedSpec: 'x', nextAt: Date.now() } }))
      await L.sleep(300)
      c.check('The page cannot set a trigger\'s state itself', (await node('trA')).armedSpec === null)
    })

    await step('arm and deliver', async () => {
      await page.click(sel('trA', '[data-trigger-action="arm"]'))
      await page.waitForSelector('form[aria-label="Arm trigger"]')
      const shown = await page.$eval('form[aria-label="Arm trigger"]', (f) => f.textContent)
      c.check('Arming shows the schedule, prompt and target', /Every 5 seconds/.test(shown) && /echo TRIG-A/.test(shown) && /t1, a terminal/.test(shown), shown.slice(0, 200))
      if (process.env.SHOTS) await L.shot(page, 'trigger-accept-arm')
      await page.click('form[aria-label="Arm trigger"] [name="arm"]')
      await L.waitFor('it to be armed', async () => (await node('trA')).armedSpec !== null, 5000)
      const next = await page.$eval(sel('trA', '[data-trigger="next"]'), (d) => d.textContent)
      c.check('The node shows when it runs next', /\(in \d+ s\)/.test(next), next)
      await L.waitFor('the prompt in the terminal', async () => (await count('t1', 'TRIG-A')) >= 2, 15000)
      const runs = (await node('trA')).runs
      c.check('An armed interval trigger delivers to a terminal', runs[0]?.outcome === 'delivered', runs[0])
      c.check('It shows in the recent runs', !!(await page.$(sel('trA', '.trigger-run[data-outcome="delivered"]'))))
    })

    await step('edit disarms', async () => {
      await page.click(sel('trA', '[data-trigger-action="edit"]'))
      await page.waitForSelector('form[aria-label="Edit trigger"]')
      await page.$eval('form[aria-label="Edit trigger"] [name="prompt"]', (t) => t.select())
      await page.type('form[aria-label="Edit trigger"] [name="prompt"]', 'echo TRIG-B')
      await page.click('form[aria-label="Edit trigger"] .btn-solid')
      await L.waitFor('the edit', async () => (await node('trA')).prompt === 'echo TRIG-B', 5000)
      const n = await node('trA')
      c.check('Editing disarms it', n.armedSpec === null && n.nextAt === null)
      c.check('And the node says so', (await page.$eval(sel('trA', '.trigger-chip'), (s) => s.textContent)) === 'Not armed')
      const before = await count('t1', 'TRIG-A')
      await L.sleep(7000)
      c.check('An edited trigger sends nothing, old or new', (await count('t1', 'TRIG-A')) === before && (await count('t1', 'TRIG-B')) === 0)
    })

    await step('Claude target', async () => {
      await page.evaluate((n) => window.patchbay.dispatch({ op: 'addNode', node: n }), trigger('trC', 'c1', 'HELLO-CLAUDE', 640, 420, 3_600_000))
      await L.sleep(300)
      await L.submit(page, 'c1', 'busy')
      await L.waitFor('it to be working', async () => (await L.statusOf(page, 'c1')) === 'working', 8000)
      const armed = await page.evaluate((s) => window.patchbay.armTrigger('trC', s), specOf(await node('trC')))
      c.check('Arming with what was shown works', armed.ok === true, armed)
      const run = await page.evaluate(() => window.patchbay.runTriggerNow('trC'))
      c.check('A working Claude gets it queued, not typed', run.ok && run.run.outcome === 'queued', run)
      await L.sleep(1500)
      c.check('Nothing reaches it while it works', (await count('c1', 'GOT: HELLO-CLAUDE')) === 0)
      await L.submit(page, 'c1', 'done')
      await L.waitFor('the prompt after idle', async () => (await count('c1', 'GOT: HELLO-CLAUDE')) === 1, 10000)
      c.check('It is delivered once Claude is idle', (await node('trC')).runs[0]?.outcome === 'delivered', (await node('trC')).runs[0])

      await L.waitFor('the stand-in to finish that turn', async () => (await L.statusOf(page, 'c1')) === 'idle', 10000)
      await L.sleep(3500)
      await L.submit(page, 'c1', 'busy')
      await L.waitFor('it to be working again', async () => (await L.statusOf(page, 'c1')) === 'working', 8000)
      await page.evaluate(() => window.patchbay.runTriggerNow('trC'))
      await page.evaluate(() => window.patchbay.disarmTrigger('trC'))
      await L.sleep(300)
      const dropped = (await node('trC')).runs[0]
      c.check('Disarming drops what is waiting, as missed', dropped?.outcome === 'missed' && /Dropped/.test(dropped.detail), dropped)
      await L.submit(page, 'c1', 'done')
      await L.sleep(3000)
      c.check('And it never arrives', (await count('c1', 'GOT: HELLO-CLAUDE')) === 1)
    })

    await step('dead target', async () => {
      await page.evaluate((n) => window.patchbay.dispatch({ op: 'addNode', node: n }), L.terminal('dead', cwd, 0, 900, { command: 'exit 0' }))
      await page.evaluate(() => window.patchbay.startNode('dead'))
      await L.waitFor('it to end', async () => !(await page.evaluate(() => window.patchbay.getStatuses()))['dead'] === false, 8000).catch(() => {})
      await L.sleep(2000)
      await page.evaluate((n) => window.patchbay.dispatch({ op: 'addNode', node: n }), trigger('trD', 'dead', 'echo nope', 640, 900, 3_600_000))
      await L.sleep(300)
      await page.evaluate((s) => window.patchbay.armTrigger('trD', s), specOf(await node('trD')))
      const r = await page.evaluate(() => window.patchbay.runTriggerNow('trD'))
      c.check('A target that is not running is missed, and not started', r.ok && r.run.outcome === 'missed' && /never starts/.test(r.run.detail), r)
    })

    await step('closed app', async () => {
      // TRIG-B every 5 s, armed, then the app closes for longer than a few slots.
      await page.evaluate((s) => window.patchbay.armTrigger('trA', s), specOf(await node('trA')))
      await L.waitFor('one TRIG-B', async () => (await count('t1', 'TRIG-B')) >= 1, 12000)
      await L.sleep(300)
      const before = await count('t1', 'TRIG-B')
      const code = await app.quitLeavingSessions()
      c.check('Quit leaves sessions running', code === 0, code)
      await L.sleep(16000)
      app = await L.launch({ profile })
      page = app.page
      await L.waitFor('the terminal to be back', async () => (await L.snapshot(page, 't1')).includes('TRIG-A'), 20000)
      const after = await count('t1', 'TRIG-B')
      c.check('Nothing fired while the app was closed, and nothing caught up on relaunch', after === before, { before, after })
      const missed = (await node('trA')).runs[0]
      c.check('The skipped slots are shown as missed', missed?.outcome === 'missed' && /app was closed/.test(missed.detail), missed)
      await L.fitView(page)
      c.check('On the node too', !!(await page.$(sel('trA', '.trigger-run[data-outcome="missed"]'))))
      c.check('It stays armed and runs at the next slot', (await node('trA')).armedSpec !== null)
      const fired = await L.waitFor('the next slot', async () => (await count('t1', 'TRIG-B')) > after, 15000).catch(() => false)
      c.check('The next slot after relaunch fires', fired, { after, now: await count('t1', 'TRIG-B'), runs: (await node('trA')).runs.slice(0, 3) })
      if (process.env.SHOTS) await L.shot(page, 'trigger-accept-missed')
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
