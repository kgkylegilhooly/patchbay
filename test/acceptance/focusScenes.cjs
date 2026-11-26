'use strict'
// Screenshot scenes for the focus view: `node screenshot.js <out.png> --scene focus-view`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openFocus(page) {
  await page.waitForSelector('.dock [data-cmd="toggle-focus"]', { timeout: 15000 })
  await sleep(1500)
  await page.click('.dock [data-cmd="toggle-focus"]')
  await page.waitForSelector('.focus-view [data-focus-pane]', { timeout: 15000 })
  await sleep(1500)
}

const scenes = {
  // The dock's Focus button, with the scene canvas's windows in panes.
  'focus-view': openFocus,
  // A pane's controls, in the pane menu in its window's header.
  'focus-pane-menu': async (page) => {
    await openFocus(page)
    await page.click('[data-focus-pane="ab"] [data-focus="pane-menu"]')
    await page.waitForSelector('.menu-panel [data-tool="split-right"]', { timeout: 5000 })
    await sleep(300)
  }
}

module.exports = { scenes }
