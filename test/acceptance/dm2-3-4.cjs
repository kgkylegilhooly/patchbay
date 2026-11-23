'use strict'
// Done means 2, 3 and 4 on one conversation: status at the right moments, then a clean quit and reopen,
// then a force-kill and reopen. Real Claude, small prompts, in a throwaway folder.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

async function main() {
  const c = L.checker()
  const exe = process.argv.includes('--packaged') ? L.packagedExe : undefined
  const work = L.workDir('dm234')
  const profile = L.newProfile({ permissionMode: 'default' })
  let app = await L.launch({ profile, realHome: true, exe })
  try {
    let { page } = app

    // Done means 2
    await L.openNode(page, L.claude('c1', work, 560, 20, {
      prompt: 'Remember the codeword PERSIMMON. Use the Write tool to create note.txt containing ok, then reply with only: done'
    }))
    await L.openNode(page, L.terminal('t1', work, 20, 20))
    await L.waitFor('needs-you', async () => (await L.statusOf(page, 'c1')) === 'needs-you', 120000)
    const asked = await L.waitFor('the approval strip', async () => {
      const a = await L.approvals(page, 'c1')
      return a.length && a[0]
    }, 10000)
    c.check('DM2: Claude goes needs-you at the prompt, and the node shows the tool', asked.tool === 'Write', asked)
    console.log('screenshot:', await L.shot(page, 'dm2-needs-you'))
    await page.evaluate(() => [...document.querySelectorAll('.strip-approval .btn')].find((b) => b.textContent === 'Approve').click())
    await L.waitFor('idle', async () => (await L.statusOf(page, 'c1')) === 'idle', 120000)
    const seq = await L.seenStatuses(page, 'c1')
    // A session starting up reads idle first, so the turn is what comes after the first working.
    const turn = seq.slice(seq.indexOf('working'))
    c.check('DM2: status went working, then needs-you, then idle', turn.includes('needs-you') && turn.at(-1) === 'idle' && turn.indexOf('needs-you') > 0, seq)
    c.check('DM2: the approved write happened', fs.existsSync(path.join(work, 'note.txt')))

    // Layout and scrollback to compare after coming back.
    await L.sleep(800)
    await L.submit(page, 't1', 'echo keep-this-line-$((6*7))')
    await L.waitFor('terminal output', async () => (await L.snapshot(page, 't1')).includes('keep-this-line-42'))
    await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 't1', patch: { x: 33, y: 77, title: 'kept title' } }))
    await page.evaluate(() => window.patchbay.dispatch({ op: 'setViewport', viewport: { x: 12, y: 34, zoom: 0.8 } }))
    await L.sleep(300)
    const sessionId = (await L.nodeOf(page, 'c1')).sessionId
    const transcript = (await L.nodeOf(page, 'c1')).transcriptPath

    // Done means 3
    c.check('DM3: quit exits 0 with nothing busy, so no prompt', (await app.quit()) === 0)
    app = await L.launch({ profile, realHome: true, exe })
    page = app.page
    const reopened = await L.doc(page)
    const t1 = reopened.nodes.find((n) => n.id === 't1')
    c.check('DM3: layout returns', t1.x === 33 && t1.y === 77 && t1.title === 'kept title' && reopened.viewport.zoom === 0.8, [t1.x, t1.y, t1.title, reopened.viewport])
    await L.sleep(1000)
    const back = await L.snapshot(page, 't1')
    c.check('DM3: scrollback returns', back.includes('keep-this-line-42'))
    c.check('DM3: a divider says the old process ended, above a new shell', back.indexOf('process ended') > back.indexOf('keep-this-line-42'))
    await L.submit(page, 't1', 'echo new-shell-$((1+1))')
    await L.waitFor('the new shell', async () => (await L.snapshot(page, 't1')).includes('new-shell-2'))
    c.check('DM3: the terminal has a live new shell', true)
    await L.waitFor('Claude to resume', async () => (await L.statusOf(page, 'c1')) === 'idle', 60000)
    c.check('DM3: the Claude node resumed the same session', (await L.nodeOf(page, 'c1')).sessionId === sessionId, sessionId)
    await L.sleep(1500)
    console.log('screenshot:', await L.shot(page, 'dm3-reopened'))
    await L.submit(page, 'c1', 'What was the codeword? Reply with only the word.')
    const answered = () => L.transcriptText(transcript).split('\n').filter((l) => l.startsWith('assistant: ') && l.includes('PERSIMMON'))
    await L.waitFor('the answer', () => answered().length > 0, 120000)
    c.check('DM3: Claude continues its earlier conversation', answered().length > 0, answered()[0])
    await L.waitFor('idle', async () => (await L.statusOf(page, 'c1')) === 'idle', 60000)

    // Done means 4. The autosave has its 500 ms, then the process tree goes without warning.
    await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 't1', patch: { x: 44 } }))
    await L.sleep(2500)
    await app.forceKill()
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'canvas.json'), 'utf8'))
    c.check('DM4: the save file on disk is valid after the kill', saved.version === 3 && saved.nodes.length === 2)
    app = await L.launch({ profile, realHome: true, exe })
    page = app.page
    const afterKill = await L.doc(page)
    c.check('DM4: the last autosave loads', afterKill.nodes.find((n) => n.id === 't1').x === 44)
    await L.waitFor('Claude to resume', async () => (await L.statusOf(page, 'c1')) === 'idle', 60000)
    c.check('DM4: the Claude node resumes the same session', (await L.nodeOf(page, 'c1')).sessionId === sessionId)
    await L.sleep(1000)
    await L.submit(page, 'c1', 'Repeat the codeword again. Reply with only the word.')
    await L.waitFor('the second answer', () => answered().length >= 2, 120000)
    c.check('DM4: the conversation still continues', answered().length >= 2)
    await L.waitFor('idle', async () => (await L.statusOf(page, 'c1')) === 'idle', 60000)

    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(app.page, 'dm234-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
