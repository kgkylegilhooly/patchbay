'use strict'
// The taskbar number: which sessions it counts, and that only checking a window clears it, with real Claude sessions.
// The badge image on the taskbar itself can't be seen from here.
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile({ permissionMode: 'default' })
  const cwd = lib.workDir('attention')
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  const app = await lib.launch({ profile, realHome: true, exe })
  const { page } = app
  const attention = () => page.evaluate(() => window.patchbay.getAttention())
  const has = async (...ids) => {
    const now = (await attention()).slice().sort().join()
    return now === ids.slice().sort().join()
  }
  const until = (what, ...ids) => lib.waitFor(what, () => has(...ids), 150000)
  const idle = (id) => lib.waitFor(`${id} to go idle`, async () => (await lib.statusOf(page, id)) === 'idle', 150000)
  const row = async (title) =>
    (await page.evaluateHandle((t) => [...document.querySelectorAll('.session')].find((s) => s.querySelector('.session-title')?.textContent === t), title)).asElement()

  try {
    check('Nothing to look at to start with', await has())

    await lib.openNode(page, lib.claude('one', cwd, 40, 40, { prompt: 'Say the word one and nothing else.' }))
    await lib.openNode(page, lib.claude('two', cwd, 700, 40, { prompt: 'Say the word two and nothing else.' }))
    await until('both to finish', 'one', 'two')
    check('Two finished sessions count as two', true, await attention())
    await lib.sleep(400)
    const dots = await page.$$eval('.session-unseen', (d) => d.length)
    check('Both show a dot in the sidebar', dots === 2, dots)

    // Going back to work isn't checking it.
    await lib.submit(page, 'one', 'Say the word again and nothing else.')
    await lib.waitFor('one to work', async () => (await lib.statusOf(page, 'one')) === 'working', 60000)
    check('Starting work again does not clear it', await has('one', 'two'), await attention())
    await idle('one')
    await lib.sleep(500)
    check('A second finish still counts it once', await has('one', 'two'), await attention())

    await (await row('one')).click()
    await lib.sleep(400)
    check('Clicking its sidebar row clears only that one', await has('two'), await attention())

    await lib.fitView(page)
    const box = await (await page.$('.react-flow__node[data-id="two"] .unit-head')).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await lib.sleep(400)
    check('Clicking the window clears it', await has(), await attention())
    await lib.sleep(1800)
    check('And it stays cleared', await has(), await attention())

    // Waiting on you is different: looking isn't answering.
    await lib.openNode(page, lib.claude('asks', cwd, 40, 520, { prompt: 'Use the Write tool to create asks.txt containing ok.' }))
    await lib.waitFor('it to ask', async () => (await lib.statusOf(page, 'asks')) === 'needs-you', 120000)
    await until('it to count', 'asks')
    check('A session waiting on you counts', true)
    await (await row('asks')).click()
    await lib.sleep(600)
    check('Looking at it does not clear it while it is still waiting', await has('asks'), await attention())
    await lib.fitView(page)
    await lib.sleep(300)
    const [approval] = await page.$$('.react-flow__node[data-id="asks"] .strip-approval .btn-solid')
    await approval.click()
    await lib.waitFor('it to move on', async () => (await lib.statusOf(page, 'asks')) !== 'needs-you', 30000)
    await lib.sleep(400)
    await idle('asks')
    const after = await attention()
    console.log('  after answering and finishing:', JSON.stringify(after))
    check('Answering it clears what you were waiting on', !(after.includes('asks') && (await lib.statusOf(page, 'asks')) === 'needs-you'))

    await page.evaluate(() => window.patchbay.markSeen('asks'))
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['one', 'two', 'asks'] }))
    await lib.sleep(1800)
    check('Closing sessions leaves nothing counted', await has(), await attention())

    check('No errors in the page', app.problems.length === 0, app.problems)
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
