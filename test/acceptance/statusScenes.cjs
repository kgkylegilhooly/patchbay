'use strict'
// One status system, every tone at once: `node screenshot.js <out.png> --scene status-tones`. Agents needing you,
// working, idle, stopped at a usage limit (amber ring), on a failed login and an error (red rings), a terminal (grey
// square), a run command that failed (red ring) and one still running (amber). Nothing real starts.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function seed(doc) {
  require('./stopScenes.cjs').seeds.stopped(doc)
  const at = (id) => doc.nodes.find((n) => n.id === id)
  at('run').title = 'npm test'
  at('run').command = 'node -e "process.exit(3)"'
  const note = at('note')
  note.x = 1240
  note.y = 660
  doc.nodes.push({ id: 'serve', kind: 'run', title: 'Dev server', x: 660, y: 660, width: 560, height: 300, parentId: null, cwd: at('run').cwd, command: 'node -e "setInterval(() => {}, 1000)"', projectId: 'p1' })
}

const scenes = {
  'status-tones': async (page) => {
    // The stop hooks run through Git Bash, which takes a moment.
    await sleep(1500)
    for (const id of ['run', 'serve']) await page.evaluate((i) => document.querySelector(`.react-flow__node[data-id="${i}"] [data-run="run"]`)?.click(), id)
    await sleep(2500)
  },
  'status-tones-sidebar': async (page) => {
    await scenes['status-tones'](page)
    await page.click('[data-sidebar-tab="status"]')
    await sleep(300)
  }
}

module.exports = { scenes, seeds: { 'status-tones': seed, 'status-tones-sidebar': seed } }
