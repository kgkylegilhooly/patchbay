'use strict'
// Keyboard and screen reader flows from the round 2 flows audit (findings 6, 7, 8, 9, 10, 14, 15), on the built app,
// off-screen, with fake agents (no real quota). See docs/plans/r3-keyboard.md.
//   node test/acceptance/keyboard.cjs      (build first: electron-vite build)
const L = require('./lib.cjs')

const fake = require('node:path').join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

const key = async (page, combo) => {
  const parts = combo.split('+')
  const last = parts.pop()
  for (const m of parts) await page.keyboard.down(m)
  await page.keyboard.press(last)
  for (const m of parts.reverse()) await page.keyboard.up(m)
}

/** Where the keyboard is: a node frame, a terminal (in which node), the menu bar, the dock, a form, the page. */
const where = (page) =>
  page.evaluate(() => {
    const e = document.activeElement
    if (!e || e === document.body) return 'body'
    const node = e.closest('.react-flow__node')
    if (node) return e === node ? `frame:${node.dataset.id}` : e.classList.contains('xterm-helper-textarea') ? `terminal:${node.dataset.id}` : `in:${node.dataset.id}`
    if (e.closest('.app > .bar')) return 'menubar'
    if (e.closest('.stage > .sidebar')) return 'sidebar'
    if (e.closest('.stage > .dock')) return 'dock'
    if (e.closest('.pop')) return 'form'
    if (e.closest('.settings')) return 'settings'
    return `other:${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`
  })

const focusTerminal = (page, id) => page.evaluate((i) => document.querySelector(`.react-flow__node[data-id="${i}"] .xterm-helper-textarea`).focus(), id)

