'use strict'
// Review Focus 2 and 3 and the quit guard on the real app, plus what proves the package stands alone.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

async function main() {
  const c = L.checker()
  const exe = L.packagedExe
  const work = L.workDir('focus')

  // Done means 8: nothing from a dev server, and code from inside the package.
  const profile = L.newProfile({ permissionMode: 'default' })
  let app = await L.launch({ profile, realHome: true, exe })
  let { page } = app
  try {
    c.check('DM8: the packaged app loads from its own files', /^file:.*app\.asar/.test(page.url()), page.url())
    await L.openNode(page, L.terminal('good', work, 20, 20))
    await L.sleep(1000)
    await L.submit(page, 'good', 'echo first-life-$((1+1))')
    await L.waitFor('output', async () => (await L.snapshot(page, 'good')).includes('first-life-2'))

    // Saved twice, so a backup of a good doc exists.
    await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 'good', patch: { title: 'first save' } }))
    await L.sleep(900)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 'good', patch: { title: 'second save' } }))
    await L.sleep(900)

    // The quit guard: a node at a permission prompt must hold the quit at a question.
    await L.openNode(page, L.claude('busy', work, 540, 20, { prompt: 'Use the Write tool to create busy.txt containing ok.' }))
    await L.waitFor('needs-you', async () => (await L.statusOf(page, 'busy')) === 'needs-you', 120000)
    await page.evaluate(() => window.patchbay.quitApp()).catch(() => {})
    const stillUp = await Promise.race([app.exited.then(() => false), L.sleep(3000).then(() => true)])
    c.check('Quit: with a node needing you, closing does not just quit', stillUp)
    await app.forceKill()
    c.check('Quit: the node had not run its tool', !fs.existsSync(path.join(work, 'busy.txt')))

    // Review Focus 2: a half-written primary. Three more nodes test Review Focus 3 at the same time.
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'canvas.json'), 'utf8'))
    saved.nodes = saved.nodes.filter((n) => n.id === 'good')
    const fixture = {
      ...saved,
      nodes: [
        ...saved.nodes,
        L.claude('gone-folder', path.join(work, 'no-such-folder'), 20, 500, { sessionId: '11111111-1111-4111-8111-111111111111' }),
        L.terminal('gone-term', path.join(work, 'no-such-folder'), 680, 500),
        L.claude('gone-chat', work, 1200, 20, { sessionId: '00000000-0000-4000-8000-000000000000' })
      ]
    }
    fs.writeFileSync(path.join(profile, 'canvas.json.bak'), JSON.stringify(fixture))
    const half = JSON.stringify(fixture).slice(0, 200)
    fs.writeFileSync(path.join(profile, 'canvas.json'), half)

    app = await L.launch({ profile, realHome: true, exe })
    page = app.page
    const doc = await L.doc(page)
    c.check('Review Focus 2: a half-written save loads the backup', doc.nodes.length === 4, doc.nodes.map((n) => n.id))
    const aside = fs.readdirSync(profile).filter((f) => f.startsWith('canvas.corrupt-'))
    c.check('Review Focus 2: the bad file is kept aside, unchanged', aside.length === 1 && fs.readFileSync(path.join(profile, aside[0]), 'utf8') === half, aside)

    const errors = await L.waitFor('the resume to fail', async () => {
      const e = await page.evaluate(() => window.patchbay.getErrors())
      return e['gone-chat'] && e
    }, 30000)
    c.check('Review Focus 3: a missing folder shows an error', errors['gone-folder']?.code === 'cwd-missing', errors['gone-folder'])
    c.check('Review Focus 3: a terminal in a missing folder shows an error', errors['gone-term']?.code === 'cwd-missing')
    c.check('Review Focus 3: a missing conversation shows an error', errors['gone-chat']?.code === 'resume-failed', errors['gone-chat'])
    await L.sleep(1000)
    await L.submit(page, 'good', 'echo second-life-$((1+1))')
    await L.waitFor('the healthy terminal', async () => (await L.snapshot(page, 'good')).includes('second-life-2'), 10000)
    c.check('Review Focus 3: the rest of the canvas loads normally', true)
    const restart = await page.evaluate(() => {
      const heads = ['gone-folder', 'gone-term', 'gone-chat'].map((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .unit-head`))
      return heads.map((h) => [...(h?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Restart'))
    })
    c.check('Review Focus 3: each offers Restart', restart.every(Boolean), restart)
    await L.fitView(page)
    console.log('screenshot:', await L.shot(page, 'focus-errors'))

    // Restart on a gone conversation starts a new one instead of failing forever.
    await page.evaluate(() => [...document.querySelectorAll('.react-flow__node[data-id="gone-chat"] .unit-head button')].find((b) => b.textContent === 'Restart').click())
    await L.waitFor('the new conversation', async () => {
      const e = await page.evaluate(() => window.patchbay.getErrors())
      return !e['gone-chat'] && (await L.statusOf(page, 'gone-chat')) === 'idle'
    }, 60000)
    c.check('Review Focus 3: Restart recovers the node', (await L.nodeOf(page, 'gone-chat')).sessionId !== '00000000-0000-4000-8000-000000000000')

    // A terminal's exit offers Restart, and restarting clears the badge.
    await L.submit(page, 'good', 'exit')
    await L.waitFor('the exit', async () => (await L.statusOf(page, 'good')) === 'exited', 10000)
    c.check('A terminal that exits shows exited', true)
    await page.evaluate(() => [...document.querySelectorAll('.react-flow__node[data-id="good"] .unit-head button')].find((b) => b.textContent === 'Restart').click())
    await L.waitFor('the badge to clear', async () => (await L.statusOf(page, 'good')) === undefined, 10000)
    c.check('Restarting it clears the badge', true)

    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(page, 'focus-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
