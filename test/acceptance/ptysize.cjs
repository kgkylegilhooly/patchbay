'use strict'
// Whether a session's real size matches what its window shows: fresh, restarted while running, and restarted after exiting.
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()

/** What the session itself believes, and how wide the window really wraps a long line. */
async function sizes(page, id) {
  const marker = `m${Date.now()}`
  await lib.input(page, id, `clear; echo ${marker}=$(stty size); printf '%300s\\n' | tr ' ' '#'\r`)
  return lib.waitFor('the size output', async () => {
    const rows = await lib.screen(page, id)
    const line = rows.find((r) => r.startsWith(`${marker}=`) && /=\d+ \d+$/.test(r))
    const wrap = rows.find((r) => /^#+$/.test(r))
    if (!line || !wrap) return null
    const [ptyRows, ptyCols] = line.split('=')[1].split(' ').map(Number)
    return { ptyRows, ptyCols, viewCols: wrap.length, viewRows: rows.length }
  }, 20000)
}

async function main() {
  const profile = lib.newProfile()
  const cwd = lib.workDir('ptysize')
  const app = await lib.launch({ profile, exe: process.argv.includes('--packaged') ? lib.packagedExe : undefined })
  const { page } = app
  try {
    const report = (name, s) => check(name, s.ptyCols === s.viewCols && s.ptyRows === s.viewRows, s)

    const id = await lib.openNode(page, lib.terminal('size', cwd, 60, 60))
    await lib.sleep(2500)
    report('A fresh session matches its window', await sizes(page, id))

    await page.evaluate((i) => window.patchbay.restartNode(i), id)
    await lib.sleep(2500)
    report('Restarted while running, it still matches', await sizes(page, id))

    await lib.input(page, id, 'exit\r')
    await lib.waitFor('the exit', async () => (await lib.statusOf(page, id)) === 'exited', 10000)
    await page.evaluate((i) => window.patchbay.restartNode(i), id)
    await lib.sleep(2500)
    report('Restarted after exiting, it still matches', await sizes(page, id))
  } finally {
    await app.forceKill()
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
