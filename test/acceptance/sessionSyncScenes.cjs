'use strict'
// Pictures for docs/plans/session-sync.md: a node the canvas shows as ended whose session the host is running again,
// and Settings > Background sessions with a session that has no node. See sessionSync.cjs for the checks.
const { startBehindItsBack, idleShell } = require('./hostIntruder.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const box = { width: 560, height: 340, parentId: null, projectId: 'p1' }

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return true
    await sleep(250)
  }
  return false
}

/** A terminal that ended, then a second client starting it again in the host, and a session with no node. */
async function behindItsBack(page, profile) {
  const cwd = await page.evaluate(async (n) => {
    const doc = await window.patchbay.getDoc()
    const cwd = doc.nodes.find((o) => o.id === 'term').cwd
    await window.patchbay.dispatch({ op: 'addNode', node: { ...n, cwd } })
    await window.patchbay.startNode(n.id)
    return cwd
  }, { ...box, id: 'old', kind: 'terminal', title: 'Dev server', x: 40, y: 60 })
  await sleep(2000)
  await page.evaluate(() => window.patchbay.input('old', 'exit\r'))
  await waitUntil(async () => (await page.evaluate(() => window.patchbay.getStatuses())).old === 'exited', 15000)
  for (let i = 0; i < 5; i++) {
    const ok = await startBehindItsBack(profile, [idleShell('old', cwd), idleShell('ghost', cwd)]).then(() => true, () => false)
    if (ok) break
  }
  // The app reconnects within a second; a check follows.
  await sleep(3000)
}

const scenes = {
  'sync-revived': async (page, { profile }) => {
    await behindItsBack(page, profile)
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="old"]')?.scrollIntoView())
    await sleep(300)
  },
  'sync-confirm': async (page, { profile }) => {
    await behindItsBack(page, profile)
    await page.click('.react-flow__node[data-id="old"] [data-joined-action="ask"]')
    await page.waitForSelector('[data-joined-confirm]', { timeout: 5000 }).catch(() => {})
    await sleep(300)
  },
  'sync-settings': async (page, { profile }) => {
    await behindItsBack(page, profile)
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="sessions"]')
    await page.click('[data-section="sessions"]')
    await page.waitForSelector('[data-sync-table]', { timeout: 10000 }).catch(() => {})
    await page.evaluate(() => document.querySelector('[data-sync-row="orphan"]')?.scrollIntoView({ block: 'center' }))
    await sleep(500)
  }
}

module.exports = { scenes, seeds: {} }
