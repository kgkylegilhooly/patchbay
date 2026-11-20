'use strict'
// Screenshot scenes for the canvas quick wins: `node screenshot.js <out.png> --scene firstrun`.
// firstrun is a project with nothing on it, as a new person sees it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const seeds = {
  firstrun: (doc) => {
    doc.projects = doc.projects.filter((p) => p.id === 'p1')
    doc.nodes = []
    doc.edges = []
    doc.closed = []
  }
}

const scenes = {
  firstrun: async () => {
    await sleep(300)
  }
}

module.exports = { scenes, seeds }
