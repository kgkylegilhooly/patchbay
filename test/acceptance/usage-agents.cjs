'use strict'
// The usage pill and panel with both agents: Codex's limits and account from its app server, and the Claude account
// from claude auth status. Both only read, and spend no quota. Needs codex and claude installed and signed in.
// Run after npm run build.
const L = require('./lib.cjs')

const c = L.checker()

async function main() {
  const profile = L.newProfile()
  const app = await L.launch({ profile })
  const page = app.page
  try {
    const pill = await L.waitFor('the usage pill', () => page.$('.usage-pill'), 40000).catch(() => null)
    const text = pill ? await page.$eval('.usage-pill', (p) => p.textContent) : null
    c.check('The pill shows Codex', /\d+% Codex/.test(text ?? ''), text)
    await page.hover('.usage-pill')
    await page.waitForSelector('.usage-panel', { timeout: 5000 })
    const sections = await page.$$eval('.usage-section', (ss) => ss.map((s) => ({ agent: s.dataset.agent, rows: [...s.querySelectorAll('.usage-row-title')].map((r) => r.textContent), account: !!s.querySelector('.usage-account-email') })))
    console.log('SECTIONS', JSON.stringify(sections))
    const codex = sections.find((s) => s.agent === 'codex')
    c.check('The panel has a Codex section with its limit and account', !!codex && codex.rows.length > 0 && codex.account, codex)
    const claude = sections.find((s) => s.agent === 'claude')
    c.check('The panel shows the Claude account', !!claude?.account, claude)
    // The panel shows the owner's email addresses, so this picture stays out of the repository.
    const file = require('path').join(require('os').tmpdir(), 'patchbay-usage-agents.png')
    await page.screenshot({ path: file })
    console.log('SHOT', file)
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
