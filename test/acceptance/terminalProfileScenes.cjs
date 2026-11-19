'use strict'
// Screenshot scenes for terminal profiles: `node screenshot.js <out.png> --scene settings-terminals` (or
// `terminal-form`, `terminal-menu`). Profiles are saved through the page's own channel when the build has one, so
// the same scene also shows the build before profiles.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROFILES = [
  { id: 'custom:vs', name: 'VS x64 prompt', program: 'cmd.exe', args: ['/k', 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat'] },
  { id: 'custom:proj', name: 'Project shell', program: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'], startupCommand: 'cd ~/proj && nvm use' }
]

async function seedProfiles(page) {
  await page.evaluate(async (profiles) => {
    const b = window.patchbayTerminalProfiles
    if (!b) return
    const saved = await b.save(profiles, 'custom:proj')
    if (!saved.ok) throw new Error(saved.reason)
  }, PROFILES)
  // The window read the list at load; it reads it again when settings or a menu opens.
  await page.reload()
  await page.waitForSelector('.react-flow__pane', { timeout: 15000 })
  await sleep(800)
}

async function openTerminals(page) {
  await page.keyboard.down('Control')
  await page.keyboard.press(',')
  await page.keyboard.up('Control')
  await page.waitForSelector('[data-section="terminals"]')
  await page.click('[data-section="terminals"]')
  await sleep(400)
}

const scenes = {
  'settings-terminals': async (page) => {
    await seedProfiles(page)
    await openTerminals(page)
  },
  'settings-terminals-edit': async (page) => {
    await seedProfiles(page)
    await openTerminals(page)
    await page.evaluate(() => document.querySelector('[data-profile="custom:proj"] [data-tp="edit"]')?.click())
    await sleep(300)
  },
  'terminal-form': async (page) => {
    await seedProfiles(page)
    await require('./scenes.cjs').rightClickCanvas(page)
    await sleep(200)
    await page.click('.menu-panel [data-cmd="new-terminal-form"]')
    await sleep(300)
    const select = await page.$('form [name="profile"]')
    if (select) await page.select('form [name="profile"]', 'custom:vs')
    await sleep(200)
  },
  'terminal-menu': async (page) => {
    await seedProfiles(page)
    await require('./scenes.cjs').rightClickCanvas(page)
    await sleep(300)
  }
}

module.exports = { scenes }
