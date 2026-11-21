'use strict'
// The resource view's real readings, and a window far off-screen being unloaded and drawn again with nothing lost.
// Uses terminals only, so no agent quota. Takes about four minutes: unloading waits three.
// Run after a build: node test/acceptance/resources.cjs   (PB_SKIP_PARKING=1 checks the readings only)
const { execFileSync } = require('node:child_process')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)

async function main() {
  const cwd = L.workDir('resources')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile })
  const { page } = app
  try {
    await L.openNode(page, L.terminal('near', cwd, 0, 0))
    await L.openNode(page, L.terminal('far', cwd, 9000, 0))
    await L.waitFor('the terminals', async () => (await Promise.all(['near', 'far'].map((id) => L.snapshot(page, id)))).every((s) => s.includes('$')), 60000)
    await L.submit(page, 'far', 'echo far-marker-$((6*7))')
    await L.waitFor('the far output', async () => (await L.snapshot(page, 'far')).includes('far-marker-42'))

    const r = await page.evaluate(() => window.patchbayResources.get(true))
    console.log('READING', JSON.stringify({ system: r.system, app: r.app.total, host: r.host, sessions: r.sessions.map((s) => [s.id, s.memory, s.processes]) }))
    c.check('Both terminals are listed with their process trees', ['near', 'far'].every((id) => r.sessions.find((s) => s.id === id)?.memory > 0), r.sessions)
    c.check("Patchbay's own memory is read", r.app.total > 50 * 1024 ** 2, r.app)
    c.check("The host's own process is read", r.host && r.host.memory > 0, r.host)
    // Electron's "swap" on Windows is the commit limit: it should match what Windows itself says.
    const os = execFileSync('powershell', ['-NoProfile', '-Command', '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize)|$($o.FreeVirtualMemory)"'], { encoding: 'utf8', windowsHide: true }).trim().split('|').map((k) => Number(k) * 1024)
    const near = (a, b) => Math.abs(a - b) / b < 0.05
    c.check('The commit limit matches Windows', near(r.system.commitLimit, os[0]), { ours: r.system.commitLimit, windows: os[0] })
    c.check('Commit left is close to what Windows says', Math.abs(r.system.commitAvail - os[1]) < 1.5 * 1024 ** 3, { ours: r.system.commitAvail, windows: os[1] })

    if (!process.env.PB_SKIP_PARKING) {
      const xterm = (id) => page.evaluate((i) => !!document.querySelector(`.react-flow__node[data-id="${i}"] .xterm`), id)
      await page.evaluate(() => window.patchbay.dispatch({ op: 'setViewport', viewport: { x: 0, y: 0, zoom: 1 } }))
      c.check('Both windows are drawn at first', (await xterm('near')) && (await xterm('far')))
      await L.waitFor('the far window to be unloaded', async () => !(await xterm('far')), 4.5 * 60_000, 2000)
      c.check('The far window was unloaded and the near one kept', !(await xterm('far')) && (await xterm('near')))
      c.check('Its session kept running', (await page.evaluate(() => window.patchbay.getStatuses())) && (await L.snapshot(page, 'far')).includes('far-marker-42'))
      await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 'far', patch: { x: 600 } }))
      await L.waitFor('the far window to be drawn again', () => xterm('far'), 25000)
      await L.waitFor('its output to show again', async () => (await L.screen(page, 'far')).join('\n').includes('far-marker-42'), 10000)
      c.check('Brought near, it is drawn again from its session, with its output', true)
    }
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
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
