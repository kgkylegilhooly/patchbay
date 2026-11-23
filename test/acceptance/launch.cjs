'use strict'
// The Settings panel and a custom way of starting Claude, with real Claude sessions. Saves apply without a restart.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'

const shoot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

async function clickText(page, selector, text) {
  const handle = await page.evaluateHandle(
    (s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t),
    selector,
    text
  )
  await handle.asElement().click()
  await lib.sleep(150)
}

async function fill(page, name, value) {
  await page.click(`.settings [name="${name}"]`, { count: 3 })
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Delete')
  if (value) await page.keyboard.type(value)
}

async function openPanel(page, section = 'claude') {
  await clickText(page, '.bar button', 'File')
  await page.click('[data-cmd="open-settings"]')
  await page.waitForSelector('.settings')
  await page.click(`[data-section="${section}"]`)
  await lib.sleep(150)
}

const closePanel = async (page) => {
  await page.keyboard.press('Escape')
  await lib.waitFor('the page to close', () => page.evaluate(() => !document.querySelector('.settings')), 5000)
}

async function save(page, values) {
  await openPanel(page)
  for (const [name, value] of Object.entries(values)) await fill(page, name, value)
  await lib.waitFor('the save', () => page.$eval('.set-saved', (s) => s.textContent === 'Saved'), 5000)
  await closePanel(page)
}

