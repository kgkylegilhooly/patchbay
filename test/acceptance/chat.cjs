'use strict'
// The chat view of an agent window on the real app: it shows the conversation from the transcript, sends from its
// box, draws Markdown safely, and switches back to the terminal with nothing lost. The agent is fake-claude.cjs in
// its "chat" mode, so no quota is used. Run after npm run build.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(3 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

async function main() {
  const cwd = L.workDir('chat')
  const profile = L.newProfile({ claudeCommand: `node "${fakeClaude}"`, notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3,
    projects: [{ id: 'p1', name: 'Chat', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 1 },
    edges: [],
    closed: [],
    nodes: [{ id: 'c1', kind: 'claude', title: 'Helper', x: 0, y: 0, width: 640, height: 480, parentId: null, projectId: 'p1', cwd, prompt: 'idle chat', sessionId: null, transcriptPath: null, after: [] }]
  }))
  const app = await L.launch({ profile })
  const page = app.page
  const node = '.react-flow__node[data-id="c1"]'
  try {
    await L.waitFor('the agent', async () => (await L.statusOf(page, 'c1')) === 'idle' && !!(await L.nodeOf(page, 'c1')).transcriptPath, 30000)
    await page.click('[data-cmd="toggle-sidebar"]')
    await L.sleep(300)
    await U.headerTool(page, 'c1', 'chat')
    await page.waitForSelector(`${node} .chat`, { timeout: 5000 })
    c.check('The chat tool shows the chat view', !!(await page.$(`${node} .chat-empty`)))

    await page.type(`${node} .chat-box textarea`, 'Make the header blue')
    await page.keyboard.press('Enter')
    const reply = await L.waitFor('the reply', () => page.$$eval(`${node} .chat-msg`, (ms) => (ms.length >= 2 ? ms.map((m) => ({ role: m.dataset.chatRole, html: m.querySelector('.chat-text').innerHTML })) : null)), 15000).catch((e) => e.message)
    c.check('Enter sends, and the conversation shows both sides in order', Array.isArray(reply) && reply[0].role === 'user' && reply[0].html === 'Make the header blue' && reply[1].role === 'assistant', reply)
    c.check('The reply\'s Markdown is drawn', Array.isArray(reply) && /<strong>Make the header blue<\/strong>/.test(reply[1].html) && /<li>one<\/li>/.test(reply[1].html), reply?.[1])
    c.check('The box empties after sending', (await page.$eval(`${node} .chat-box textarea`, (t) => t.value)) === '')
    console.log('SHOT', await L.shot(page, 'chat-after-reply'))

    const before = page.url()
    await page.click(`${node} .chat-assistant a`)
    await L.sleep(500)
    c.check('A link in a reply never navigates the app window', page.url() === before, page.url())

    await U.headerTool(page, 'c1', 'chat')
    await L.sleep(300)
    const terminal = await page.$eval(`${node} .term`, (t) => t.offsetWidth > 0 && t.textContent.includes('Make the header blue'))
    c.check('Switching back shows the terminal, which saw everything', terminal)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
