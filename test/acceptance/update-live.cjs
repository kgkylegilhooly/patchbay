'use strict'
// Installing a new version while sessions keep running, as when Patchbay is used to work on itself. A packaged build in
// a throwaway folder stands in for the installed copy. A terminal counts; the app quits leaving it running; the whole
// install folder is deleted and the build put back, as an installer replaces it; and the app, opened again, finds the
// same session still counting. Before the host ran from its own copy of the program, the delete failed: the host held
// the program's files open. Uses no quota.
//
// Run after npm run package: node test/acceptance/update-live.cjs
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)

async function main() {
  const built = path.dirname(L.packagedExe)
  if (!fs.existsSync(L.packagedExe)) throw new Error('Run npm run package first.')
  const work = L.workDir('update-live')
  const installDir = path.join(work, 'Programs', 'patchbay')
  const runtimes = path.join(work, 'host-runtime')
  fs.cpSync(built, installDir, { recursive: true })
  const exe = path.join(installDir, 'Patchbay.exe')
  const env = { PATCHBAY_HOST_RUNTIME_DIR: runtimes }
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const counter = path.join(work, 'counter.cjs')
  const last = path.join(work, 'counter.last')
  fs.writeFileSync(counter, `let n=0;setInterval(()=>{n++;require('fs').writeFileSync(${JSON.stringify(last)},String(n));process.stdout.write('count '+n+'\\r\\n')},200)`)
  const readCount = () => {
    for (let i = 0; i < 5; i++) {
      const n = Number(fs.readFileSync(last, 'utf8'))
      if (Number.isFinite(n) && n > 0) return n
    }
    return 0
  }

  let app = await L.launch({ profile, exe, env })
  try {
    await L.openNode(app.page, L.terminal('count', work, 40, 40))
    await L.waitFor('the shell', async () => (await L.snapshot(app.page, 'count')).includes('$'), 30000)
    await L.submit(app.page, 'count', `node "${counter.replace(/\\/g, '/')}"`)
    await L.waitFor('counting', () => fs.existsSync(last) && readCount() > 3, 20000)
    const host = L.hostPid(profile)
    const hostExe = require('node:child_process')
      .execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${host}").ExecutablePath`], { encoding: 'utf8' })
      .trim()
    c.check('The host runs from its own copy of the program, outside the install folder', hostExe.startsWith(runtimes) && !hostExe.startsWith(installDir), hostExe)

    c.check('Quitting leaves the session running', (await app.quitLeavingSessions()) === 0 && L.alive(host))
    const before = readCount()

    // An app that has just quit takes a moment to be gone, its exit guard up to 4 s. An installer waits for it too.
    const fromInstall = () =>
      require('node:child_process')
        .execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${installDir.replace(/'/g, "''")}*' } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }`], { encoding: 'utf8' })
        .trim()
    const still = await L.waitFor('the old app to be gone', () => !fromInstall(), 10000).then(() => '', () => fromInstall())
    c.check('Nothing runs from the install folder once the app has quit', still === '', still)

    // The installer's part: the old program goes, the new one goes in its place.
    let replaced = true
    try {
      fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
      fs.cpSync(built, installDir, { recursive: true })
    } catch (e) {
      replaced = e.code ?? e.message
    }
    c.check('The install folder can be replaced while the session runs', replaced === true, replaced)
    await L.sleep(1500)
    c.check('The session kept running through it', L.alive(host) && readCount() > before, { before, now: readCount() })

    app = await L.launch({ profile, exe, env })
    const info = await app.page.evaluate(() => window.patchbay.getHostInfo())
    c.check('The new version reconnects to the same host', info.mode === 'background' && info.pid === host, info)
    const shown = await L.waitFor('the count to show', async () => {
      const text = await L.snapshot(app.page, 'count')
      const counts = [...text.matchAll(/count (\d+)/g)].map((m) => Number(m[1]))
      return counts.length && counts.at(-1) > before ? counts.at(-1) : null
    }, 15000).catch(() => null)
    c.check('Its window shows the count still going', shown !== null, shown)
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    fs.rmSync(runtimes, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