/** Processes on this PC whose command line names this session. */
function processesFor(sessionId) {
  const script = `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${sessionId}*' -and $_.Name -ne 'powershell.exe' }).Count`
  return Number(spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout.trim() || 0)
}

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const cwd = lib.workDir('launch')
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  const app = await lib.launch({ profile, realHome: true, exe })
  const { page } = app
  const file = path.join(profile, 'settings.json')

  try {
    // The page itself: no menu route leads to a text editor any more.
    await clickText(page, '.bar button', 'File')
    const menu = await page.$$eval('.menu-panel [data-cmd]', (items) => items.map((i) => i.dataset.cmd))
    check('No menu item opens the settings file', !menu.includes('edit-settings'), menu)
    await page.keyboard.press('Escape')
    await page.keyboard.down('Control')
    await page.keyboard.press('Comma')
    await page.keyboard.up('Control')
    await page.waitForSelector('.settings', { timeout: 3000 })
    check('Ctrl+, opens the page', true)
    await shoot(page, 'settings-canvas')
    const minimapOn = async () => (await page.$('.react-flow__minimap')) !== null
    // An empty canvas has no minimap, so give it a note first.
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      await window.patchbay.dispatch({ op: 'addNode', node: { id: 'map-note', kind: 'sticky', title: 'Note', text: '', x: 0, y: 0, width: 220, height: 140, parentId: null, projectId: doc.activeProjectId } })
    })
    await lib.sleep(150)
    const before = await minimapOn()
    await page.click('#set-minimap')
    await lib.sleep(150)
    check('A switch takes effect straight away', (await minimapOn()) !== before)
    await page.click('#set-minimap')
    await page.click('[data-section="about"]')
    await lib.sleep(150)
    const about = await page.$eval('.set-main', (m) => m.textContent)
    check('About shows the version and data folder', /Patchbay \d+\.\d+/.test(about) && about.includes(path.basename(profile)), about.slice(0, 120))
    await shoot(page, 'settings-about')
    await closePanel(page)

    const sized = await lib.openNode(page, lib.terminal('sized', cwd, 60, 60))
    await lib.sleep(1500)
    const rowsNow = async () => (await lib.screen(page, sized)).length
    const rowsBefore = await rowsNow()
    await openPanel(page, 'terminals')
    for (let i = 0; i < 4; i++) await page.click('[data-font="up"]')
    await shoot(page, 'settings-terminals')
    await closePanel(page)
    await lib.sleep(500)
    const rowsAfter = await rowsNow()
    check('A larger font size refits open terminals', rowsAfter < rowsBefore, { rowsBefore, rowsAfter })
    await lib.input(page, sized, 'clear; echo size=$(stty size)\r')
    const sizeLine = await lib.waitFor('the size', async () => (await lib.screen(page, sized)).find((r) => /^size=\d+ \d+$/.test(r)), 8000)
    check('The session is told its new size', Number(sizeLine.split(/[= ]/)[1]) === rowsAfter, sizeLine)
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'removeNodes', ids: [i] }), sized)

    await openPanel(page)
    await fill(page, 'claudeCommand', 'export PB_MARK=through-bash && claude')
    const problem = await lib.waitFor('the problem', () => page.$eval('.settings .field-problem', (p) => p.textContent), 3000)
    check('A shell command with no terminal says what to do', /needs a shell/.test(problem), problem)
    await lib.sleep(800)
    check('It is not saved while invalid', !fs.existsSync(file))
    await closePanel(page)
    check('Closing the page still saves nothing invalid', !fs.existsSync(file))

    await save(page, { claudeTerminal: gitBash, claudeCommand: 'export PB_MARK=through-bash && claude' })
    check('Changes save by themselves', JSON.parse(fs.readFileSync(file, 'utf8')).claudeTerminal === gitBash)
    await openPanel(page)
    const shown = await page.$eval('.settings [name="claudeCommand"]', (i) => i.value)
    const summary = await page.$eval('.set-summary', (s) => s.textContent)
    check('The page shows what was saved and what will run', shown.includes('through-bash') && summary.includes('bash.exe') && summary.includes('<Patchbay options>'), summary)
    await shoot(page, 'settings-claude')
    await closePanel(page)

    // Closing straight after typing must not lose the change.
    await openPanel(page, 'terminals')
    await fill(page, 'shell', 'powershell.exe')
    await closePanel(page)
    await lib.waitFor('the save on close', () => JSON.parse(fs.readFileSync(file, 'utf8')).shell === 'powershell.exe', 3000)
    check('Closing right after typing still saves', true)
    await openPanel(page, 'terminals')
    await fill(page, 'shell', '')
    await lib.waitFor('the save', () => page.$eval('.set-saved', (s) => s.textContent === 'Saved'), 5000)
    await closePanel(page)

    const bash = await lib.openNode(page, lib.claude('via-bash', cwd, 60, 60, { prompt: 'Run: echo "value=$PB_MARK" and report the output. Say it is "ok" if you can.' }))
    await lib.waitFor('the Git Bash Claude to finish', async () => {
      const seen = await lib.seenStatuses(page, bash)
      return seen.includes('working') && (await lib.statusOf(page, bash)) === 'idle'
    }, 150000)
    const seen = await lib.seenStatuses(page, bash)
    check('Status lights work through Git Bash without a restart', seen.includes('working'), seen)
    const node = await lib.nodeOf(page, bash)
    const text = lib.transcriptText(node.transcriptPath)
    check('The command ran first, and the prompt arrived intact', text.includes('value=through-bash'), text.slice(0, 200))
    check('Claude reported its session back', !!node.sessionId && !!node.transcriptPath)

    await page.evaluate(() => window.patchbay.restartNode('via-bash'))
    await lib.waitFor('the resumed session', async () => (await lib.statusOf(page, bash)) === 'idle' && (await lib.nodeOf(page, bash)).sessionId === node.sessionId, 60000)
    check('Restart resumes the same conversation through the terminal', true)

    await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock')).click())
    await lib.sleep(500)
    await shoot(page, 'claude-window')
    const at = await page.evaluate(() => ({ x: innerWidth - 120, y: 90 }))
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await lib.sleep(200)
    await shoot(page, 'claude-menu')
    await page.keyboard.press('Escape')

    check('The Claude session is running before closing', processesFor(node.sessionId) > 0)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['via-bash'] }))
    await lib.waitFor('the session processes to end', () => processesFor(node.sessionId) === 0, 15000, 1000).then(
      () => check('Closing the window ends Claude inside the terminal', true),
      (e) => check('Closing the window ends Claude inside the terminal', false, e.message)
    )

    await save(page, { claudeTerminal: 'powershell.exe', claudeCommand: '' })
    const ps = await lib.openNode(page, lib.claude('via-ps', cwd, 60, 60))
    await lib.waitFor('the PowerShell Claude to start', async () => (await lib.statusOf(page, ps)) === 'idle', 60000).then(
      () => check('Windows PowerShell starts Claude with status working', true),
      (e) => check('Windows PowerShell starts Claude with status working', false, e.message)
    )
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['via-ps'] }))

    await save(page, { claudeTerminal: 'no-such-terminal.exe', claudeCommand: '' })
    const bad = await lib.openNode(page, lib.claude('bad', cwd, 60, 60))
    const error = await lib.waitFor('the error', () => page.evaluate((i) => window.patchbay.getErrors().then((e) => e[i]), bad), 10000)
    check('A wrong terminal shows on the window and names the setting', /no-such-terminal.*Settings/.test(error.message), error.message)
    await lib.sleep(300)
    await shoot(page, 'claude-error')
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['bad'] }))

    fs.writeFileSync(file, '{ "shell": oops')
    await openPanel(page, 'terminals')
    await fill(page, 'shell', 'pwsh.exe')
    const alert = await lib.waitFor('the refusal', () => page.$eval('.set-saved-bad', (e) => e.textContent), 5000)
    check('Saving over a broken file is refused', /mistake/.test(alert) && fs.readFileSync(file, 'utf8') === '{ "shell": oops', alert)
    await closePanel(page)

    check('No errors in the page', app.problems.length === 0, app.problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
  } finally {
    await app.forceKill()
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
