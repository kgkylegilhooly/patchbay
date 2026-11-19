'use strict'
// Screenshot scenes for subagent cards: `node screenshot.js <out.png> --scene subagents` (or `subagents-transcript`,
// `subagents-hidden`). The windows run fake-claude.cjs with "fanout=N", which writes pretend subagents where Claude
// Code writes real ones, so the real watcher draws them and no quota is spent.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function seedFanOut(doc) {
  const cwd = doc.projects[0].folder
  const box = { parentId: null, width: 620, height: 380, cwd, sessionId: null, transcriptPath: null, after: [], projectId: 'p1' }
  doc.nodes = [
    // Ten at once: eight slots, so seven cards and "+3 more".
    { ...box, id: 'lead', kind: 'claude', title: 'Refactor placement', x: 0, y: 0, prompt: 'working fanout=10' },
    { ...box, id: 'small', kind: 'claude', title: 'Review the docs', x: 0, y: 860, prompt: 'working fanout=3' },
    { id: 'term', kind: 'terminal', title: 'Dev shell', x: 1040, y: 860, width: 560, height: 340, parentId: null, cwd, projectId: 'p1' }
  ]
  doc.viewport = { x: 360, y: 40, zoom: 0.6 }
  doc.projects[0].viewport = doc.viewport
}

const waitForCards = (page, count) => page.waitForFunction((n) => document.querySelectorAll('.sa-card').length >= n, { timeout: 20000 }, count)

const scenes = {
  // The same canvas without waiting for cards, for a picture from before they existed.
  'subagents-before': async () => {
    await sleep(4000)
  },
  subagents: async (page) => {
    await waitForCards(page, 9)
    await sleep(1500)
  },
  'subagents-transcript': async (page) => {
    await waitForCards(page, 9)
    await page.click('.sa-card[data-subagent="a0000fake"]')
    await page.waitForFunction(() => /framed JSON/.test(document.querySelector('.sa-viewer .viewer-text')?.textContent ?? ''), { timeout: 10000 })
  },
  'subagents-hidden': async (page) => {
    await waitForCards(page, 9)
    await page.click('[data-subagent-eye="lead"]')
    await sleep(500)
  }
}

const seeds = { subagents: seedFanOut, 'subagents-before': seedFanOut, 'subagents-transcript': seedFanOut, 'subagents-hidden': seedFanOut }

module.exports = { scenes, seeds }
