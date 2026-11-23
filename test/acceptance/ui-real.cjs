'use strict'
// The few UI checks that need the real Claude, kept small because they use real plan quota: one short turn and one title.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(6 * 60_000)
const step = U.stepper(c.check)

/** Transcripts this run could have left, so a title can be shown not to have saved a conversation. */
function transcriptCount() {
  const dir = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter((d) => d.toLowerCase().includes('naming')).length
}

async function main() {
  const hash = L.settingsHash()
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const cwd = L.workDir('ui-real')
  const app = await L.launch({ profile, realHome: true })
  const { page } = app
  const before = transcriptCount()
  try {
    await L.openNode(page, L.terminal('t', cwd, 900, 40))
    await L.openNode(page, L.claude('real', cwd, 40, 40, { prompt: 'Reply with just the word ready.' }))

    await step('real status', async () => {
      // It's idle for a moment before the prompt starts, so a turn only counts once it has been seen working.
      await L.waitFor('Claude to finish its turn', async () => (await L.seenStatuses(page, 'real')).includes('working') && (await L.statusOf(page, 'real')) === 'idle', 150000, 500)
      await page.click('[data-sidebar-tab="status"]')
      await L.sleep(300)
      const rows = (id) => U.rowIds(page, `[data-status-section="${id}"]`)
      const listed = [...(await rows('idle')), ...(await rows('unread'))]
      c.check('A real Claude at idle is listed as Idle or Unread, never elsewhere', listed.includes('real'), listed)
      c.check('A real terminal is not', !(await rows('idle')).includes('t') && (await rows('plain')).includes('t'))
      c.check('A real turn gives it a last activity time', await page.$eval('[data-session="real"] .session-time', (e) => /now|ago/.test(e.textContent)))
    })

    await step('real refresh', async () => {
      const seenBefore = (await L.seenStatuses(page, 'real')).length
      await U.headerTool(page, 'real', 'refresh')
      await L.sleep(1500)
      const status = await L.statusOf(page, 'real')
      c.check('Refresh leaves a real Claude running', status === 'idle', { status, seen: (await L.seenStatuses(page, 'real')).slice(seenBefore) })
      c.check('And it still has its screen', (await L.screen(page, 'real')).some((r) => r.trim().length > 0))
    })

    await step('real name', async () => {
      await U.headerTool(page, 'real', 'name')
      await L.sleep(100)
      c.check('Name with AI shows it is working', !!(await page.$(`${U.nodeSel('real')} [data-tool="more"].tool-btn-busy`)))
      const named = await L.waitFor('a title', async () => {
        const failed = await page.$(`${U.nodeSel('real')} [data-naming-error]`)
        if (failed) throw new Error(await page.$eval(`${U.nodeSel('real')} [data-naming-error]`, (e) => e.textContent))
        const title = (await L.nodeOf(page, 'real')).title
        return title !== 'real' && title
      }, 90000, 500).catch((e) => e)
      c.check('Real Claude gave it a title', typeof named === 'string' && named.length <= 60, named instanceof Error ? named.message : named)
      c.check('It stays a single window', (await L.doc(page)).nodes.length === 2)
      c.check('It did not disturb the session', (await L.statusOf(page, 'real')) === 'idle')
    })

    c.check('No project folder was recorded for the naming run', transcriptCount() === before, { before, now: transcriptCount() })
    c.check('~/.claude/settings.json is unchanged', L.settingsHash() === hash)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
    await L.shot(page, 'ui-after-real-claude')
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
