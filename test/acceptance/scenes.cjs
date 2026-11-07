'use strict'
// Named canvases for `node screenshot.js <out.png> --scene <name>`. The Claude windows run fake-claude.cjs, so every
// status shows for real with no plan quota spent. The same scenes make the before and after pictures.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const box = { parentId: null, width: 560, height: 300 }
const view = { x: 0, y: 0, zoom: 0.8 }

function canvas(cwd) {
  const claude = (id, title, x, y, prompt, projectId = 'p1', extra = {}) => ({
    ...box, id, kind: 'claude', title, x, y, cwd, prompt, sessionId: null, transcriptPath: null, after: [], projectId, ...extra
  })
  const terminal = (id, title, x, y, projectId = 'p1', extra = {}) => ({ ...box, id, kind: 'terminal', title, x, y, cwd, projectId, ...extra })
  return {
    version: 2,
    projects: [
      { id: 'p1', name: 'Patchbay', folder: cwd, viewport: view },
      { id: 'p2', name: 'Website', folder: cwd, viewport: view }
    ],
    activeProjectId: 'p1',
    viewport: { x: 300, y: 20, zoom: 0.72 },
    edges: [],
    closed: [
      { id: 'closed-b', title: 'Landing page copy', cwd, sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', transcriptPath: null, closedAt: Date.now() - 26 * 3600_000, projectId: 'p2' },
      { id: 'closed-a', title: 'Parser review', cwd, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', transcriptPath: null, closedAt: Date.now() - 40 * 60_000, projectId: 'p1' }
    ],
    nodes: [
      { id: 'g1', kind: 'group', title: 'Backend', x: 0, y: 0, width: 620, height: 700, parentId: null, worktree: null, projectId: 'p1' },
      claude('needs', 'Fix the login', 24, 64, 'needs context=71', 'p1', { parentId: 'g1' }),
      claude('work', 'Write parser tests', 24, 380, 'working context=38', 'p1', { parentId: 'g1' }),
      claude('idle', 'Review the docs', 660, 0, 'idle context=12'),
      claude('unk', 'Old agent', 660, 330, 'unknown'),
      terminal('term', 'Dev shell', 1240, 0),
      { ...box, id: 'run', kind: 'run', title: 'npm test', x: 1240, y: 330, cwd, command: 'echo run-finished', projectId: 'p1' },
      { id: 'note', kind: 'sticky', title: 'Note', text: '## Plan\n- Fix login\n- Ship', x: 660, y: 660, width: 240, height: 150, parentId: null, projectId: 'p1' },
      terminal('w-term', 'Site server', 40, 40, 'p2'),
      claude('w-idle', 'Landing page', 640, 40, 'idle context=55', 'p2')
    ]
  }
}

const rightClickCanvas = async (page) => {
  const spot = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect()
    for (let y = stage.bottom - 40; y > stage.top; y -= 20) {
      for (let x = stage.left + stage.width / 2; x < stage.right; x += 20) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return { x: stage.right - 120, y: stage.bottom - 160 }
  })
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
}

const fitAll = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(500)
}

/** One of each kind of link, so a picture can show how they differ. */
const seedLinks = (page) =>
  page.evaluate(async () => {
    const edge = (id, from, to, kind) => window.patchbay.dispatch({ op: 'addEdge', edge: { id, from, to, kind } })
    await edge('e-open', 'idle', 'term', 'opened')
    await edge('e-link', 'unk', 'run', 'link')
    await edge('e-after', 'work', 'unk', 'after')
    // Far enough apart that each cable can be seen.
    const move = (id, x, y) => window.patchbay.dispatch({ op: 'patchNode', id, patch: { x, y } })
    await move('idle', 860, 0)
    await move('unk', 860, 400)
    await move('term', 1700, 0)
    await move('run', 1700, 400)
  })

/** A trigger beside the terminal, aimed at it, next to the Claude window it could also reach. */
const seedTrigger = (page) =>
  page.evaluate(async () => {
    await window.patchbay.dispatch({
      op: 'addNode',
      node: {
        id: 'trig', kind: 'trigger', title: 'Nightly check', x: 900, y: 680, width: 360, height: 400, parentId: null, projectId: 'p1',
        schedule: { type: 'interval', everyMs: 600000 }, prompt: 'echo checking the build', targetId: 'term', armedSpec: null, armedAt: null, nextAt: null, runs: []
      }
    })
  })

const showLegend = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
  await sleep(150)
  if (!(await page.$('.legend'))) await page.click('.menu-panel [data-cmd="toggle-legend"]')
  else await page.keyboard.press('Escape')
  await sleep(150)
}

