'use strict'
// Task 10 Step 5. One real terminal and one real Claude node. Usage: node test/acceptance/wiring.cjs [--packaged]
const L = require('./lib.cjs')

async function main() {
  const c = L.checker()
  const exe = process.argv.includes('--packaged') ? L.packagedExe : undefined
  const work = L.workDir('wiring')
  // A variable from another app Patchbay was started in, named in envNotPassed, must not reach its sessions.
  const profile = L.newProfile({ envNotPassed: 'OTHERAPP_' })
  const app = await L.launch({ profile, realHome: true, exe, env: { OTHERAPP_NODE_ID: 'outer' } })
  const { page } = app
  try {
    await L.openNode(page, L.terminal('t1', work, 20, 20))
    await L.openNode(page, L.claude('c1', work, 540, 20, { prompt: 'Reply with only the word READY.' }))

    await L.sleep(1500)
    await L.submit(page, 't1', 'echo marker-$((40+2)); env | grep -c OTHERAPP_; patchbay list | head -c 60; echo')
    const seen = await L.waitFor('terminal output', async () => {
      const s = await L.snapshot(page, 't1')
      return s.includes('marker-42') && s.includes('"self"') && s
    }, 20000).catch(() => L.snapshot(page, 't1'))
    c.check('a real shell runs and echoes', seen.includes('marker-42'))
    c.check('the session has none of the variables named in envNotPassed', /\n0\r?\n/.test(seen))
    c.check('patchbay list works in a terminal', seen.includes('"self"'))
    c.check('a running terminal shows no status badge', (await L.statusOf(page, 't1')) === undefined)

    const idle = await L.waitFor('Claude to finish', async () => (await L.statusOf(page, 'c1')) === 'idle' && (await L.seenStatuses(page, 'c1')).includes('working'), 120000)
    c.check('Claude went working then idle', idle, await L.seenStatuses(page, 'c1'))
    const node = await L.nodeOf(page, 'c1')
    c.check('session id and transcript were recorded', node.sessionId && node.transcriptPath, node.sessionId)
    c.check('the reply is in the transcript', L.transcriptText(node.transcriptPath).includes('READY'))
    console.log('after:', await L.shot(page, 'wiring'))
    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
