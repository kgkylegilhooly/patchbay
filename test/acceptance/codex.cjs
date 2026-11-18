'use strict'
// A real Codex node: it starts with Patchbay's hooks, reports its status, records its session, can use the patchbay
// command from inside Codex, and resumes on restart. Spends a little Codex quota, none of Claude's.
// Codex runs with a temporary CODEX_HOME holding a copy of the owner's sign-in, so their ~/.codex is never written.
// Run after npm run build.
const fs = require('fs')
const os = require('os')
const path = require('path')
const L = require('./lib.cjs')

const c = L.checker()

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-home-'))
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(home, 'auth.json'))
  const profile = L.newProfile()
  // Outside any git repository, because Codex trusts a whole repository at once.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-work-'))
  const app = await L.launch({ profile, env: { CODEX_HOME: home } })
  const page = app.page
  const text = async (id) => (await L.screen(page, id)).join('\n')
  /** Codex asks once to trust new hooks, and a new CODEX_HOME asks about its sandbox. Both are answered here. */
  const answerSetup = async (id) => {
    const s = await text(id)
    if (/Trust this folder\?/.test(s)) {
      await L.input(page, id, '\r')
      await L.sleep(1500)
    } else if (/Trust all and continue/.test(s) || /non-admin sandbox/.test(s)) {
      await L.input(page, id, '2')
      await L.sleep(300)
      await L.input(page, id, '\r')
      await L.sleep(1500)
    }
  }
  try {
    await L.openNode(page, L.claude('cx', cwd, 0, 0, { agent: 'codex', title: 'Codex', width: 760, height: 460, prompt: 'Reply with just the word ready.' }))
    await L.fitView(page)
    const sessionId = await L.waitFor('a session id from SessionStart', async () => {
      await answerSetup('cx')
      return (await L.nodeOf(page, 'cx')).sessionId
    }, 90000, 1000).catch((e) => e.message)
    c.check('Codex starts with Patchbay hooks and reports its session', /^[0-9a-f-]{36}$/.test(sessionId), sessionId)
    const node = await L.nodeOf(page, 'cx')
    c.check('Its transcript is recorded', !!node.transcriptPath && fs.existsSync(node.transcriptPath), node.transcriptPath)

    const idle = await L.waitFor('the first turn to finish', async () => {
      await answerSetup('cx')
      const seen = await L.seenStatuses(page, 'cx')
      return seen.includes('working') && (await L.statusOf(page, 'cx')) === 'idle' ? seen : null
    }, 120000, 1000).catch((e) => e.message)
    c.check('Its status goes working, then idle', Array.isArray(idle), idle)
    console.log('SHOT', await L.shot(page, 'codex-after-first-turn'))

    // A long message is what Codex on Windows took as one paste, leaving it typed but not sent. It goes the way an
    // agent's patchbay send does, through the send queue.
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of background you can ignore.`).join(' ')
    const sent = await page.evaluate((t) => window.patchbay.sendToAgent('cx', t), `${filler} After all that, reply with just the word long.`)
    const tookLong = await L.waitFor('Codex to take the long message', async () => {
      await answerSetup('cx')
      const seen = await L.seenStatuses(page, 'cx')
      return seen.filter((s) => s === 'working').length >= 2 && (await L.statusOf(page, 'cx')) === 'idle' ? seen : null
    }, 120000, 1000).catch((e) => e.message)
    c.check('A long message is sent, not left typed in the box', sent.ok && Array.isArray(tookLong), { sent, tookLong })
    console.log('SCREEN after long message:\n' + (await text('cx')).split('\n').filter((l) => l.trim()).slice(-8).join('\n'))

    await L.submit(page, 'cx', 'Call the patchbay tool with args ["list"] and reply with only the value of its "self" field.')
    let asked = null
    const answered = await L.waitFor('Codex to run patchbay', async () => {
      await answerSetup('cx')
      // Codex asks before calling the tool, and the request arrives in Patchbay's approval buttons, as Claude's do.
      // Allowing it here stands in for the person pressing Allow.
      const pending = await L.approvals(page, 'cx')
      if (pending.length) {
        asked ??= { status: await L.statusOf(page, 'cx'), tool: pending[0].tool, summary: pending[0].summary }
        await page.evaluate((r) => window.patchbay.answerApproval(r, 'allow'), pending[0].requestId)
      }
      const s = await text('cx')
      return /Called patchbay|patchbay\.patchbay/.test(s) && (await L.statusOf(page, 'cx')) === 'idle' ? s : null
    }, 150000, 1500).catch((e) => e.message)
    console.log('ASKED', JSON.stringify(asked))
    // `patchbay list` only looks, so Patchbay lets it through without asking, as it does for Claude.
    c.check('A patchbay call that only looks goes through without asking', asked === null, asked)

    // One that changes the canvas still comes to the person, in Patchbay's approval buttons.
    await L.submit(page, 'cx', 'Call the patchbay tool with args ["sticky", "--text", "codex was here"] and reply with only the word done.')
    asked = null
    await L.waitFor('Codex to add the note', async () => {
      await answerSetup('cx')
      const pending = await L.approvals(page, 'cx')
      if (pending.length) {
        asked ??= { status: await L.statusOf(page, 'cx'), tool: pending[0].tool, summary: pending[0].summary }
        await page.evaluate((r) => window.patchbay.answerApproval(r, 'allow'), pending[0].requestId)
      }
      const doc = await L.doc(page)
      return doc.nodes.some((n) => n.kind === 'sticky' && n.text === 'codex was here') && (await L.statusOf(page, 'cx')) === 'idle'
    }, 150000, 1500).catch((e) => e.message)
    console.log('ASKED for the note', JSON.stringify(asked))
    c.check('A patchbay call that changes the canvas shows as needing you, with approval buttons', asked?.status === 'needs-you', asked)
    c.check('Allowed, it goes through and Codex carries on', (await L.doc(page)).nodes.some((n) => n.kind === 'sticky' && n.text === 'codex was here'))
    const reply = typeof answered === 'string' ? answered : ''
    c.check('Codex reaches Patchbay through the patchbay tool and reads its own id', /\bcx\b/.test(reply.split('patchbay.patchbay').pop() ?? ''), reply.slice(-600) || answered)
    console.log('SCREEN after patchbay:\n' + (await text('cx')).split('\n').filter((l) => l.trim()).slice(-14).join('\n'))
    const read = await page.evaluate(() => window.patchbay.getDoc().then((d) => d.nodes.find((n) => n.id === 'cx')))
    console.log('SHOT', await L.shot(page, 'codex-after-patchbay'))

    let lastSeen = null
    await page.evaluate(() => window.patchbay.restartNode('cx'))
    const resumed = await L.waitFor('the resumed session', async () => {
      await answerSetup('cx')
      const n = await L.nodeOf(page, 'cx')
      const status = await L.statusOf(page, 'cx')
      lastSeen = { status, sessionId: n.sessionId }
      return status === 'idle' && n.sessionId === read.sessionId ? n.sessionId : null
    }, 60000, 1000).catch((e) => e.message)
    console.log('AFTER RESTART', JSON.stringify(lastSeen), 'was', read.sessionId)
    c.check('Restart resumes the same conversation', resumed === read.sessionId, resumed)
    console.log('SHOT', await L.shot(page, 'codex-after-restart'))
    console.log('SCREEN after restart:\n' + (await text('cx')).split('\n').filter((l) => l.trim()).slice(-14).join('\n'))
    const errors = await page.evaluate(() => window.patchbay.getErrors?.())
    c.check('No error is shown on the node', !errors || !errors.cx, errors)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
