'use strict'
// Screenshot scenes for tidy: `node screenshot.js <out.png> --scene tidy-messy` (and tidy-old, tidy-preview, tidy-after).
// A messy canvas: a lead and the team it opened scattered and stacked, a trigger far from its target, a note far from
// the agent it's linked to, a group, and agents in every status. tidy-old shows what the old Tidy canvas did with it
// (one grid of everything); tidy-preview the new preview; tidy-after the result once applied.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fitAll = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(500)
}

function messy(doc) {
  const cwd = doc.projects[0].folder
  const box = { parentId: null, width: 520, height: 300, projectId: 'p1' }
  const agent = (id, title, x, y, prompt, extra = {}) => ({ ...box, id, kind: 'claude', title, x, y, cwd, prompt, sessionId: null, transcriptPath: null, after: [], ...extra })
  const term = (id, title, x, y, extra = {}) => ({ ...box, id, kind: 'terminal', title, x, y, cwd, ...extra })
  doc.nodes = [
    agent('lead', 'Team lead', 1500, 700, 'idle context=40'),
    agent('w1', 'Parser', 0, 0, 'working context=20', { openedBy: 'lead' }),
    agent('w2', 'Docs', 60, 60, 'idle context=15', { openedBy: 'lead' }),
    agent('w3', 'Login fix', 2300, 40, 'needs context=60', { openedBy: 'lead' }),
    agent('solo', 'Old review', 700, 380, 'idle context=10'),
    term('shell', 'Dev shell', 760, 420),
    { id: 'g', kind: 'group', title: 'Backend', x: 2300, y: 600, width: 568, height: 688, parentId: null, worktree: null, projectId: 'p1' },
    agent('g1', 'API tests', 24, 64, 'working context=33', { parentId: 'g' }),
    term('g2', 'API server', 24, 364 + 0, { parentId: 'g' }),
    { id: 'note', kind: 'sticky', title: 'Plan', text: '## Plan\n- Parser\n- Login', x: 120, y: 900, width: 240, height: 150, parentId: null, projectId: 'p1' },
    {
      id: 'trig', kind: 'trigger', title: 'Nightly check', x: 1000, y: 1150, width: 300, height: 220, parentId: null, projectId: 'p1',
      schedule: { type: 'interval', everyMs: 600000 }, prompt: 'check the build', targetId: 'shell', armedSpec: null, armedAt: null, nextAt: null, runs: []
    }
  ]
  doc.edges = [
    { id: 'e1', from: 'lead', to: 'w1', kind: 'opened' },
    { id: 'e2', from: 'lead', to: 'w2', kind: 'opened' },
    { id: 'e3', from: 'lead', to: 'w3', kind: 'opened' },
    { id: 'e4', from: 'solo', to: 'note', kind: 'link' }
  ]
  doc.viewport = { x: 80, y: 40, zoom: 0.4 }
  doc.projects[0].viewport = doc.viewport
}

const seeds = { 'tidy-messy': messy, 'tidy-old': messy, 'tidy-preview': messy, 'tidy-after': messy }

const waitForStatuses = async (page) => {
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('.react-flow__node'))) break
    await sleep(250)
  }
  await sleep(2500)
}

const openTidy = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="tidy"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(400)
}

const scenes = {
  'tidy-messy': async (page) => {
    await waitForStatuses(page)
    await fitAll(page)
  },
  // What Tidy canvas did before: one grid of every top-level node, in the order they were made.
  'tidy-old': async (page) => {
    await waitForStatuses(page)
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      const ids = doc.nodes.filter((n) => !n.parentId && n.projectId === doc.activeProjectId).map((n) => n.id)
      await window.patchbay.dispatch({ op: 'arrange', ids, layout: 'grid' })
    })
    await sleep(300)
    await fitAll(page)
  },
  'tidy-preview': async (page) => {
    await waitForStatuses(page)
    await fitAll(page)
    await openTidy(page)
    // Needs you first, so the picture shows the status order too.
    await page.evaluate(() => document.querySelector('.tidy-status input')?.click())
    await sleep(400)
  },
  'tidy-after': async (page) => {
    await waitForStatuses(page)
    await openTidy(page)
    await page.evaluate(() => document.querySelector('.tidy-status input')?.click())
    await sleep(200)
    await page.evaluate(() => document.querySelector('[data-cmd="tidy-apply"]')?.click())
    await sleep(500)
    await fitAll(page)
  }
}

module.exports = { scenes, seeds }
