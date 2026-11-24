'use strict'
// Screenshot scenes for Settings > About's diagnostics: `node screenshot.js <out.png> --scene diagnostics-about`.
// Copy diagnostics runs too. In test mode it writes the block to diagnostics-copied.txt in the profile rather than to the
// clipboard, and the scene prints it, so the real block can be read.
const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const scenes = {
  'diagnostics-about': async (page, { profile } = {}) => {
    await page.keyboard.down('Control')
    await page.keyboard.press(',')
    await page.keyboard.up('Control')
    await page.waitForSelector('[data-section="about"]')
    await page.click('[data-section="about"]')
    // The agents are asked for their versions when About opens.
    await page.waitForSelector('[data-diag="agents"][aria-busy="false"]', { timeout: 20000 })
    await page.click('[data-cmd="copy-diagnostics"]')
    await page.waitForSelector('[data-diag="copied"]', { timeout: 20000 })
    await sleep(300)
    const file = profile && path.join(profile, 'diagnostics-copied.txt')
    if (file && fs.existsSync(file)) process.stderr.write(`\n--- diagnostics-copied.txt ---\n${fs.readFileSync(file, 'utf8')}\n--- end ---\n`)
  }
}

module.exports = { scenes }
