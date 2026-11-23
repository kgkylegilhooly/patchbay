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
  // A live terminal whose profile is deleted in Settings, then restarted: it starts the default and says so.
  // Records what happened in window.__profileScene for the caller to read.
  'terminal-profile-gone-restart': async (page) => {
    const result = await page.evaluate(async () => {
      const tp = window.patchbayTerminalProfiles
      const pb = window.patchbay
      const wait = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)) } return true }
      const A = { id: 'custom:a', name: 'Prompt A', program: 'cmd.exe', args: ['/k', 'echo started-with-A'] }
      const B = { id: 'custom:b', name: 'Prompt B', program: 'cmd.exe', args: ['/k', 'echo started-with-B'] }
      await tp.save([A, B], 'custom:a')
      await pb.dispatch({ op: 'patchNode', id: 'term', patch: { profile: 'custom:b' } })
      await pb.restartNode('term')
      const startedB = await wait(async () => (await pb.attach('term')).data.includes('started-with-B'))
      const before = (await pb.getErrors()).term?.message ?? null
      // Deleted while it runs, then Restart.
      await tp.save([A], 'custom:a')
      await pb.restartNode('term')
      const startedA = await wait(async () => (await pb.attach('term')).data.includes('started-with-A'))
      await new Promise((r) => setTimeout(r, 1500))
      const after = (await pb.getErrors()).term?.message ?? null
      return { startedB, before, startedA, after }
    })
    console.log(`terminal-profile-gone-restart: ${JSON.stringify(result)}`)
    await sleep(500)
  },
  // A path printed in a terminal, clicked: New terminal here, and one per other profile.
  'path-menu-profiles': async (page) => {
    await seedProfiles(page)
    const fs = require('node:fs')
    const path = require('node:path')
    const folder = await page.evaluate(async () => (await window.patchbay.getDoc()).projects[0].folder)
    fs.mkdirSync(path.join(folder, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'notes', 'a.txt'), 'hello\n')
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="term"] [data-tool="maximize"]').click())
    await sleep(800)
    await page.evaluate(() => window.patchbay.input('term', 'echo notes/a.txt'))
    await sleep(300)
    await page.evaluate(() => window.patchbay.input('term', '\r'))
    const deadline = Date.now() + 30000
    let at = null
    while (!at && Date.now() < deadline) {
      at = await page.evaluate(() => {
        // Maximized, the terminal is drawn over the canvas rather than in its node.
        const rows = [...document.querySelectorAll('.xterm-rows > div')]
        const row = rows.find((r) => r.textContent.replace(/ /g, ' ').trimEnd() === 'notes/a.txt')
        if (!row) return null
        const box = row.getBoundingClientRect()
        return { x: box.left + 24, y: box.top + box.height / 2 }
      })
      if (!at) await sleep(200)
    }
    if (!at) throw new Error('The path never showed in the terminal.')
    await page.mouse.move(at.x - 40, at.y)
    await page.mouse.move(at.x, at.y, { steps: 4 })
    await sleep(300)
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('.menu-panel[aria-label="notes/a.txt"]', { timeout: 5000 })
    await sleep(300)
  },
  'terminal-menu': async (page) => {
    await seedProfiles(page)
    await require('./scenes.cjs').rightClickCanvas(page)
    await sleep(300)
  },
  // The other profiles, opened from the canvas menu's one "New terminal with" row.
  'terminal-menu-sub': async (page) => {
    await seedProfiles(page)
    await require('./scenes.cjs').rightClickCanvas(page)
    await sleep(300)
    await page.click('.menu-panel [data-cmd="new-terminal-with"]')
    await sleep(300)
  }
}

module.exports = { scenes }
