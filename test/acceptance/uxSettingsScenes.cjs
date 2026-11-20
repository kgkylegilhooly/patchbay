'use strict'
// Screenshot scenes for the settings, forms and menus quick wins: `node screenshot.js <out.png> --scene ux-new-claude`
// (and ux-ssh, ux-trigger-agent, ux-file-menubar, ux-edit-menu, ux-settings-agents-top, ux-settings-canvas, ux-settings-about).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fromCanvasMenu(page, cmd) {
  await require('./scenes.cjs').rightClickCanvas(page)
  await sleep(200)
  await page.click(`.menu-panel [data-cmd="${cmd}"]`)
  await sleep(300)
}

async function openSettings(page, section) {
  await page.keyboard.down('Control')
  await page.keyboard.press(',')
  await page.keyboard.up('Control')
  await page.waitForSelector(`[data-section="${section}"]`)
  await page.click(`[data-section="${section}"]`)
  await sleep(400)
}

/** Marks whatever has focus, so the picture shows where typing goes. */
async function markFocus(page) {
  await page.evaluate(() => {
    const el = document.activeElement
    if (el && el !== document.body) el.style.outline = '2px solid #3d8bfd'
  })
}

const scenes = {
  'ux-new-claude': async (page) => {
    await fromCanvasMenu(page, 'new-claude')
    await markFocus(page)
  },
  'ux-ssh': async (page) => {
    await fromCanvasMenu(page, 'new-ssh')
    await sleep(300)
  },
  // An agent trigger before anything is chosen: no error yet, and the buttons stay in view.
  'ux-trigger-agent': async (page) => {
    await fromCanvasMenu(page, 'new-trigger')
    await page.select('form[aria-label="New trigger"] [name="scheduleType"]', 'agent')
    await sleep(200)
  },
  // The menu bar's File menu. (The scene called file-menu is a file icon's menu, from the file shelf.)
  'ux-file-menubar': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(200)
  },
  'ux-edit-menu': async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'Edit').click())
    await sleep(200)
  },
  'ux-settings-agents-top': async (page) => {
    await openSettings(page, 'claude')
  },
  'ux-settings-canvas': async (page) => {
    await openSettings(page, 'canvas')
  },
  'ux-settings-about': async (page) => {
    await openSettings(page, 'about')
    await page.evaluate(() => document.querySelector('[data-settings-updates]')?.scrollIntoView({ block: 'end' }))
    await sleep(300)
  },
  'ux-settings-terminals-bottom': async (page) => {
    await openSettings(page, 'terminals')
    await page.evaluate(() => document.getElementById('set-scrollback')?.scrollIntoView({ block: 'end' }))
    await sleep(300)
  }
}

module.exports = { scenes, seeds: {} }
