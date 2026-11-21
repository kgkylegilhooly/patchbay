'use strict'
// The canvas and the background host can't disagree after a reconnect. See docs/plans/session-sync.md.
//
//   node test/acceptance/sessionSync.cjs        the built app (npm run build first), a throwaway profile, no quota
//
// A second client on the throwaway host knocks the app off and starts two sessions behind its back: one for a node the
// canvas shows as ended, one for no node at all. When the app reconnects, the first must be shown again and live
// (output and keys), and the second reported in Settings > Background sessions, never ended without asking.
const lib = require('./lib.cjs')
const { startBehindItsBack, idleShell } = require('./hostIntruder.cjs')
const { sleep, waitFor, launch, newProfile, workDir, terminal, input, snapshot, statuses, checker, cleanup, shot } = lib

setTimeout(() => {
  console.error('FAIL  the whole run went over its time limit')
  process.exit(2)
}, 4 * 60 * 1000).unref()

const syncReport = (page) => page.evaluate(() => window.patchbaySync.check())

async function main() {
  const { check, finish } = checker()
  const profile = newProfile({ notifications: 'off', sound: 'off' })
  const work = workDir('session-sync')
  let app
  try {
    app = await launch({ profile })
    const { page } = app
    await page.evaluate(async (n) => {
      await window.patchbay.dispatch({ op: 'addNode', node: n })
      await window.patchbay.startNode(n.id)
    }, terminal('old', work, 80, 80))
    await waitFor('the terminal to run', async () => (await page.evaluate(() => window.patchbay.getHostInfo())).running >= 1, 30000)
    await sleep(1500)
    await input(page, 'old', 'exit\r')
    await waitFor('the terminal to end', async () => (await statuses(page)).old === 'exited', 20000)
    check('the terminal shows as ended', true)

    // Knocked off and back, with two sessions it never asked for. The app reconnects within a second.
    let answers
    for (let i = 0; i < 5 && !answers; i++) answers = await startBehindItsBack(profile, [idleShell('old', work), idleShell('ghost', work)]).catch(() => null)
    check('the second client started both sessions in the host', answers?.every((a) => a.ok), answers)

    const live = await waitFor('the node to stop showing ended', async () => (await statuses(page)).old !== 'exited', 15000).then(() => true, () => false)
    check('a session the canvas showed as ended is shown as running again after the reconnect', live, (await statuses(page)).old)
    check('its view gets what it printed while out of sight', await waitFor('its output', async () => (await snapshot(page, 'old')).includes('started-behind-its-back'), 10000).then(() => true, () => false))
    await input(page, 'old', 'echo typed-after-sync\r')
    check('keys reach it', await waitFor('typed output', async () => (await snapshot(page, 'old')).includes('typed-after-sync'), 10000).then(() => true, () => false))
    check('the node says why it is back, with End and restart behind a question', await waitFor('the notice', () => page.$('.react-flow__node[data-id="old"] [data-joined]'), 10000).then(() => true, () => false))

    const report = await syncReport(page)
    const ghost = report.rows.find((r) => r.id === 'ghost')
    check('a session with no node is reported as an orphan', ghost?.problem === 'orphan', ghost)
    check('nothing ended it', ghost?.running === true)
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="sessions"]')
    await page.click('[data-section="sessions"]')
    await page.waitForSelector('[data-sync-row="orphan"]', { timeout: 10000 })
    console.log(`      ${await shot(page, 'session-sync-settings')}`)
    await page.click('[data-sync-row="orphan"] [data-sync-action="ask-end"]')
    await page.click('[data-sync-row="orphan"] [data-sync-action="end"]')
    const gone = await waitFor('the orphan to end', async () => !(await syncReport(page)).rows.some((r) => r.id === 'ghost' && r.running), 15000).then(() => true, () => false)
    check('End, asked twice, ends it', gone)
    check('the window showed no errors', app.problems.length === 0, app.problems)
  } catch (e) {
    check(`the run completed: ${e.message}`, false)
  } finally {
    await app?.quit().catch(() => {})
    cleanup(profile)
    finish()
  }
}

void main()
