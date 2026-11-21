'use strict'
// Screenshot scene for Codex's states as a live Codex 0.170 really reports them (docs/plans/codex-live.md). Register
// only for the screenshot process:
//   node -r ./test/acceptance/codexScenes.cjs screenshot.js out.png --scene codex-states
// The Codex windows run fake-codex.cjs, which replays recorded 0.170 rollouts and hooks: no quota.
const fs = require('node:fs')
const path = require('node:path')
const scenes = require('./scenes.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fake = path.join(__dirname, 'fake-codex.cjs').replace(/\\/g, '/')

scenes.scenes['codex-states'] = async (page) => {
  const want = async () => {
    const [stops, statuses, cards] = await Promise.all([
      page.evaluate(() => window.patchbayStops.all()),
      page.evaluate(() => window.patchbay.getStatuses()),
      page.evaluate(() => window.patchbaySubagents.get())
    ])
    return stops['cx-fail'] && stops['cx-usage'] && statuses['cx-ok'] === 'idle' && cards['cx-sub']?.cards?.length
  }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !(await want().catch(() => false))) await sleep(300)
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock'))?.click())
  await sleep(800)
}

const prepare = scenes.prepare
scenes.prepare = (name, cwdRoot) => {
  const scene = prepare(name, cwdRoot)
  if (name !== 'codex-states') return scene
  // The fake's rollouts go in the scene's own folder.
  process.env.PB_FAKE_CODEX_DIR = scene.cwd
  fs.writeFileSync(path.join(scene.cwd, 'README.md'), '# Scene\n')
  const box = { parentId: null, width: 520, height: 280, cwd: scene.cwd, sessionId: null, transcriptPath: null, after: [], projectId: 'p1', agent: 'codex', kind: 'claude' }
  scene.doc.nodes = [
    { ...box, id: 'cx-ok', title: 'Codex: answered', x: 0, y: 0, prompt: 'ok' },
    { ...box, id: 'cx-fail', title: 'Codex: unknown model', x: 560, y: 0, prompt: 'fail' },
    { ...box, id: 'cx-usage', title: 'Codex: usage limit', x: 0, y: 320, prompt: 'usage' },
    { ...box, id: 'cx-sub', title: 'Codex: one subagent', x: 560, y: 320, prompt: 'subagent' }
  ]
  scene.doc.closed = []
  scene.settings = { ...scene.settings, codexCommand: `node "${fake}"` }
  return scene
}
