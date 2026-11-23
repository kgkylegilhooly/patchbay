'use strict'
// Screenshot scenes for first run and starting agents (docs/plans/r3-start.md):
//   node screenshot.js <out.png> --scene start-many     16 projects: the tab bar, its overflow menu, the sidebar's empty projects
//   node screenshot.js <out.png> --scene start-first    a project with no folder, the New Claude Code form open
//   node screenshot.js <out.png> --scene start-failed   an agent whose folder is gone, beside the Status tab
//   node screenshot.js <out.png> --scene start-new      an agent just started from the form: selected, with the keyboard
const path = require('node:path')

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

// Each step waits for what it needs on screen, never a fixed time, so a slow machine takes the same picture.
const scenes = {
  'start-many': async (page) => {
    await page.waitForSelector('[data-project-more]')
  },
  'start-first': async (page) => {
    await page.waitForSelector('[data-empty="new-claude"]')
    await page.evaluate(() => document.querySelector('[data-empty="new-claude"]').click())
    await page.waitForFunction(() => document.activeElement?.matches('.pop-claude textarea'))
    // Typed straight away, it lands in the prompt. Test runs never open the OS folder picker (src/main/testPickers.ts),
    // but this scene doesn't reach it anyway: no Ctrl+Enter, no Choose folder.
    await page.keyboard.type('Fix the flaky login test')
    await page.waitForFunction(() => document.querySelector('.pop-claude textarea')?.value === 'Fix the flaky login test')
  },
  'start-failed': async (page) => {
    await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="unk"] [data-start-fix="folder"]'), { timeout: 20000 })
    await page.click('[data-sidebar-tab="status"]')
    await page.waitForSelector('.sidebar [data-status-section="needs-you"] [data-session="unk"]')
  },
  'start-new': async (page) => {
    await page.waitForSelector('.react-flow')
    await press(page, 'KeyC', ['Control', 'Shift'])
    await page.waitForFunction(() => document.activeElement?.matches('.pop-claude textarea'))
    await page.keyboard.type('idle context=20')
    await press(page, 'Enter', ['Control'])
    // The new agent has the keyboard and has finished its first turn.
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea') && /Idle/.test(document.activeElement.closest('.react-flow__node')?.querySelector('.unit-head .st-label')?.textContent ?? ''), { timeout: 20000 })
    // Typed straight after starting: it reaches the new agent, and the picture shows it.
    await page.keyboard.type('hello')
    await page.waitForFunction(async () => {
      const id = document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id')
      return !!id && (await window.patchbay.attach(id)).data.includes('hello')
    }, { timeout: 10000, polling: 100 })
    // Drawn in the frame after it arrives.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  }
}

module.exports = { scenes, seeds }
