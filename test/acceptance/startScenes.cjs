'use strict'
// Screenshot scenes for first run and starting agents (docs/plans/r3-start.md):
//   node screenshot.js <out.png> --scene start-many     16 projects: the tab bar, its overflow menu, the sidebar's empty projects
//   node screenshot.js <out.png> --scene start-first    a project with no folder, the New Claude Code form open
//   node screenshot.js <out.png> --scene start-failed   an agent whose folder is gone, beside the Status tab
//   node screenshot.js <out.png> --scene start-new      an agent just started from the form: selected, with the keyboard
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const view = { x: 0, y: 0, zoom: 0.8 }

const NAMES = ['Billing API', 'Docs site', 'Customer portal redesign', 'Mobile app', 'Data pipeline', 'Infra', 'Search service', 'Design system', 'Onboarding emails', 'Analytics', 'Release tooling', 'Support bot', 'Payments', 'Legacy admin']

const seeds = {
  'start-many': (doc) => {
    const cwd = doc.projects[0].folder
    NAMES.forEach((name, i) => doc.projects.push({ id: `m${i}`, name, folder: cwd, viewport: view }))
  },
  'start-first': (doc) => {
    doc.projects = [{ id: 'p1', name: 'My project', folder: '', viewport: view }]
    doc.nodes = []
    doc.closed = []
  },
  'start-failed': (doc) => {
    const gone = doc.nodes.find((n) => n.id === 'unk')
    Object.assign(gone, { title: 'Gone folder', prompt: 'idle', cwd: path.join(gone.cwd, 'deleted-folder') })
  },
  'start-new': (doc) => {
    doc.nodes = doc.nodes.filter((n) => n.projectId !== 'p1')
    doc.viewport = { x: 300, y: 60, zoom: 0.9 }
  }
}

const press = async (page, key, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
}

const scenes = {
  'start-many': async (page) => {
    await sleep(800)
  },
  'start-first': async (page) => {
    await page.evaluate(() => document.querySelector('[data-empty="new-claude"]')?.click())
    await sleep(300)
    // Typed straight away, it lands in the prompt. Never Ctrl+Enter or Space on a button here: with no folder that
    // opens the OS folder picker, which would come up in front of the person.
    await page.keyboard.type('Fix the flaky login test')
    await sleep(200)
  },
  'start-failed': async (page) => {
    await sleep(3000)
    await page.click('[data-sidebar-tab="status"]').catch(() => {})
    await sleep(300)
  },
  'start-new': async (page) => {
    await press(page, 'KeyC', ['Control', 'Shift'])
    await sleep(300)
    await page.keyboard.type('idle context=20')
    await press(page, 'Enter', ['Control'])
    await sleep(2500)
    // Typed straight after starting: it should reach the new agent.
    await page.keyboard.type('hello')
    await sleep(500)
  }
}

module.exports = { scenes, seeds }
