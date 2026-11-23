'use strict'
// Done means 6. A real agent inside a Patchbay Claude node uses the patchbay command on its own.
const fs = require('node:fs')
const L = require('./lib.cjs')

const PROMPT = `Use the patchbay command from Bash for this. Don't use subagents.
1. Run: patchbay spawn-team --label demo --members '[{"name":"first","prompt":"Reply with only the word ALPHA7."},{"name":"second","prompt":"Reply with only the word BETA9.","after":["first"]}]'
2. Check patchbay list every few seconds until the first member's status is idle.
3. Run patchbay read --node <the first member's id> and reply with what it says.`

async function main() {
  const c = L.checker()
  const exe = process.argv.includes('--packaged') ? L.packagedExe : undefined
  const work = L.workDir('dm6')
  const profile = L.newProfile()
  const app = await L.launch({ profile, realHome: true, exe })
  const { page } = app
  try {
    await page.evaluate(() => {
      window.__order = []
      window.patchbay.onStatus((id, s) => window.__order.push([id, s, Date.now()]))
    })
    await L.openNode(page, L.claude('boss', work, 20, 20, { prompt: PROMPT }))

    const member = async (title) => (await L.doc(page)).nodes.find((n) => n.title === title)
    await L.waitFor('the team to appear', () => member('second'), 180000, 300)
    const firstId = (await member('first')).id
    const secondId = (await member('second')).id
    const group = (await L.doc(page)).nodes.find((n) => n.kind === 'group')
    c.check('DM6: spawn-team made a labelled group of two', group?.title === 'demo' && (await member('first')).parentId === group.id)
    const edges = (await L.doc(page)).edges
    c.check('DM6: members appear connected to their opener', edges.some((e) => e.from === 'boss' && e.to === firstId && e.kind === 'opened'))
    c.check('DM6: the later member is shown waiting on the first', edges.some((e) => e.from === firstId && e.to === secondId && e.kind === 'after'))

    await L.waitFor('the second member to finish', async () => (await L.statusOf(page, secondId)) === 'idle' && (await L.seenStatuses(page, secondId)).includes('working'), 180000)
    const order = await page.evaluate(() => window.__order)
    c.check('DM6: the second member was held', order.some(([id, s]) => id === secondId && s === 'queued'))
    // Claude's own timestamps, which can't be reordered by how status messages reach the window.
    const stamps = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    const firstReply = stamps((await L.nodeOf(page, firstId)).transcriptPath).filter((e) => e.type === 'assistant').pop()?.timestamp
    const secondBegan = stamps((await L.nodeOf(page, secondId)).transcriptPath).find((e) => e.type === 'user')?.timestamp
    c.check("DM6: the second member's prompt came after the first member's reply", firstReply && secondBegan && Date.parse(secondBegan) > Date.parse(firstReply), { firstReply, secondBegan })

    await L.waitFor('the boss to finish', async () => {
      const s = await L.statusOf(page, 'boss')
      const said = L.transcriptText((await L.nodeOf(page, 'boss')).transcriptPath)
      return s === 'idle' && said.includes('ALPHA7')
    }, 240000, 500)
    const said = L.transcriptText((await L.nodeOf(page, 'boss')).transcriptPath)
    c.check('DM6: the agent ran spawn-team itself', /used Bash.*spawn-team/.test(said))
    c.check('DM6: the agent ran read itself', /used Bash.*patchbay read/.test(said))
    const finalReply = said.split('\n').filter((l) => l.startsWith('assistant: ')).pop()
    c.check("DM6: the agent reported the first member's output", finalReply?.includes('ALPHA7'), finalReply)
    console.log('screenshot:', await L.shot(page, 'dm6-team'))

    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(page, 'dm6-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
