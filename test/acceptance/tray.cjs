'use strict'
// Closing the window: it hides while sessions run, they keep working, and starting the app again brings it back.
// The tray icon itself can't be driven from here, so its click and menu are for the owner to try.
const { spawn, spawnSync } = require('node:child_process')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()

const visible = (page) => page.evaluate(() => document.visibilityState)
/** The message the window's own X button sends. window.close() in the page would take a different route. */
const pressClose = (app) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${app.child.pid}).CloseMainWindow()`], { stdio: 'ignore' })
const ticks = async (page, id) => ((await lib.snapshot(page, id)).match(/tick-\d+/g) ?? []).length

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const cwd = lib.workDir('tray')
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  let app = await lib.launch({ profile, exe })
  let { page } = app
  // This run measures whether the window is really hidden, which the focus emulation would mask.
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  try {
    await lib.openNode(page, lib.terminal('live', cwd, 60, 60))
    await lib.sleep(1500)
    await lib.input(page, 'live', 'i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.2; done\r')
    await lib.sleep(1200)
    check('The window starts visible', (await visible(page)) === 'visible')

    pressClose(app)
    await lib.waitFor('the window to hide', async () => (await visible(page)) === 'hidden', 8000)
    check('Closing the window hides it', true)
    const exited = await Promise.race([app.exited.then(() => true), lib.sleep(1500).then(() => false)])
    check('The app keeps running', !exited)

    const before = await ticks(page, 'live')
    await lib.sleep(2500)
    const after = await ticks(page, 'live')
    check('The session keeps working while hidden', after > before, { before, after })

    // What a second launch does: the same route as clicking the tray icon.
    const second = exe ? [exe, [`--user-data-dir=${profile}`]] : [require('electron'), [`--user-data-dir=${profile}`, lib.root]]
    // OS file pickers never open in a run: see src/main/testPickers.ts.
    const env = { ...process.env, PATCHBAY_TEST_DIALOGS: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    spawn(second[0], second[1], { cwd: lib.root, env, stdio: 'ignore' })
    await lib.waitFor('the window to come back', async () => (await visible(page)) === 'visible', 15000)
    check('Starting Patchbay again brings the window back', true)
    check('The session was there all along', (await ticks(page, 'live')) >= after)

    const code = await app.quit()
    check('File > Stop all sessions and quit exits, even with sessions running', code === 0, code)

    // With nothing running there's no reason to stay in the background.
    app = await lib.launch({ profile, exe })
    page = app.page
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['live'] }))
    await lib.waitFor('the session to stop', async () => !(await lib.doc(page)).nodes.length, 8000)
    await lib.sleep(2000)
    pressClose(app)
    const gone = await Promise.race([app.exited.then((c) => c), lib.sleep(15000).then(() => 'still running')])
    check('With nothing running, closing the window quits', gone === 0, gone)
    app.browser.disconnect()

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