/** Each one prepares what the picture shows, once the seeded canvas is up. Selectors that only exist after a change are guarded. */
const scenes = {
  canvas: async () => {},
  links: async (page) => {
    await seedLinks(page)
    await showLegend(page)
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(200)
    await fitAll(page)
  },
  'links-reduced': async (page) => {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await scenes.links(page)
  },
  trigger: async (page) => {
    await seedTrigger(page)
    await page.evaluate(async () => {
      const node = (await window.patchbay.getDoc()).nodes.find((n) => n.id === 'trig')
      const spec = JSON.stringify([['interval', node.schedule.everyMs], node.prompt, node.targetId])
      await window.patchbay.armTrigger('trig', spec)
      await window.patchbay.runTriggerNow('trig')
    })
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(800)
    await fitAll(page)
  },
  'trigger-arm': async (page) => {
    await seedTrigger(page)
    await page.click('[data-cmd="toggle-sidebar"]')
    await sleep(300)
    await page.click('.react-flow__node[data-id="trig"] [data-trigger-action="arm"]')
    await sleep(300)
  },
  'trigger-form': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-trigger"]')
    await sleep(200)
    await page.type('form[aria-label="New trigger"] [name="prompt"]', 'Run the tests and summarize any failures.')
    await page.select('form[aria-label="New trigger"] [name="target"]', 'idle')
    await sleep(200)
  },
  'run-config': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-run-config"]')
    await sleep(800)
  },
  node: async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Dev shell'))?.click())
    await sleep(600)
  },
  narrow: async (page) => {
    await page.evaluate(() => {
      window.patchbay.dispatch({ op: 'patchNode', id: 'term', patch: { width: 300 } })
      window.patchbay.dispatch({ op: 'patchNode', id: 'run', patch: { width: 300 } })
      window.patchbay.dispatch({ op: 'patchNode', id: 'idle', patch: { width: 340 } })
    })
    await sleep(500)
    await page.evaluate(() => [...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Dev shell'))?.click())
    await sleep(600)
  },
  browser: async (page) => {
    // A browser node beside the others, on a blank page, since a picture can't count on the network.
    const box = { kind: 'browser', parentId: null, projectId: 'p1', url: 'about:blank', width: 380, height: 220 }
    await page.evaluate((b) => window.patchbay.dispatch({ op: 'addNode', node: { ...b, id: 'web', title: 'Browser', x: 930, y: 640 } }), box)
    await sleep(1200)
  },
  'canvas-menu': async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
  },
  status: async (page) => {
    await page.click('[data-sidebar-tab="status"]')
    await sleep(200)
    await page.click('[data-section="recent"]')
    await sleep(200)
  },
  palette: async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await sleep(200)
    await page.type('.palette-input', 'new')
    await sleep(200)
  },
  shortcuts: async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await sleep(300)
    await page.click('[data-section="keys"]')
    await sleep(200)
    await page.click('[data-bind="tidy"]')
    await page.keyboard.down('Control')
    await page.keyboard.press('r')
    await page.keyboard.up('Control')
    await sleep(200)
  },
  team: async (page) => {
    await rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="spawn-team"]')
    await sleep(200)
    await page.type('[name="task"]', 'Add dark mode to the settings page, with tests')
    await sleep(200)
  },
  maximized: async (page) => {
    await page.click('.react-flow__node[data-id="idle"] [data-tool="maximize"]')
    await sleep(600)
  },
  font: async (page) => {
    for (let i = 0; i < 4; i++) await page.click('.react-flow__node[data-id="idle"] [data-tool="font-larger"]')
    await sleep(500)
  },
  'closed-project': async (page) => {
    const tabs = await page.$$('.project-tab')
    await tabs[1].click({ button: 'right' })
    await sleep(200)
    await page.click('.menu-panel [data-cmd="close-project"]')
    await sleep(500)
  },
  'delete-confirm': async (page) => {
    const tabs = await page.$$('.project-tab')
    await tabs[1].click({ button: 'right' })
    await sleep(200)
    await page.click('.menu-panel [data-cmd="delete-project"]')
    await sleep(200)
  },
  'file-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(200)
  },
  'view-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'View').click())
    await sleep(200)
  },
  'settings-sessions': async (page) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="sessions"]')
    await page.click('[data-section="sessions"]')
    await sleep(400)
  },
  'project-menu': async (page) => {
    const tab = await page.$('.project-tab')
    await tab.click({ button: 'right' })
    await sleep(200)
  }
}

const launchJsonExample = `{
  // Written the way VS Code writes it, comments and trailing commas included.
  "version": "0.2.0",
  "configurations": [
    { "type": "node", "request": "launch", "name": "Dev server", "program": "\${workspaceFolder}/server.js", "args": ["--port", "3000"], "skipFiles": ["<node_internals>/**"], },
    { "type": "node", "request": "launch", "name": "Worker", "runtimeExecutable": "npm", "runtimeArgs": ["run", "worker"] },
    { "type": "node", "request": "launch", "name": "Build then serve", "program": "server.js", "preLaunchTask": "build" },
    { "type": "chrome", "request": "launch", "name": "Open in Chrome", "url": "http://localhost:3000" },
  ],
  "compounds": [{ "name": "Server and worker", "configurations": ["Dev server", "Worker"] }],
}
`

function prepare(name, cwdRoot) {
  if (!scenes[name]) throw new Error(`No scene called ${name}. There are: ${Object.keys(scenes).join(', ')}`)
  const cwd = fs.mkdtempSync(path.join(cwdRoot ?? os.tmpdir(), 'patchbay-scene-'))
  const fake = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')
  // For the run configuration pictures: one that runs, a compound, and ones that can't, each saying why.
  fs.mkdirSync(path.join(cwd, '.vscode'))
  fs.writeFileSync(path.join(cwd, '.vscode', 'launch.json'), launchJsonExample)
  return {
    cwd,
    doc: canvas(cwd),
    settings: { claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off' },
    act: scenes[name]
  }
}

module.exports = { prepare, scenes, canvas, rightClickCanvas, seedLinks, showLegend }
