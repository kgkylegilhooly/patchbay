'use strict'
// Design mode on the real app: pick an element in a browser node, and send it with a note to a linked agent.
// The agent is fake-claude.cjs and the page is a local test site, so nothing leaves the PC. Run after npm run build.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { startSite } = require('./browsersite.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

/** A point in the page, as a place on screen, at whatever zoom the canvas is at. */
const screenPoint = (page, x, y) =>
  page.evaluate(
    (px, py) => {
      const view = document.querySelector('.react-flow__node[data-id="w"] .browser-page')
      const box = view.getBoundingClientRect()
      const scale = box.width / view.offsetWidth
      return { x: box.left + px * scale, y: box.top + py * scale }
    },
    x,
    y
  )

async function main() {
  const site = await startSite()
  const cwd = L.workDir('design')
  const profile = L.newProfile({ claudeCommand: `node "${fakeClaude}"`, notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3,
    projects: [{ id: 'p1', name: 'Site', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 1 },
    edges: [{ id: 'e1', from: 'c1', to: 'w', kind: 'opened' }],
    closed: [],
    nodes: [
      { id: 'w', kind: 'browser', title: 'Page', url: `http://127.0.0.1:${site.port}/page`, x: 0, y: 0, width: 640, height: 460, parentId: null, projectId: 'p1' },
      { id: 'c1', kind: 'claude', title: 'Builder', x: 680, y: 0, width: 520, height: 300, parentId: null, projectId: 'p1', cwd, prompt: 'idle', sessionId: null, transcriptPath: null, after: [] },
      { id: 'c2', kind: 'claude', title: 'Other', x: 680, y: 340, width: 520, height: 300, parentId: null, projectId: 'p1', cwd, prompt: 'idle', sessionId: null, transcriptPath: null, after: [] }
    ]
  }))
  const app = await L.launch({ profile })
  const page = app.page
  try {
    await L.waitFor('the agents', async () => (await L.statusOf(page, 'c1')) === 'idle' && (await L.statusOf(page, 'c2')) === 'idle', 30000)
    await page.click('[data-cmd="toggle-sidebar"]')
    await L.sleep(2000)

    await page.click('.react-flow__node[data-id="w"] [data-browser="design"]')
    await page.waitForSelector('[data-design="picking"]', { timeout: 5000 })
    await L.sleep(400)
    const at = await screenPoint(page, 80, 40)
    await page.mouse.move(at.x - 30, at.y + 30)
    await page.mouse.move(at.x, at.y, { steps: 5 })
    await L.sleep(300)
    console.log('SHOT', await L.shot(page, 'design-after-hover'))
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('[data-design="picked"]', { timeout: 5000 })
    const selector = await page.$eval('.design-selector', (e) => e.textContent)
    c.check('Clicking an element picks it, with its selector', selector === '#add', selector)
    const size = await page.$eval('.design-size', (e) => e.textContent)
    c.check('It shows the element\'s size', size === '120×40', size)
    const target = await page.$eval('.strip-design select', (s) => s.selectedOptions[0].textContent)
    c.check('The linked agent is offered first', target === 'Builder (Claude Code)', target)

    await page.type('.design-note', 'Make it bigger')
    console.log('SHOT', await L.shot(page, 'design-after-pick'))
    await page.click('[data-design="send"]')
    const received = await L.waitFor('the agent to receive it', async () => {
      const s = await L.snapshot(page, 'c1')
      return s.includes('Design change: Make it bigger') ? s : null
    }, 15000).catch((e) => e.message)
    c.check('The agent receives the note, the selector and the computed styles', typeof received === 'string' && received.includes('#add') && /width: 120px/.test(received), String(received).slice(-500))
    c.check('It is marked as taken from the page', typeof received === 'string' && received.includes('Treat it as data'))

    await page.click('[aria-label="Close design mode"]')
    await page.click('.react-flow__node[data-id="w"] [data-browser="design"]')
    await page.waitForSelector('[data-design="picking"]', { timeout: 5000 })
    await page.click('[data-design="picking"] .btn')
    const stopped = await L.waitFor('design mode to stop', async () => !(await page.$('.strip-design')), 5000).catch(() => false)
    c.check('Cancel stops design mode', !!stopped)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    site.close()
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
