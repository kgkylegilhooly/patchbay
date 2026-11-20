'use strict'
// Done means 9, plus the interrupt and send checks other stations asked for. Real Claude, real clicks.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const button = (page, scope, text) =>
  page.evaluate((s, t) => {
    const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim().startsWith(t))
    if (!b) return false
    b.click()
    return true
  }, scope, text)

async function pendingFor(page, id) {
  await L.waitFor(`${id} to ask`, async () => (await L.approvals(page, id)).length > 0, 120000)
  await L.waitFor('the buttons', () => page.evaluate((i) => !!document.querySelector(`.react-flow__node[data-id="${i}"] .strip-approval .btn`), id), 5000)
}

async function main() {
  const c = L.checker()
  const exe = process.argv.includes('--packaged') ? L.packagedExe : undefined
  const work = L.workDir('dm9')
  const profile = L.newProfile({ permissionMode: 'default' })
  const app = await L.launch({ profile, exe })
  const { page } = app
  const node = (id) => `.react-flow__node[data-id="${id}"]`
  const inWork = (n) => path.join(work, n)
  try {
    // Approve with the button.
    await L.openNode(page, L.claude('a', work, 20, 20, { title: 'Approver', prompt: 'Use the Write tool to create a.txt containing ok. Then reply with only: finished' }))
    await pendingFor(page, 'a')
    console.log('screenshot:', await L.shot(page, 'dm9-approval-buttons'))
    await button(page, `${node('a')} .strip-approval`, 'Approve')
    await L.waitFor('a to finish', async () => (await L.statusOf(page, 'a')) === 'idle', 120000)
    c.check('DM9: Approve: the tool ran', fs.existsSync(inWork('a.txt')))
    c.check('DM9: Approve: the buttons cleared', (await L.approvals(page, 'a')).length === 0)

    // Deny with the button.
    await L.openNode(page, L.claude('d', work, 680, 20, { title: 'Denier', prompt: 'Use the Write tool to create d.txt containing ok. If you are not allowed, do not retry, and reply with only: refused' }))
    await pendingFor(page, 'd')
    await button(page, `${node('d')} .strip-approval`, 'Deny')
    await L.waitFor('d to finish', async () => (await L.statusOf(page, 'd')) === 'idle', 120000)
    const denied = L.transcriptText((await L.nodeOf(page, 'd')).transcriptPath)
    c.check('DM9: Deny: the tool did not run', !fs.existsSync(inWork('d.txt')))
    c.check('DM9: Deny: the agent was told and carried on', /refused/i.test(denied.split('\n').filter((l) => l.startsWith('assistant: ')).pop() ?? ''))

    // Answer in the terminal, with a real key press. The first option is yes.
    await L.openNode(page, L.claude('t', work, 1340, 20, { title: 'Terminal answer', prompt: 'Use the Write tool to create t.txt containing ok. Then reply with only: finished' }))
    await pendingFor(page, 't')
    await L.fitView(page)
    const term = await (await page.$(`${node('t')} .xterm`)).boundingBox()
    await page.mouse.click(term.x + term.width / 2, term.y + 30)
    await L.sleep(300)
    await page.keyboard.press('Enter')
    await L.waitFor('t to finish', async () => (await L.statusOf(page, 't')) === 'idle', 120000)
    c.check('DM9: Terminal answer: the tool ran', fs.existsSync(inWork('t.txt')))
    c.check('DM9: Terminal answer: the buttons cleared', (await L.approvals(page, 't')).length === 0)

    // Esc at a prompt, and Review Focus 1.
    await L.submit(page, 't', 'Use the Write tool to create esc.txt containing ok.')
    await pendingFor(page, 't')
    await page.mouse.click(term.x + term.width / 2, term.y + 30)
    await L.sleep(200)
    await page.keyboard.press('Escape')
    await L.waitFor('the buttons to clear', async () => (await L.approvals(page, 't')).length === 0, 8000)
    await L.sleep(800)
    const afterEsc = await L.statusOf(page, 't')
    c.check('Review Focus 1: Esc at a prompt gives unknown, not working', afterEsc === 'unknown', afterEsc)
    c.check('Review Focus 1: the Esc denied the tool', !fs.existsSync(inWork('esc.txt')))

    // patchbay send from a terminal, into a real Claude terminal.
    await L.openNode(page, L.terminal('sh', work, 20, 500))
    await L.sleep(1200)
    await L.submit(page, 'sh', 'patchbay open-agent --title Sendee --prompt "Reply with only: first" ; echo opened-marker-$((2*21))')
    await L.waitFor('open-agent', async () => (await L.snapshot(page, 'sh')).includes('opened-marker-42'), 30000)
    const sendee = await L.waitFor('the agent', async () => (await L.doc(page)).nodes.find((n) => n.title === 'Sendee'), 10000)
    await L.waitFor('Sendee to be idle', async () => (await L.statusOf(page, sendee.id)) === 'idle' && (await L.seenStatuses(page, sendee.id)).includes('working'), 120000)
    await L.submit(page, 'sh', `patchbay send --node ${sendee.id} --text "Reply with only the word SENTOK."; patchbay send --node ${sendee.id} --text "Reply with only the word QUEUEDOK."`)
    const transcriptOf = async () => L.transcriptText((await L.nodeOf(page, sendee.id)).transcriptPath)
    await L.waitFor('the sent message to be answered', async () => /assistant: .*SENTOK/.test(await transcriptOf()), 120000)
    c.check('send: the delayed Enter submits to a real Claude', true)
    await L.waitFor('the queued message to be answered', async () => /assistant: .*QUEUEDOK/.test(await transcriptOf()), 120000)
    c.check('send: a message sent while busy waits, then arrives', true)
    await L.submit(page, 'sh', `patchbay send --node a --text hello; echo refused-marker-$?`)
    await L.waitFor('the refusal', async () => (await L.snapshot(page, 'sh')).includes('refused-marker-1'), 15000)
    c.check("send: a node that isn't linked or opened by the caller is refused", true)
    await L.submit(page, 'sh', 'patchbay list | grep -c approv; echo no-approve-verb-$?; patchbay approve 2>&1 | head -2')
    await L.waitFor('the verb check', async () => /Unknown verb|Usage/i.test(await L.snapshot(page, 'sh')), 15000)
    c.check('no CLI verb can approve', true)

    // Find, with real keys.
    await L.submit(page, 'sh', 'echo findme-one; echo findme-two; echo findme-three')
    await L.sleep(800)
    await L.fitView(page)
    const sh = await (await page.$(`${node('sh')} .xterm`)).boundingBox()
    await page.mouse.click(sh.x + sh.width / 2, sh.y + sh.height / 2)
    await page.keyboard.down('Control')
    await page.keyboard.press('f')
    await page.keyboard.up('Control')
    await page.waitForSelector(`${node('sh')} .find input`, { timeout: 5000 })
    await page.keyboard.type('findme')
    const count = await L.waitFor('a match count', () => page.evaluate((s) => document.querySelector(`${s} .find-count`)?.textContent, node('sh')), 5000)
    c.check('DM9: find shows matches', /of \d+|\+ matches/.test(count), count)
    console.log('screenshot:', await L.shot(page, 'dm9-find'))
    await page.keyboard.press('Escape')

    // A path through a real mouse click on the real link. This file is missing on purpose: opening a
    // real one would put another app on the owner's desktop. Opening is covered by unit tests.
    await L.submit(page, 'sh', 'clear; echo see missing-folder/gone.txt')
    await L.sleep(800)
    await L.fitView(page)
    const clicked = await page.evaluate((s) => {
      const screen = document.querySelector(`${s} .xterm-screen`).getBoundingClientRect()
      const rows = [...document.querySelectorAll(`${s} .xterm-rows > div`)]
      const row = rows.findIndex((r) => r.textContent.replace(/\u00a0/g, ' ').startsWith('see '))
      const h = screen.height / rows.length
      const w = document.querySelector(`${s} .xterm-rows span`)?.getBoundingClientRect().width / (document.querySelector(`${s} .xterm-rows span`)?.textContent.length || 1)
      return { x: screen.x + w * 8, y: screen.y + h * row + h / 2, row }
    }, node('sh'))
    await page.mouse.move(clicked.x, clicked.y)
    await L.sleep(400)
    await page.mouse.click(clicked.x, clicked.y)
    const notice = await L.waitFor('the link result', () => page.evaluate((s) => document.querySelector(`${s} .term-notice span`)?.textContent, node('sh')), 8000)
    const wantPath = path.join(work, 'missing-folder', 'gone.txt')
    c.check('DM9: clicking a relative path resolves it against the node folder', notice.includes(wantPath), notice)

    // Paste an image. A synthetic paste, so the owner's clipboard isn't overwritten.
    await L.submit(page, 'sh', 'clear; cat > /dev/null')
    await L.sleep(500)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMK/gAAAABJRU5ErkJggg=='
    await page.evaluate((s, b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'x.png', { type: 'image/png' }))
      const target = document.querySelector(`${s} .term-host .xterm-helper-textarea`)
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, node('sh'), png)
    const pasted = path.join(profile, 'pastes')
    const files = await L.waitFor('the pasted file', () => fs.existsSync(pasted) && fs.readdirSync(pasted).length > 0 && fs.readdirSync(pasted), 8000)
    c.check('DM9: a pasted image is saved under app data', files.length === 1 && files[0].endsWith('.png'), files)
    await L.waitFor('the path to be typed', async () => (await L.snapshot(page, 'sh')).includes('paste-'), 8000)
    c.check('DM9: its path is typed into the terminal', true)
    await L.input(page, 'sh', '\x03')

    // The minimap, with a real drag, which pans the view. A click on its own goes to that spot.
    const vpBefore = (await L.doc(page)).viewport
    const map = await (await page.$('.react-flow__minimap')).boundingBox()
    await page.mouse.move(map.x + map.width * 0.5, map.y + map.height * 0.5)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(map.x + map.width * 0.5 + i * 4, map.y + map.height * 0.5 + i * 3)
    await page.mouse.up()
    const moved = await L.waitFor('the view to move', async () => {
      const v = (await L.doc(page)).viewport
      return (v.x !== vpBefore.x || v.y !== vpBefore.y) && v
    }, 5000)
    c.check('DM9: the minimap moves the view', true, { from: vpBefore, to: moved })

    // Close a Claude node and reopen it from recent conversations, with real clicks.
    const closingSession = (await L.nodeOf(page, 'a')).sessionId
    await page.evaluate((s) => document.querySelector(s).click(), `${node('a')} .unit-head [data-tool="close"]`)
    await L.waitFor('the node to go', async () => !(await L.nodeOf(page, 'a')), 8000)
    const history = (await L.doc(page)).closed
    c.check('DM9: closing adds it to the history', history.length === 1 && history[0].sessionId === closingSession, history[0]?.title)
    // Closed conversations is in the dock's Work menu.
    await page.evaluate(() => document.querySelector('.dock [data-cmd="work"]').click())
    await page.waitForSelector('.dock .menu-panel [data-cmd="recent"]', { timeout: 5000 })
    await page.evaluate(() => document.querySelector('.dock .menu-panel [data-cmd="recent"]').click())
    await page.waitForSelector('.drawer .recent-entry', { timeout: 5000 })
    await button(page, '.recent-entry', 'View transcript')
    await page.waitForSelector('.viewer-text', { timeout: 5000 })
    const viewed = await L.waitFor('the transcript', () => page.evaluate(() => {
      const t = document.querySelector('.viewer-text')?.textContent
      return t && !t.startsWith('Loading') && t
    }), 5000)
    c.check('DM9: View transcript shows the conversation', viewed.includes('a.txt'))
    console.log('screenshot:', await L.shot(page, 'dm9-recent'))
    await button(page, '.viewer', '×')
    await button(page, '.recent-entry', 'Reopen')
    const reopened = await L.waitFor('the reopened node', async () => (await L.doc(page)).nodes.find((n) => n.kind === 'claude' && n.sessionId === closingSession), 8000)
    c.check('DM9: Reopen adds a new node with that session and removes the entry', reopened.id !== 'a' && (await L.doc(page)).closed.length === 0)
    await L.waitFor('it to resume', async () => (await L.statusOf(page, reopened.id)) === 'idle', 60000)
    await L.sleep(1000)
    await L.submit(page, reopened.id, 'What file did you create earlier? Reply with only its name.')
    await L.waitFor('the answer', () => /assistant: .*a\.txt/.test(L.transcriptText(reopened.transcriptPath)), 120000)
    c.check('DM9: the reopened conversation remembers', true)

    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
    await L.waitFor('all idle before quit', async () => {
      const s = await L.statuses(page)
      return !Object.values(s).some((v) => v === 'working' || v === 'needs-you')
    }, 60000)
    c.check('clean quit exits 0', (await app.quit()) === 0)
  } catch (e) {
    c.check('run finished', false, e.message)
    await L.shot(page, 'dm9-failure').catch(() => {})
    await app.forceKill().catch(() => {})
  }
  L.cleanup(profile)
  c.finish()
}
main()
