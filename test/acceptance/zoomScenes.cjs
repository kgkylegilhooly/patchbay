'use strict'
// Screenshot scenes for semantic zoom and the header's ⋯ menu: `node screenshot.js <out.png> --scene zoom-far`.
// The same scenes make the before and after pictures. Selectors that only exist after the change are guarded.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const at = (doc, viewport) => {
  doc.viewport = viewport
  doc.projects[0].viewport = viewport
}

/** A wall of agents in every status, for the overview. */
const wall = (doc) => {
  const cwd = doc.projects[0].folder
  const prompts = ['working context=40', 'idle context=12', 'needs context=71', 'working context=22', 'idle context=55', 'permission', 'working context=64', 'unknown', 'idle context=8']
  const titles = ['Parser tests', 'Docs pass', 'Fix the login', 'Billing API', 'Landing copy', 'Ship the fix', 'Search index', 'Old agent', 'Release notes']
  for (let i = 0; i < 9; i++) {
    doc.nodes.push({
      id: `wall${i}`, kind: 'claude', title: titles[i], x: (i % 3) * 600, y: 1000 + Math.floor(i / 3) * 340, width: 560, height: 300,
      parentId: null, cwd, prompt: prompts[i], sessionId: null, transcriptPath: null, after: [], projectId: 'p1'
    })
  }
}

/** The other kinds of node with a title bar, below the windows: a whiteboard, a trigger and a browser. */
const kinds = (doc) => {
  const ink = '#1f1f22'
  doc.nodes = doc.nodes.filter((n) => n.id !== 'note')
  doc.nodes.push(
    { id: 'board', kind: 'whiteboard', title: 'Login flow sketch', x: 660, y: 660, width: 700, height: 460, parentId: null, projectId: 'p1',
      shapes: [{ type: 'rect', color: ink, size: 4, x1: 40, y1: 120, x2: 170, y2: 190 }, { type: 'text', color: '#2f6fd6', size: 8, x: 36, y: 30, text: 'Login flow' }] },
    { id: 'trig', kind: 'trigger', title: 'Nightly check', x: 1400, y: 660, width: 360, height: 400, parentId: null, projectId: 'p1',
      schedule: { type: 'interval', everyMs: 600000 }, prompt: 'echo checking the build', targetId: 'term', armedSpec: null, armedAt: null, nextAt: null, runs: [] },
    { id: 'web', kind: 'browser', title: 'Preview', x: 0, y: 760, width: 560, height: 340, parentId: null, projectId: 'p1', url: 'about:blank' }
  )
}

const seeds = {
  // An agent asking to run a command, zoomed out: the tile says what, and Approve and Deny stay under it.
  'zoom-far-approval': (doc) => {
    const idle = doc.nodes.find((n) => n.id === 'idle')
    doc.nodes.push({ ...idle, id: 'asks', title: 'Ship the fix', x: 0, y: 760, prompt: 'permission' })
    at(doc, { x: 340, y: -120, zoom: 0.5 })
  },
  // Each kind of title bar, zoomed out.
  'zoom-far-kinds': (doc) => {
    kinds(doc)
    at(doc, { x: 340, y: 40, zoom: 0.42 })
  },
  // Close up: the header at full size, with its tools.
  'zoom-near': (doc) => at(doc, { x: 316, y: 40, zoom: 1 }),
  'zoom-menu': (doc) => at(doc, { x: 316, y: 40, zoom: 1 }),
  'zoom-menu-keys': (doc) => at(doc, { x: 316, y: 40, zoom: 1 }),
  // Zoomed out to where the header used to be too small to read.
  'zoom-far': (doc) => at(doc, { x: 340, y: 60, zoom: 0.5 }),
  'zoom-far-hover': (doc) => at(doc, { x: 340, y: 60, zoom: 0.5 }),
  // A wall of agents, far enough out that each one is a tile.
  'zoom-overview': (doc) => {
    wall(doc)
    at(doc, { x: 340, y: 50, zoom: 0.24 })
  }
}

const waitForHeads = async (page) => {
  await page.waitForSelector('.react-flow__node[data-id="needs"] .unit-head', { timeout: 10000 })
  // Long enough for the fake agents to report their status.
  await sleep(2500)
}

const openMenu = async (page, id) => {
  const more = `.react-flow__node[data-id="${id}"] [data-tool="more"]`
  if (await page.$(more)) await page.click(more)
  await sleep(300)
}

const scenes = {
  'zoom-near': waitForHeads,
  'zoom-far': waitForHeads,
  'zoom-far-kinds': waitForHeads,
  'zoom-far-approval': async (page) => {
    await waitForHeads(page)
    await page.waitForSelector('.react-flow__node[data-id="asks"] .strip-approval', { timeout: 15000 })
    await sleep(500)
  },
  'zoom-overview': waitForHeads,
  'zoom-far-hover': async (page) => {
    await waitForHeads(page)
    const head = await page.$('.react-flow__node[data-id="idle"] .unit-head')
    const box = await head.boundingBox()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2)
    await sleep(300)
  },
  'zoom-menu': async (page) => {
    await waitForHeads(page)
    await openMenu(page, 'needs')
  },
  // Shift+F10 on a focused node opens the same menu, and the arrows move through it.
  'zoom-menu-keys': async (page) => {
    await waitForHeads(page)
    await page.focus('.react-flow__node[data-id="idle"]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('F10')
    await page.keyboard.up('Shift')
    await sleep(200)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await sleep(200)
  }
}

module.exports = { scenes, seeds, openMenu }
