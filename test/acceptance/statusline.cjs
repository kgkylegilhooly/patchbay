'use strict'
// The forwarding status line with real Claude sessions: the owner's line still draws, and usage reaches the app.
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const marked = lib.workDir('statusline-marked')
  const plain = lib.workDir('statusline-plain')
  fs.mkdirSync(path.join(marked, '.claude'))
  fs.writeFileSync(path.join(marked, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo MARKED-LINE' } }))
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  const app = await lib.launch({ profile, exe })
  const { page } = app
  try {
    await lib.openNode(page, lib.claude('marked', marked, 20, 20, { prompt: 'Say the word ok and nothing else.' }))
    await lib.openNode(page, lib.claude('plain', plain, 680, 20, { prompt: 'Say the word ok and nothing else.' }))
    await lib.waitFor('both to finish', async () => {
      const seen = await Promise.all(['marked', 'plain'].map((id) => lib.seenStatuses(page, id)))
      const now = await lib.statuses(page)
      return seen.every((s) => s.includes('working')) && now.marked === 'idle' && now.plain === 'idle'
    }, 150000)
    await lib.fitView(page)
    await lib.waitFor('the project status line', async () => (await lib.screen(page, 'marked')).join('\n').includes('MARKED-LINE'), 20000)
    check("A project's own status line still draws inside Patchbay", true)
    await lib.sleep(1500)
    const line = (await lib.screen(page, 'plain')).join('\n')
    check("The owner's own status line draws, in the same place as before", /~\/.*\|.*Haiku/.test(line), line.split('\n').slice(-6).join(' / '))
    if (shots) await page.screenshot({ path: path.join(shots, 'statusline.png') })
    if (await page.$('.usage-pill')) {
      const pill = await page.$eval('.usage-pill', (p) => p.textContent)
      check('The title bar shows plan limits, as percentage left', /\d+% 5h · \d+% wk/.test(pill), pill)
      const state = await page.evaluate(() => window.patchbay.getUsage())
      check('The number is what remains', pill.startsWith(`${100 - state.plan.fiveHour.percent}% 5h`), { pill, used: state.plan.fiveHour.percent })
      await page.hover('.usage-pill')
      await page.waitForSelector('.usage-panel', { timeout: 3000 })
      const panel = await page.$eval('.usage-panel', (p) => p.innerText)
      check('Hovering opens a panel with each limit and its countdown', /5-hour limit/.test(panel) && /Weekly limit/.test(panel) && /Resets in/.test(panel) && /Updated/.test(panel), panel)
      if (shots) await page.screenshot({ path: path.join(shots, 'usage-panel.png') })
      await page.mouse.move(600, 500)
      await lib.waitFor('the panel to close', async () => !(await page.$('.usage-panel')), 3000)
      check('Moving away closes it', true)
      const context = await page.$eval('.react-flow__node[data-id="plain"] .unit-context', (c) => c.textContent)
      check('The window shows its context', /^\d+% context$/.test(context), context)
    } else if (process.argv.includes('--usage')) {
      check('The title bar shows plan limits', false)
    }
    check('No errors in the page', app.problems.length === 0, app.problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
  } finally {
    await app.forceKill().catch(() => {})
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
