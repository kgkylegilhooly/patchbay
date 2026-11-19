'use strict'
// Screenshot scene for where new nodes land: `node screenshot.js <out.png> --scene placement`.
// The layout from the report: the lead at the top left, a tall group of four agents in a 2x2 grid right beside it.
// The lead runs `patchbay sticky` itself once it starts (fake-claude's "pb-sticky"), so the picture shows where its
// note really lands. The same scene makes the before and after pictures.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fitAll = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(500)
}

const seeds = {
  placement: (doc) => {
    const cwd = doc.projects[0].folder
    const agent = (id, title, x, y, prompt, extra = {}) => ({
      id, kind: 'claude', title, x, y, width: 620, height: 420, parentId: null, cwd, prompt, sessionId: null, transcriptPath: null, after: [], projectId: 'p1', ...extra
    })
    const member = (id, title, x, y) => agent(id, title, x, y, 'working context=20', { parentId: 'team', openedBy: 'lead' })
    doc.nodes = [
      agent('lead', 'Team lead', 0, 0, 'idle pb-sticky context=30'),
      { id: 'team', kind: 'group', title: 'Feature research build', x: 660, y: 0, width: 1328, height: 968, parentId: null, worktree: null, projectId: 'p1' },
      member('m1', 'P2 Recipes', 24, 64),
      member('m2', 'P3 Review inbox', 684, 64),
      member('m3', 'P4 Compare', 24, 524),
      member('m4', 'Fix: placement', 684, 524)
    ]
    doc.viewport = { x: 60, y: 70, zoom: 0.55 }
    doc.projects[0].viewport = doc.viewport
  }
}

const scenes = {
  // Waits for the lead's own `patchbay sticky` to add its note, then fits everything so the note shows wherever it went.
  placement: async (page) => {
    for (let i = 0; i < 100; i++) {
      const done = await page.evaluate(async () => (await window.patchbay.getDoc()).nodes.some((n) => n.kind === 'sticky' && n.openedBy === 'lead'))
      if (done) break
      await sleep(250)
    }
    await sleep(600)
    await fitAll(page)
  }
}

module.exports = { scenes, seeds }
