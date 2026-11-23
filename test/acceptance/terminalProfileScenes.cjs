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
  // The submenu by keyboard, checked step by step: → or Enter opens it, ← or Esc goes back to the row that opened it,
  // Esc again closes the menu, Enter on a profile opens that terminal, and in the menu bar → opens the submenu rather
  // than moving to the next menu. Throws at the first step that's wrong; ends with the submenu open, for the picture.
  'terminal-menu-keys': async (page) => {
    await seedProfiles(page)
    const state = () => page.evaluate(() => {
      const panel = document.querySelector('.menu-panel')
      return panel ? { sub: panel.getAttribute('data-submenu'), label: panel.getAttribute('aria-label'), active: panel.querySelector('.menu-item-active')?.getAttribute('data-cmd') ?? null } : null
    })
    const key = async (k) => {
      await page.keyboard.press(k)
      await sleep(120)
    }
    const expect = async (what, ok) => {
      const s = await state()
      if (!ok(s)) throw new Error(`Menu keys: ${what}. Menu was ${JSON.stringify(s)}`)
    }
    const toRow = async (id) => {
      for (let i = 0; i < 40 && (await state())?.active !== id; i++) await key('ArrowDown')
      await expect(`↓ reaches ${id}`, (s) => s?.active === id)
    }
    const canvasMenu = async () => {
      await require('./scenes.cjs').rightClickCanvas(page)
      await sleep(300)
      await toRow('new-terminal-with')
    }

    await canvasMenu()
    await key('ArrowRight')
    await expect('→ opens the submenu on its first profile', (s) => s?.sub === 'new-terminal-with' && s.label === 'New terminal with' && s.active === 'new-terminal-with:custom:vs')
    await key('Escape')
    await expect('Esc goes back, with the opening row active', (s) => s && !s.sub && s.active === 'new-terminal-with')
    await key('Enter')
    await expect('Enter opens the submenu too', (s) => s?.sub === 'new-terminal-with')
    await key('ArrowLeft')
    await expect('← goes back', (s) => s && !s.sub && s.active === 'new-terminal-with')
    await key('Escape')
    await expect('Esc again closes the menu', (s) => s === null)

    const before = await page.evaluate(async () => (await window.patchbay.getDoc()).nodes.length)
    await canvasMenu()
    await key('ArrowRight')
    await key('Enter')
    await expect('Enter on a profile closes the menu', (s) => s === null)
    const deadline = Date.now() + 5000
    let made = null
    while (!made && Date.now() < deadline) {
      made = await page.evaluate(async (n) => {
        const nodes = (await window.patchbay.getDoc()).nodes
        return nodes.length > n ? nodes.find((x) => x.kind === 'terminal' && x.profile === 'custom:vs') ?? null : null
      }, before)
      if (!made) await sleep(200)
    }
    if (!made) throw new Error('Menu keys: Enter on "VS x64 prompt" opened no terminal of that profile')

    await page.evaluate(() => [...document.querySelectorAll('.menubar-item')].find((b) => b.textContent === 'File').click())
    await sleep(300)
    await toRow('new-terminal-with')
    await key('ArrowRight')
    await expect('in the menu bar, → opens the submenu, not the next menu', (s) => s?.sub === 'new-terminal-with')
    await key('ArrowLeft')
    await expect('← goes back to File, not the menu before it', (s) => s && !s.sub && s.label === 'File')
    await key('ArrowRight')
    console.log('terminal-menu-keys: all steps passed')
  },
  // A canvas menu opened at the right edge, then a submenu wider than it (a long profile name): it's placed again, on
  // screen. Throws if any of it is off screen.
  'terminal-menu-sub-edge': async (page) => {
    await page.evaluate(async (profiles) => {
      const b = window.patchbayTerminalProfiles
      const long = { id: 'custom:long', name: 'Developer PowerShell for VS 2022 (x64, preview tools)', program: 'cmd.exe', args: ['/k'] }
      const saved = await b.save([...profiles, long], 'custom:proj')
      if (!saved.ok) throw new Error(saved.reason)
    }, PROFILES)
    await page.reload()
    await page.waitForSelector('.react-flow__pane', { timeout: 15000 })
    await sleep(800)
    const spot = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect()
      for (let x = stage.right - 4; x > stage.left; x -= 8) {
        for (let y = stage.top + 60; y < stage.bottom - 60; y += 20) {
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
        }
      }
      return null
    })
    if (!spot) throw new Error('No bare canvas near the right edge')
    await page.mouse.click(spot.x, spot.y, { button: 'right' })
    await sleep(300)
    await page.click('.menu-panel [data-cmd="new-terminal-with"]')
    await sleep(400)
    const box = await page.evaluate(() => {
      const r = document.querySelector('.menu-panel').getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }
    })
    if (box.left < 0 || box.right > box.width || box.top < 0 || box.bottom > box.height) throw new Error(`The submenu runs off screen: ${JSON.stringify(box)}`)
    console.log(`terminal-menu-sub-edge: on screen ${JSON.stringify(box)}`)
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
