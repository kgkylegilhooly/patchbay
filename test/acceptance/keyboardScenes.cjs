'use strict'
// Screenshot scenes for keyboard and accessibility (docs/plans/r3-keyboard.md): `node screenshot.js <out.png> --scene
// kb-node-focus` (and kb-empty, kb-form-trap, kb-palette-window). Take each at the default size and at --size 1024x700.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const settle = async (page) => {
  await page.waitForSelector('.react-flow__node[data-id="idle"]', { timeout: 10000 })
  await sleep(600)
}

const key = async (page, combo) => {
  const parts = combo.split('+')
  const last = parts.pop()
  for (const m of parts) await page.keyboard.down(m)
  await page.keyboard.press(last)
  for (const m of parts.reverse()) await page.keyboard.up(m)
}

const scenes = {
  // A window reached from the keyboard: it shows a ring. F6 from the menu bar lands on the canvas.
  'kb-node-focus': async (page) => {
    await settle(page)
    // A key press first, so the focus that follows counts as keyboard focus (:focus-visible), as Tab or F6 gives.
    await page.keyboard.press('Shift')
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="idle"]').focus())
    await sleep(300)
  },
  // The empty canvas, with its key hint and no React Flow label in the corner.
  'kb-empty': async (page) => {
    await page.waitForSelector('.stage-empty', { timeout: 10000 })
    await sleep(300)
  },
  // New Claude Code, then Tab past its last button: focus stays in the form.
  'kb-form-trap': async (page) => {
    await settle(page)
    await page.evaluate(() => document.activeElement?.blur())
    await key(page, 'Control+Shift+KeyC')
    await sleep(300)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    await sleep(200)
  },
  // The palette on a selected window: rename, restart and close are there.
  'kb-palette-window': async (page) => {
    await settle(page)
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="idle"] .pb-drag')?.click())
    await sleep(200)
    await key(page, 'Control+KeyK')
    await sleep(200)
    await page.keyboard.type('this window')
    await sleep(300)
  }
}

const seeds = {
  'kb-empty': (doc) => {
    doc.nodes = []
    doc.edges = []
  }
}

module.exports = { scenes, seeds }
