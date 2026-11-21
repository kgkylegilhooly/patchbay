'use strict'
// Codex's states through the real app, with no quota: fake-codex.cjs replays what a live Codex 0.170 wrote and sent
// (test/fixtures/codex-0.170), through Patchbay's real hook script. The live check is codex-states-real.cjs.
// Throwaway profile; off-screen window. Run after npm run build:  node test/acceptance/codex-states.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const L = require('./lib.cjs')

const c = L.checker()
const fakeCodex = path.join(__dirname, 'fake-codex.cjs').replace(/\\/g, '/')

async function main() {
  const profile = L.newProfile({ codexCommand: `node "${fakeCodex}"`, notifications: 'off', sound: 'off' })
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-fake-codex-work-'))
  const rollouts = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-fake-codex-rollouts-'))
  const app = await L.launch({ profile, env: { PB_FAKE_CODEX_DIR: rollouts } })
  const { page } = app
  const open = (id, prompt, x, y) => L.openNode(page, L.claude(id, cwd, x, y, { agent: 'codex', title: id, width: 520, height: 300, prompt }))
  const stops = () => page.evaluate(() => window.patchbayStops.all())
  try {
    await open('ok', 'ok', 0, 0)
    await open('fail', 'fail', 560, 0)
    await open('usage', 'usage', 1120, 0)
    await open('esc', 'esc', 0, 360)
    await open('sub', 'subagent', 560, 360)
    await L.fitView(page)

    const okSeen = await L.waitFor('ok to finish', async () => ((await L.statusOf(page, 'ok')) === 'idle' && (await L.seenStatuses(page, 'ok')).includes('working') ? L.seenStatuses(page, 'ok') : null), 30000).catch((e) => e.message)
    c.check('a turn that answers: working, then idle', Array.isArray(okSeen), okSeen)
    const said = await page.evaluate(() => window.patchbay.readConversation('ok'))
    c.check('its conversation reads from the 0.170 rollout', said.ok && said.messages.map((m) => m.text).join('|') === 'ok|ready', said)

    const fail = await L.waitFor('the failed turn to stop', async () => (await stops()).fail ?? null, 30000).catch((e) => e.message)
    c.check('a failed turn with no Stop hook: a stop record from the rollout', fail?.kind === 'error' && /not supported/.test(fail.message), fail)
    c.check('…and the node is unknown, not working', (await L.statusOf(page, 'fail')) === 'unknown', await L.statusOf(page, 'fail'))

    const usage = await L.waitFor('the usage limit', async () => (await stops()).usage ?? null, 30000).catch((e) => e.message)
    c.check('a usage limit holds until the window Codex reports resets', usage?.kind === 'usage-limit' && usage.holds === 'reset' && usage.until > Date.now() + 3600_000, usage)

    await L.waitFor('esc to be working', async () => (await L.statusOf(page, 'esc')) === 'working', 30000).catch(() => {})
    await L.input(page, 'esc', '\x1b')
    const esc = await L.waitFor('idle after Esc', async () => ((await L.statusOf(page, 'esc')) === 'idle' ? true : null), 15000).catch((e) => e.message)
    c.check('Esc: Interrupt brings it back to idle', esc === true, { esc, seen: await L.seenStatuses(page, 'esc') })

    const cards = await L.waitFor('the subagent card to end', async () => {
      const snap = await page.evaluate(() => window.patchbaySubagents.get())
      const card = snap?.sub?.cards?.[0]
      return card?.status === 'done' ? card : null
    }, 30000, 300).catch((e) => e.message)
    c.check("a subagent's card ends done, named by its task, counting only its own tools", cards?.description === 'pong' && cards.tools === 0, cards)
    const parent = await L.waitFor('the parent to end its turn', async () => ((await L.statusOf(page, 'sub')) === 'idle' ? 'idle' : null), 15000).catch(async () => L.statusOf(page, 'sub'))
    c.check('the parent ends idle', parent === 'idle', parent)
    console.log('SHOT', await L.shot(page, 'codex-states-fake'))
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    fs.rmSync(rollouts, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
