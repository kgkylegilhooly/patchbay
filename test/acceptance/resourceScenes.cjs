'use strict'
// Pictures of the resource view and the low-memory notice, with made-up readings: fake-resources.json in the profile,
// which only a build run from source reads (see src/main/resources/setup.ts). The sessions are the scene canvas's own.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MB = 1024 ** 2
const GB = 1024 ** 3

const readings = () =>
  JSON.stringify({
    // Nearly out of commit: 1.9 of 26 GB left, which is what stops commands starting.
    system: { totalPhys: 16 * GB, availPhys: 1.6 * GB, commitLimit: 26 * GB, commitAvail: 1.9 * GB },
    host: { memory: 182 * MB },
    sessions: {
      work: { memory: 1.4 * GB, cpu: 18 },
      'w-idle': { memory: 1.1 * GB, cpu: 0 },
      idle: { memory: 840 * MB, cpu: 0 },
      needs: { memory: 612 * MB, cpu: 1 },
      unk: { memory: 455 * MB, cpu: 0 },
      'w-term': { memory: 210 * MB, cpu: 2 },
      term: { memory: 38 * MB, cpu: 0 }
    }
  })

const files = {
  resources: () => ({ 'fake-resources.json': readings() }),
  'resources-warning': () => ({ 'fake-resources.json': readings() }),
  'memory-hold': () => ({ 'fake-resources.json': readings() })
}

const scenes = {
  // Settings > Background sessions, scrolled to what each session uses.
  resources: async (page) => {
    await page.waitForSelector('[data-resource-warning]', { timeout: 20000 }).catch(() => {})
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="sessions"]')
    await page.click('[data-section="sessions"]')
    await page.waitForSelector('[data-resources] .res-table', { timeout: 20000 })
    // A second reading, so CPU, which is measured between two, shows too.
    await sleep(3500)
    await page.click('[data-cmd="resources-refresh"]')
    await page.waitForFunction(() => !document.querySelector('[data-cmd="resources-refresh"]')?.disabled)
    await page.evaluate(() => document.querySelector('[data-resources]')?.scrollIntoView({ block: 'start' }))
    await sleep(600)
  },
  // The notice on the canvas, once memory has run short.
  'resources-warning': async (page) => {
    await page.waitForSelector('[data-resource-warning]', { timeout: 20000 })
    await sleep(400)
  },
  // A new agent started while commit is short: it waits for memory, with Start now (the shot before: it just starts).
  'memory-hold': async (page) => {
    await page.waitForSelector('[data-resource-warning]', { timeout: 20000 }).catch(() => {})
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      const near = doc.nodes.find((o) => o.id === 'term')
      const node = { id: 'held', kind: 'claude', title: 'New reviewer', x: near.x, y: near.y + near.height + 40, width: 520, height: 340, parentId: null, cwd: near.cwd, prompt: 'Review the parser', sessionId: null, transcriptPath: null, after: [], projectId: near.projectId }
      await window.patchbay.dispatch({ op: 'addNode', node })
      await window.patchbay.startNode('held')
    })
    await page.waitForSelector('.react-flow__node[data-id="held"] [data-start-fix="memory"]', { timeout: 8000 }).catch(() => {})
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('New reviewer'))?.click())
    await sleep(900)
  }
}

module.exports = { scenes, files }
