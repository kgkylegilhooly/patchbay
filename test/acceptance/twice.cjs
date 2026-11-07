'use strict'
// Review Focus 5. A second launch on the same profile must quit and leave the first running.
const { spawn } = require('node:child_process')
const L = require('./lib.cjs')

async function main() {
  const c = L.checker()
  const profile = L.newProfile()
  const work = L.workDir('twice')
  const first = await L.launch({ profile, exe: L.packagedExe })
  try {
    await L.openNode(first.page, L.terminal('t1', work, 20, 20))
    await L.sleep(800)

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const started = Date.now()
    const second = spawn(L.packagedExe, [`--user-data-dir=${profile}`], { env, stdio: 'ignore' })
    const code = await Promise.race([
      new Promise((r) => second.on('exit', (x) => r(x))),
      L.sleep(15000).then(() => 'still running')
    ])
    if (code === 'still running') second.kill()
    c.check('the second launch quits by itself', code === 0, { code, ms: Date.now() - started })
    await L.sleep(800)

    await L.submit(first.page, 't1', 'echo still-$((1+1))-alive')
    await L.waitFor('the first app to respond', async () => (await L.snapshot(first.page, 't1')).includes('still-2-alive'), 10000)
    c.check('the first keeps running, with its session alive', true)
    c.check('clean quit exits 0', (await first.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await first.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
