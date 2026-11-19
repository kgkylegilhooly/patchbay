'use strict'
// Screenshot scenes for "Next needing you" and the peek: `node screenshot.js <out.png> --scene needs-you-jump` (or
// `needs-you-peek`). Two pretend Claude windows wait on the person, one in each project, with real transcripts.
const fs = require('node:fs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const says = (text) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const asks = (id, name, input) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const user = (text) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } })

function seed(doc) {
  const login = doc.nodes.find((n) => n.id === 'needs')
  login.prompt = 'needs chat context=71'
  // The other project's window waits too, so a jump has somewhere else to go.
  doc.nodes.push({ ...login, id: 'w-needs', title: 'Pricing page', x: 40, y: 380, parentId: null, projectId: 'p2', prompt: 'needs chat' })
}

const conversations = {
  needs: [
    user('Fix the login redirect loop on staging.'),
    says('The loop comes from the session cookie being set for `app.example.com` while the redirect goes to `www`. I changed the cookie domain to `.example.com` and added a test.\n\nThe staging database still has the old sessions, which will keep looping until they are cleared. I need to run the cleanup migration against staging to clear them.'),
    asks('t1', 'Bash', { command: 'npm run db:migrate -- --env staging --only clear-sessions' })
  ],
  'w-needs': [user('Tidy up the pricing page.'), says('Which plan should be highlighted as recommended?'), asks('t2', 'AskUserQuestion', { questions: [{ question: 'Which plan should be highlighted as recommended?' }] })]
}

/** Waits for both pretend windows to start their transcripts, then writes their conversations into them. */
async function writeConversations(page) {
  const deadline = Date.now() + 20000
  for (;;) {
    const paths = await page.evaluate(() => window.patchbay.getDoc().then((d) => Object.fromEntries(d.nodes.filter((n) => n.transcriptPath).map((n) => [n.id, n.transcriptPath]))))
    if (paths.needs && paths['w-needs']) {
      for (const [id, lines] of Object.entries(conversations)) fs.appendFileSync(paths[id], lines.join('\n') + '\n')
      return
    }
    if (Date.now() > deadline) throw new Error('The pretend windows never started their transcripts')
    await sleep(300)
  }
}

const scenes = {
  'needs-you-jump': async (page) => {
    await writeConversations(page)
    await sleep(1500)
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('KeyJ')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')
    await sleep(1200)
  },
  'needs-you-peek': async (page) => {
    await writeConversations(page)
    await page.click('[data-sidebar-tab="status"]')
    await sleep(1200)
    const peek = await page.$('[data-peek="w-needs"]')
    if (peek) {
      await page.hover('[data-session="w-needs"]')
      await peek.click()
      await sleep(800)
    }
  }
}

module.exports = { scenes, seeds: { 'needs-you-jump': seed, 'needs-you-peek': seed } }
