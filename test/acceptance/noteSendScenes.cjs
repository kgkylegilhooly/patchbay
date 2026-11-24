'use strict'
// Screenshot scene for sending a note to the agent it's linked to: `node screenshot.js <out.png> --scene note-send`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const seeds = {
  'note-send': (doc) => {
    Object.assign(doc.nodes.find((n) => n.id === 'note'), { title: 'Run the tests', text: 'Run the tests and fix what fails. Commit nothing.', x: 660, y: 340, width: 280, height: 170 })
    // The agent it's for, and the cable joining them.
    doc.nodes = doc.nodes.filter((n) => n.id !== 'unk')
    doc.edges.push({ id: 'note-link', from: 'note', to: 'idle', kind: 'link' })
    doc.viewport = { x: -260, y: 40, zoom: 1 }
    doc.projects[0].viewport = doc.viewport
  }
}

const scenes = {
  // The send button on the note's header; once pressed, what happened shows under the note.
  'note-send': async (page) => {
    await page.waitForSelector('.react-flow__node[data-id="note"]', { timeout: 15000 })
    await sleep(2500)
    const button = await page.$('.react-flow__node[data-id="note"] [data-note-send]')
    if (button) {
      await button.click()
      await page.waitForSelector('.react-flow__node[data-id="note"] .note-sent', { timeout: 15000 }).catch(() => {})
    }
    await sleep(600)
  }
}

module.exports = { scenes, seeds }
