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
    // By keyboard, so the picture run also checks the button keeps focus while it works and after.
    await page.focus('[data-cmd="copy-diagnostics"]')
    await page.keyboard.press('Enter')
    const during = await page.evaluate(() => document.activeElement?.getAttribute('data-cmd') ?? document.activeElement?.tagName)
    await page.waitForSelector('[data-diag="copied"]', { timeout: 20000 })
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-cmd') ?? document.activeElement?.tagName)
    process.stderr.write(`focus while copying: ${during}, after: ${after}\n`)
    // Off the button for the picture, so it shows as it usually looks.
    await page.evaluate(() => document.activeElement?.blur())
    await sleep(300)
    const file = profile && path.join(profile, 'diagnostics-copied.txt')
    if (file && fs.existsSync(file)) process.stderr.write(`\n--- diagnostics-copied.txt ---\n${fs.readFileSync(file, 'utf8')}\n--- end ---\n`)
  }
}

module.exports = { scenes }
