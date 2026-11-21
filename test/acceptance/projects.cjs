'use strict'
// Projects, end to end: an old save migrating, hidden sessions continuing, Claude redrawing, agents staying in
// their project, closing a project, and everything surviving a restart.
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS
const shoot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

const tab = (page, name) =>
  page.evaluateHandle((n) => [...document.querySelectorAll('.project-tab')].find((t) => t.textContent.trim() === n), name).then((h) => h.asElement())
const tabNames = (page) => page.$$eval('.project-tab', (ts) => ts.map((t) => t.textContent.trim()))
const activeTab = (page) => page.$eval('.project-tab-active', (t) => t.textContent.trim())
const shownNodes = (page) => page.$$eval('.react-flow__node', (ns) => ns.map((n) => n.dataset.id).sort())
const viewOf = (page) => page.$eval('.react-flow__viewport', (v) => v.style.transform)

async function clickTab(page, name) {
  await (await tab(page, name)).click()
  await lib.waitFor(`${name} to show`, async () => (await activeTab(page)) === name, 5000, 50)
  await lib.sleep(500)
}

async function menuItem(page, cmd) {
  const state = await page.evaluate(() => ({ panel: !!document.querySelector('.menu-panel'), focused: document.hasFocus(), items: [...document.querySelectorAll('.menu-panel [data-cmd]')].map((i) => i.dataset.cmd) }))
  if (!state.items.includes(cmd)) console.log(`Wanted ${cmd}, found`, JSON.stringify(state))
  await page.click(`.menu-panel [data-cmd="${cmd}"]`)
  await lib.sleep(200)
}

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const cwd = lib.workDir('projects')
  const folderB = lib.workDir('projects-b')
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined

  // A save exactly as the previous version wrote it.
  const old = {
    version: 1,
    nodes: [{ id: 'old', kind: 'terminal', title: 'From before', x: 80, y: 80, width: 560, height: 340, parentId: null, cwd }],
    edges: [],
    closed: [{ id: 'closed-1', title: 'Old chat', cwd, sessionId: 'abc', transcriptPath: null, closedAt: 1000 }],
    viewport: { x: 12, y: 34, zoom: 0.9 }
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(old))

  let app = await lib.launch({ profile, exe })
  let { page } = app
  try {
    check('An old save opens as one project', (await tabNames(page)).join() === 'My project', await tabNames(page))
    check('Its window is on screen', (await shownNodes(page)).join() === 'old')
    check('Its view came back', (await viewOf(page)).includes('12px') && (await viewOf(page)).includes('34px'), await viewOf(page))
    const migrated = await lib.doc(page)
    check('Its conversation history came through', migrated.closed[0]?.sessionId === 'abc' && migrated.closed[0]?.projectId === migrated.projects[0].id)

    await lib.input(page, 'old', 'i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.2; done\r')
    await lib.sleep(1000)

    await page.click('[data-cmd="new-project"]')
    await page.waitForSelector('form[aria-label="New project"]')
    const off = await page.$eval('form[aria-label="New project"] .btn-solid', (b) => b.disabled)
    check('A project with no name or folder cannot be created', off)
    await page.type('[name="projectName"]', 'Second')
    await shoot(page, 'project-new-form')
    await page.keyboard.press('Enter')
    await lib.waitFor('the new tab', async () => (await activeTab(page)) === 'Second', 5000, 50)
    await lib.sleep(300)
    check('A new project starts empty and on screen', (await shownNodes(page)).length === 0)
    const sections = await page.$$eval('[data-project-section]', (s) => s.length)
    check('The sidebar lists both projects', sections === 2, sections)

    const second = (await lib.doc(page)).activeProjectId
    await page.evaluate((id, f) => window.patchbay.dispatch({ op: 'patchProject', id, patch: { folder: f } }), second, folderB)
    await page.mouse.click(700, 300, { button: 'right' })
    await lib.sleep(200)
    await menuItem(page, 'new-terminal')
    const fresh = await lib.waitFor('the new terminal', async () => (await lib.doc(page)).nodes.find((n) => n.projectId === second && n.kind === 'terminal'), 5000)
    check("A new terminal starts in the project's folder", fresh.cwd === folderB, fresh.cwd)

    const before = (await lib.snapshot(page, 'old')).match(/tick-(\d+)/g).length
    await lib.sleep(2500)
    const after = (await lib.snapshot(page, 'old')).match(/tick-(\d+)/g).length
    check('A session in another project keeps running', after > before, { before, after })

    await clickTab(page, 'My project')
    check('Switching back shows its window again', (await shownNodes(page)).join() === 'old')
    const lines = await lib.screen(page, 'old')
    check('Its terminal shows the output from while it was hidden', lines.some((l) => /tick-\d+/.test(l)))
    // Git Bash can need a second Ctrl+C for a loop like this, with or without Patchbay. Each press at a prompt
    // prints a new one, so the output is only compared once this press has had time to show.
    await lib.waitFor('the loop to stop', async () => {
      await lib.input(page, 'old', '\x03')
      await lib.sleep(1000)
      const was = await lib.snapshot(page, 'old')
      await lib.sleep(800)
      return (await lib.snapshot(page, 'old')) === was
    }, 30000, 0)

    await page.mouse.move(800, 600)
    await page.mouse.down()
    await page.mouse.move(700, 500, { steps: 5 })
    await page.mouse.up()
    await lib.sleep(200)
    const pannedA = await viewOf(page)
    await clickTab(page, 'Second')
    const seenB = await viewOf(page)
    check('The other project has its own view', seenB !== pannedA, { pannedA, seenB })
    await clickTab(page, 'My project')
    check('Coming back restores the view, including a pan just made', (await viewOf(page)) === pannedA, await viewOf(page))

    // Claude working out of sight, then redrawing.
    await lib.openNode(page, lib.claude('agent', cwd, 700, 80, { prompt: 'Run: sleep 8 && echo done-sleeping, then say finished.' }))
    await lib.waitFor('Claude to start working', async () => (await lib.statusOf(page, 'agent')) === 'working', 90000)
    await clickTab(page, 'Second')
    const signal = await page.$$eval('.project-signal', (s) => s.map((e) => e.className))
    check('A hidden project with work going shows it on the tab', signal.some((c) => c.includes('working')), signal)
    await shoot(page, 'project-tabs')
    await lib.waitFor('Claude to finish out of sight', async () => (await lib.statusOf(page, 'agent')) === 'idle', 120000)
    await clickTab(page, 'My project')
    await lib.fitView(page)
    await lib.sleep(1200)
    await shoot(page, 'project-claude-back')
    const rows = await lib.screen(page, 'agent')
    const rules = rows.filter((r) => /^─{5,}/.test(r))
    const stubs = rows.filter((r) => /^─{1,4}$/.test(r))
    check('Claude redraws cleanly after switching back', rules.length > 0 && stubs.length === 0, { rules: rules.length, stubs })
    check('Claude finished its work while hidden', rows.join('\n').includes('finished') || lib.transcriptText((await lib.nodeOf(page, 'agent')).transcriptPath).includes('finished'))

    // An agent in this project, with the other one on screen.
    await lib.input(page, 'old', 'clear; patchbay list > list.json; patchbay open-terminal --cwd . > opened.json; echo done-$((1+1))\r')
    await clickTab(page, 'Second')
    const first = (await lib.doc(page)).projects[0].id
    const opened = await lib.waitFor('the agent terminal', async () => (await lib.doc(page)).nodes.find((n) => n.openedBy === 'old'), 20000).catch(async (e) => {
      console.log((await lib.snapshot(page, 'old')).slice(-800))
      throw e
    })
    check("A node an agent opens lands in the agent's project", opened.projectId === first, opened.projectId)
    check('It does not appear on the project on screen', !(await shownNodes(page)).includes(opened.id))
    const listed = await lib.waitFor('the list', () => JSON.parse(fs.readFileSync(path.join(cwd, 'list.json'), 'utf8')), 5000)
    check('An agent lists only its own project', !listed.nodes.some((n) => n.id === fresh.id) && listed.nodes.some((n) => n.id === 'old'), listed.nodes.map((n) => n.title))

    // Rename and the tab menu.
    await (await tab(page, 'Second')).click({ button: 'right' })
    await lib.sleep(200)
    await shoot(page, 'project-menu')
    await menuItem(page, 'rename-project')
    await page.keyboard.type('Renamed')
    await page.keyboard.press('Enter')
    await lib.sleep(300)
    check('A project can be renamed', (await tabNames(page)).includes('Renamed'), await tabNames(page))

    // Restart with both projects alive.
    const active = await activeTab(page)
    await app.quit().catch(() => app.forceKill())
    app = await lib.launch({ profile, exe })
    page = app.page
    check('After a restart both tabs are back', (await tabNames(page)).join() === 'My project,Renamed', await tabNames(page))
    check('The same project is on screen', (await activeTab(page)) === active)
    await lib.sleep(1500)
    check('Sessions in the hidden project restarted too', await page.evaluate(async () => {
      const snap = await window.patchbay.attach('old')
      return snap.data.length > 0
    }))

    await (await tab(page, 'Renamed')).click({ button: 'right' })
    await lib.sleep(200)
    await menuItem(page, 'delete-project')
    // The menu closes and a confirmation asks; Cancel is first and holds focus, the red verb deletes.
    await page.waitForSelector('[data-confirm="delete-project"]', { timeout: 5000 })
    const asked = await page.$eval('[data-confirm="delete-project"] .confirm-message', (b) => b.textContent)
    check('Deleting a project with sessions asks first, and names them', asked.includes('Ends') && /for good/.test(asked), asked)
    await page.click('[data-confirm="delete-project"] .btn-danger')
    await lib.waitFor('the tab to go', async () => (await tabNames(page)).length === 1, 10000)
    const final = await lib.doc(page)
    check('Deleting removes its windows and leaves the other project alone', !final.nodes.some((n) => n.id === fresh.id) && final.nodes.some((n) => n.id === 'old'))
    check('The neighbor comes on screen', (await activeTab(page)) === 'My project')

    await (await tab(page, 'My project')).click({ button: 'right' })
    await lib.sleep(200)
    const lastOff = await page.$$eval('.menu-panel [data-cmd="close-project"], .menu-panel [data-cmd="delete-project"]', (b) => b.every((x) => x.disabled))
    check('The last project cannot be closed or deleted', lastOff)
    await page.keyboard.press('Escape')

    check('No errors in the page', app.problems.length === 0, app.problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
  } finally {
    await app.forceKill().catch(() => {})
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
