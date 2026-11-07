'use strict'
// Task 10 Step 5: the same exercise as wiring.cjs, but through `electron-vite dev` and its dev server.
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const puppeteer = require('puppeteer-core')
const L = require('./lib.cjs')

async function main() {
  const c = L.checker()
  const work = L.workDir('dev')
  const profile = L.newProfile()
  const port = 9300 + Math.floor(Math.random() * 400)
  const env = { ...process.env, ANTHROPIC_MODEL: 'claude-haiku-5-5' }
  delete env.ELECTRON_RUN_AS_NODE
  const bin = path.join(L.root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const child = spawn(process.execPath, [bin, 'dev', '--remoteDebuggingPort', String(port), '--', `--user-data-dir=${profile}`, '--disable-features=CalculateNativeWinOcclusion'], { cwd: L.root, env, stdio: 'ignore' })
  let browser
  try {
    browser = await L.waitFor('the debugging port', () => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }), 60000, 500)
    const page = await L.waitFor('the app window', async () => (await browser.pages()).find((p) => p.url().startsWith('http://localhost')), 30000)
    c.check('the app loads from the dev server', true, page.url())
    await page.waitForSelector('.react-flow', { timeout: 30000 })
    await L.openNode(page, L.terminal('t1', work, 20, 20))
    await L.openNode(page, L.claude('c1', work, 540, 20, { prompt: 'Reply with only the word READY.' }))
    await L.sleep(1500)
    await L.submit(page, 't1', 'echo dev-marker-$((40+2))')
    await L.waitFor('terminal output', async () => (await L.snapshot(page, 't1')).includes('dev-marker-42'), 15000)
    c.check('a live shell answers under npm run dev', true)
    await L.waitFor('Claude to reply', async () => (await L.statusOf(page, 'c1')) === 'idle' && L.transcriptText((await L.nodeOf(page, 'c1')).transcriptPath).includes('READY'), 120000)
    c.check('a real Claude node reaches idle with a real status badge', await page.evaluate(() => /Idle/.test(document.querySelector('.react-flow__node[data-id="c1"] .unit-head').textContent)))
    console.log('screenshot:', await L.shot(page, 'dev-run'))
  } catch (e) {
    c.check('run finished', false, e.message)
  }
  if (browser) browser.disconnect()
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await L.sleep(1000)
  L.cleanup(profile)
  c.finish()
}
main()
