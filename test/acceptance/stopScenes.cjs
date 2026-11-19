'use strict'
// Screenshot scenes for agents stopped on an API error: `node screenshot.js <out.png> --scene stopped` (or
// `stopped-status`). fake-claude.cjs ends a turn with StopFailure through the real hook, as Claude does at a usage limit.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function seedStopped(doc) {
  const g1 = doc.nodes.find((n) => n.id === 'g1')
  g1.title = 'Feature team'
  doc.nodes.find((n) => n.id === 'needs').prompt = 'limit context=88'
  doc.nodes.find((n) => n.id === 'needs').title = 'Parser fix'
  doc.nodes.find((n) => n.id === 'work').prompt = 'loginfail'
  doc.nodes.find((n) => n.id === 'work').title = 'Docs update'
}

const scenes = {
  stopped: async () => {
    // The hooks run through Git Bash, which takes a moment.
    await sleep(2500)
  },
  'stopped-status': async (page) => {
    await sleep(2500)
    await page.click('[data-sidebar-tab="status"]')
    await sleep(300)
  }
}

module.exports = { scenes, seeds: { stopped: seedStopped, 'stopped-status': seedStopped } }
