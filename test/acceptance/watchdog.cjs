'use strict'
// The app window misbehaving on purpose: a freeze, a crash, and a long hang. Patchbay should note each in its log,
// reload a crashed window by itself with the sessions still running, and say when a hung one recovers. No quota.
// Run: node test/acceptance/watchdog.cjs [--packaged]
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(6 * 60_000)

async function main() {
  const cwd = L.workDir('watchdog')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  let { page } = app
  const logFile = path.join(profile, 'logs', 'patchbay.log')
  const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
  try {
    c.check('The log starts with the version', /Patchbay [\d.]+ started/.test(await L.waitFor('the log', () => logText(), 10000).catch(() => '')), logText().slice(0, 200))
    await L.openNode(page, L.terminal('t1', cwd, 0, 0))
    await L.waitFor('the shell', async () => (await L.snapshot(page, 't1')).includes('$'), 20000)
    await L.sleep(800)
    await L.submit(page, 't1', 'echo before-crash')
    await L.sleep(800)
    const hostBefore = await page.evaluate(() => window.patchbay.getHostInfo().then((i) => i.pid))

    // 1. A freeze of a few seconds goes in the log, with what was on screen.
    await page.evaluate(() => setTimeout(() => {
      const end = Date.now() + 3000
      while (Date.now() < end) {}
    }, 0))
    const froze = await L.waitFor('the freeze in the log', () => /window was busy for 3\.\d s \(canvas, 1 terminals/.test(logText()), 15000).then(() => true, () => false)
    c.check('A freeze of the window goes in the log, with what was on screen', froze, logText().split('\n').filter((l) => /busy/.test(l)))

    // 2. A crash: the window reloads by itself, and the session it showed is still running.
    const session = await page.createCDPSession()
    await session.send('Page.crash').catch(() => {})
    const reloaded = await L.waitFor('the window to come back', async () => {
      const pages = await app.browser?.pages?.().catch(() => null)
      const live = pages?.find((p) => p.url() !== 'about:blank' && !p.url().startsWith('devtools://')) ?? page
      return (await live.$('.react-flow').catch(() => null)) ? live : null
    }, 30000).catch(() => null)
    c.check('A crashed window reloads by itself', !!reloaded, logText().split('\n').slice(-4))
    if (reloaded) page = reloaded
    c.check('The crash and the reload are in the log', /window's process ended \(crashed/.test(logText()) && /Reloading the window\./.test(logText()), logText().split('\n').slice(-4))
    const hostAfter = await page.evaluate(() => window.patchbay.getHostInfo().then((i) => i.pid)).catch(() => null)
    c.check('The sessions kept running through the crash', hostAfter === hostBefore && (await L.snapshot(page, 't1')).includes('before-crash'), { hostBefore, hostAfter })
    await page.waitForSelector('.react-flow__node[data-id="t1"] .xterm-screen', { timeout: 15000 })
    await L.sleep(800)
    await page.click('.react-flow__node[data-id="t1"] .xterm-screen')
    await page.keyboard.type('echo after-crash')
    await page.keyboard.press('Enter')
    const typed = await L.waitFor('typing after the crash', async () => /\nafter-crash/.test(await L.snapshot(page, 't1')), 10000).then(() => true, () => false)
    c.check('The terminal takes typing again after the reload', typed)

    // 3. A long hang: Electron reports it, and its end, which go in the log. The question it asks is answered by the
    // window recovering, which takes it away.
    if (!process.env.PB_SKIP_HANG) {
      await page.evaluate(() => setTimeout(() => {
        const end = Date.now() + 40_000
        while (Date.now() < end) {}
      }, 0))
      // Input is what Electron's hang check waits on, so some is sent while the page is stuck.
      const nudge = setInterval(() => app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300 + Math.random() * 50, y: 300 }).catch(() => {}), 1000)
      const hung = await L.waitFor('the hang in the log', () => /stopped responding/.test(logText()), 60_000).then(() => true, () => false)
      const recovered = await L.waitFor('the recovery in the log', () => /recovered after \d+ s/.test(logText()), 60_000).then(() => true, () => false)
      clearInterval(nudge)
      c.check('A long hang is noted in the log', hung, logText().split('\n').slice(-4))
      c.check('Its recovery is noted too', recovered, logText().split('\n').slice(-3))
    }
    console.log('LOG\n' + logText())
    const visible = await page.evaluate(() => !!document.querySelector('.react-flow'))
    c.check('The canvas is there at the end', visible)
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