async function main() {
  const c = L.checker()
  const work = L.workDir('keyboard')
  const profile = L.newProfile({ claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off' })
  const project = { id: 'p1', name: 'Demo', folder: work, viewport: { x: 40, y: 60, zoom: 0.8 } }
  const agent = (id, title, x, prompt) => ({ ...L.claude(id, work, x, 0, { prompt }), title, width: 520, height: 300, projectId: 'p1' })
  require('node:fs').writeFileSync(
    require('node:path').join(profile, 'canvas.json'),
    JSON.stringify({ version: 2, projects: [project, { ...project, id: 'p2', name: 'Empty' }], activeProjectId: 'p1', viewport: project.viewport, edges: [], closed: [], nodes: [agent('a', 'Fix the login', 0, 'idle'), agent('b', 'Write tests', 580, 'idle')] })
  )
  const app = await L.launch({ profile })
  const { page } = app
  try {
    await page.setViewport({ width: 1280, height: 800 })
    await L.waitFor('both agents idle', async () => (await L.statusOf(page, 'a')) === 'idle' && (await L.statusOf(page, 'b')) === 'idle', 30000)
    await L.waitFor('terminals', () => page.evaluate(() => document.querySelectorAll('.xterm-helper-textarea').length >= 2), 15000)

    // #15: no React Flow label on the canvas, and it's credited in About instead.
    c.check('#15 no attribution on the canvas (no extra Tab stop)', !(await page.$('.react-flow__attribution')))

    // #6: a name per window, a ring when reached by keyboard, F6 out of a terminal and round the app.
    const label = await page.evaluate(() => document.querySelector('.react-flow__node[data-id="a"]').getAttribute('aria-label'))
    c.check('#6 a window has one name: title, kind, status', label === 'Fix the login, Claude Code, Idle', label)
    const desc = await page.evaluate(() => {
      const id = document.querySelector('.react-flow__node[data-id="a"]').getAttribute('aria-describedby')
      return document.getElementById(id)?.textContent ?? ''
    })
    c.check('#6 its description says how to get in and out', /Enter types in this window\. F6 moves to the next part of the app\. Ctrl\+K finds any action\./.test(desc), desc)

    await focusTerminal(page, 'a')
    c.check('#6 a terminal says how to leave it', (await page.evaluate(() => document.getElementById(document.activeElement.getAttribute('aria-describedby'))?.textContent)) === 'F6 leaves this window. Ctrl+K finds any action.')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    c.check('#6 Esc and Tab stay in the terminal (the shell keeps them)', (await where(page)) === 'terminal:a')
    await page.keyboard.press('F6')
    await L.sleep(150)
    c.check('#6 F6 in a terminal steps out to its window frame', (await where(page)) === 'frame:a', await where(page))
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement)
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), visible: document.activeElement.matches(':focus-visible') }
    })
    c.check('#6 the frame shows a focus ring', ring.visible && ring.style !== 'none' && ring.width >= 2, ring)
    await L.shot(page, 'keyboard-frame-ring')
    await page.keyboard.press('Enter')
    await L.sleep(150)
    c.check('#6 Enter on the frame goes back into its terminal', (await where(page)) === 'terminal:a', await where(page))
    await page.keyboard.press('F6')
    await page.keyboard.press('F6')
    await L.sleep(150)
    c.check('#6 F6 again moves on to the dock', (await where(page)) === 'dock', await where(page))
    await page.keyboard.press('F6')
    c.check('#6 then the menu bar', (await where(page)) === 'menubar', await where(page))
    await page.keyboard.press('F6')
    c.check('#6 then the sidebar', (await where(page)) === 'sidebar', await where(page))
    await page.keyboard.press('F6')
    c.check('#6 and back to the window it left', (await where(page)) === 'frame:a', await where(page))
    await key(page, 'Shift+F6')
    c.check('#6 Shift+F6 goes back', (await where(page)) === 'sidebar', await where(page))

    // #14: Settings gives the keyboard back to the terminal it was opened from.
    await focusTerminal(page, 'b')
    await key(page, 'Control+Comma')
    await page.waitForSelector('.settings', { timeout: 5000 })
    c.check('#15 About credits React Flow', await page.evaluate(() => {
      document.querySelector('[data-section="about"]').click()
      return new Promise((r) => setTimeout(() => r(document.querySelector('.settings').innerText.includes('React Flow')), 100))
    }))
    await page.keyboard.press('Escape')
    await L.sleep(200)
    c.check('#14 closing Settings returns to the terminal you were in', (await where(page)) === 'terminal:b', await where(page))

    // #9: tooltips teach the keys.
    const titles = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.dock [data-cmd]')].map((b) => [b.dataset.cmd, b.title])))
    c.check('#9 dock tooltips show their keys', titles['fit-view'] === 'Fit view (Ctrl+Shift+F)' && titles['new-claude'] === 'New Claude Code (Ctrl+Shift+C)' && titles['toggle-board'] === 'Board view (Ctrl+Shift+B)', titles)
    c.check('#9 and say them to screen readers', (await page.$eval('.dock [data-cmd="fit-view"]', (b) => b.getAttribute('aria-keyshortcuts'))) === 'Ctrl+Shift+F')

    // #7: the New Claude Code form keeps Tab, and Esc closes it even after focus left it.
    await page.evaluate(() => document.activeElement?.blur())
    await key(page, 'Control+Shift+KeyC')
    await page.waitForSelector('.pop', { timeout: 5000 })
    const stops = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      stops.push(await where(page))
    }
    c.check('#7 Tab x10 never leaves the form', stops.every((s) => s === 'form'), stops.join(' '))
    await key(page, 'Shift+Tab')
    c.check('#7 nor does Shift+Tab', (await where(page)) === 'form')
    await focusTerminal(page, 'a')
    await page.keyboard.press('Escape')
    await L.sleep(150)
    c.check('#7 Esc in a terminal is the terminal\'s, and leaves the form open', !!(await page.$('.pop')))
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Escape')
    await L.sleep(150)
    c.check('#7 Esc from the page closes the form left open', !(await page.$('.pop')))

    // #10: the palette renames, restarts and closes the window in use; F2 renames on the canvas only.
    await focusTerminal(page, 'a')
    await key(page, 'Control+KeyK')
    await page.waitForSelector('.palette input', { timeout: 5000 })
    await page.keyboard.type('this window')
    await L.sleep(200)
    const offered = await page.evaluate(() => [...document.querySelectorAll('.palette [role=option]')].map((o) => o.innerText.replace(/\s+/g, ' ').trim()))
    c.check('#10 the palette offers rename and close for the window in use', offered.some((o) => o.startsWith('Rename this window')) && offered.some((o) => o.startsWith('Close this window')), offered.slice(0, 8))
    c.check('#10 and not restart, for a window still running', !offered.some((o) => o.startsWith('Restart this window')))
    await page.keyboard.press('Escape')
    await focusTerminal(page, 'a')
    await page.keyboard.press('F2')
    await L.sleep(150)
    c.check('#10 F2 in a terminal is left to the terminal', !(await page.$('.title-input')))
    await page.keyboard.press('F6')
    await page.keyboard.press('F2')
    await page.waitForSelector('.react-flow__node[data-id="a"] .title-input', { timeout: 3000 }).catch(() => null)
    c.check('#10 F2 on the window frame renames it', !!(await page.$('.react-flow__node[data-id="a"] .title-input')))
    await page.keyboard.type('Login fix')
    await page.keyboard.press('Enter')
    await L.sleep(300)
    c.check('#10 the new name is saved', (await L.nodeOf(page, 'a')).title === 'Login fix')
    c.check('#10 and the keyboard stays on that window', (await where(page)) === 'frame:a', await where(page))

    // #8: a window moving to needs you is said in the polite live region.
    c.check('#8 one polite live region', (await page.$$eval('[data-announcer]', (r) => r.map((e) => e.getAttribute('aria-live')))).join() === 'polite')
    await L.sleep(3000) // past the first seconds after launch, which are taken as how things already were
    await L.openNode(page, { ...agent('n', 'Ship the fix', 0, 'needs'), y: 380 })
    const said = await L.waitFor('announcement', () => page.$eval('[data-announcer]', (r) => r.textContent).then((t) => (t.includes('Ship the fix needs you') ? t : null)), 20000, 100).catch(() => '')
    c.check('#8 "Ship the fix needs you" is announced', !!said, said)

    // #10: close from the palette asks first when the agent needs you.
    await focusTerminal(page, 'n')
    await key(page, 'Control+KeyK')
    await page.waitForSelector('.palette input', { timeout: 5000 })
    await page.keyboard.type('close this window')
    await L.sleep(200)
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-confirm="close"]', { timeout: 3000 }).catch(() => null)
    c.check('#10 closing a window that needs you asks first', !!(await page.$('[data-confirm="close"]')))
    await page.keyboard.press('Escape')
    await L.sleep(200)
    c.check('#10 and Keep leaves it open', !!(await L.nodeOf(page, 'n')))

    // #9: the empty canvas names the two keys that start everything.
    await page.evaluate(() => window.patchbay.dispatch({ op: 'switchProject', id: 'p2' }))
    await page.waitForSelector('[data-empty="keys"]', { timeout: 5000 }).catch(() => null)
    const hint = await page.$eval('[data-empty="keys"]', (p) => p.textContent).catch(() => '')
    c.check('#9 the empty canvas says Ctrl+K and Ctrl+Shift+C', hint === 'Ctrl+K finds any action. Ctrl+Shift+C starts Claude Code.', hint)
    // From the page: menu bar, sidebar, then the canvas, here its empty card.
    await page.evaluate(() => document.activeElement?.blur())
    for (let i = 0; i < 3; i++) await page.keyboard.press('F6')
    c.check('#6 F6 reaches the empty canvas card too', await page.evaluate(() => !!document.activeElement.closest('.stage-empty')), await where(page))

    c.check('no renderer errors', app.problems.length === 0, app.problems.slice(0, 3))
  } catch (e) {
    c.check('run finished', false, e.stack)
    await L.shot(page, 'keyboard-failure').catch(() => {})
  }
  // Force-killed: Stop all and quit would ask about the agent that needs you, in a native box.
  await app.forceKill().catch(() => {})
  L.cleanup(profile)
  c.finish()
}
main()
