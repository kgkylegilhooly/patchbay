'use strict'
// Round 3, first run and starting agents (docs/plans/r3-start.md). Off-screen, throwaway profiles, fake-claude.cjs
// agents only: no real quota, no Codex. Build first (npx electron-vite build), then: node test/acceptance/r3-start.cjs
//
//   A  16 projects: the window never scrolls, the dock and pill stay on screen, "N more" reaches the hidden tabs,
//      and the sidebar says its empty-project help once (#1, #13)
//   B  first run: the form says why it can't start, the chosen folder becomes the project's, and the new agent is
//      selected with the keyboard (#2, #3); a gone folder reads "Couldn't start" with Choose folder… (#4)
//   C  the agent program missing: said in the form before Start, "Couldn't start" with Open Settings › Agents,
//      under Need attention (#4)
//   D  reopened agents say "Reconnecting…" just after launch, then their own words (#16)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lib = require('./lib.cjs')

const fake = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')
const { check, finish } = lib.checker()
const sleep = lib.sleep
const view = { x: 0, y: 0, zoom: 1 }
const docOf = (projects, nodes = []) => ({ version: 2, projects, activeProjectId: projects[0].id, viewport: view, edges: [], closed: [], nodes })
const agent = (id, cwd, prompt, extra = {}) => ({ id, kind: 'claude', title: id, x: 40, y: 40, width: 560, height: 300, parentId: null, cwd, prompt, sessionId: null, transcriptPath: null, after: [], projectId: 'p1', ...extra })

async function start(settings, doc, env = {}) {
  const profile = lib.newProfile({ claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off', ...settings })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const app = await lib.launch({ profile, env })
  await app.page.setViewport({ width: 1280, height: 800 })
  return app
}

const keys = async (page, key, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel)
const focusIn = (page) =>
  page.evaluate(() => {
    const e = document.activeElement
    return { node: e?.closest('.react-flow__node')?.getAttribute('data-id') ?? null, xterm: !!e?.classList.contains('xterm-helper-textarea'), attr: e?.hasAttribute('data-choose-folder') ? 'choose-folder' : e?.tagName }
  })
const badge = (page, id) => text(page, `.react-flow__node[data-id="${id}"] .unit-head .st-label`)

async function partA() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-r3-a-'))
  const names = ['Patchbay', 'Website', 'Billing API', 'Docs site', 'Customer portal redesign', 'Mobile app', 'Data pipeline', 'Infra', 'Search service', 'Design system', 'Onboarding emails', 'Analytics', 'Release tooling', 'Support bot', 'Payments', 'Legacy admin']
  const projects = names.map((name, i) => ({ id: `p${i + 1}`, name, folder: cwd, viewport: view }))
  // A stopped agent in another project: its sidebar row has a stop, a start failure and a Reconnecting check.
  const app = await start({}, docOf(projects, [agent('stopped', cwd, 'unknown', { projectId: 'p2' })]))
  const { page } = app
  try {
    await lib.waitFor('the stopped agent', async () => (await lib.statusOf(page, 'stopped')) === 'unknown', 20000, 100).catch(() => null)
    for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }]) {
      await page.setViewport(size)
      const measure = () =>
        page.evaluate(() => ({
          docW: document.documentElement.scrollWidth,
          docH: document.documentElement.scrollHeight,
          w: innerWidth,
          h: innerHeight,
          dockRight: document.querySelector('.dock')?.getBoundingClientRect().right,
          pillRight: document.querySelector('.usage-pill')?.getBoundingClientRect().right ?? null,
          more: document.querySelector('[data-project-more]')?.textContent?.trim() ?? null
        }))
      // The dock and the tab count follow a resize a frame or two later: measured once two readings agree.
      let last = null
      const m = await lib.waitFor('the layout at the new size', async () => {
        const now = await measure()
        const same = last && JSON.stringify(last) === JSON.stringify(now) && now.w === size.width
        last = now
        return same && now
      }, 5000, 100).catch(() => last)
      check(`A ${size.width}x${size.height}: the window doesn't scroll`, m.docW <= m.w && m.docH <= m.h, m)
      check(`A ${size.width}x${size.height}: the dock and the usage pill stay on screen`, m.dockRight <= m.w && (m.pillRight === null || m.pillRight <= m.w))
      check(`A ${size.width}x${size.height}: a "N more" button counts the hidden tabs`, /^▾ \d+ more$/.test(m.more ?? ''), m.more)
    }
    await page.click('[data-project-more]')
    await page.waitForSelector('.menu-panel [role=menuitem]')
    const items = await page.evaluate(() => [...document.querySelectorAll('.menu-panel [role=menuitem]')].map((e) => e.textContent.trim()))
    check('A the "more" menu lists the hidden projects', items.includes('Legacy admin') && !items.includes('Patchbay'), items)
    await page.evaluate(() => [...document.querySelectorAll('.menu-panel [role=menuitem]')].find((e) => e.textContent.includes('Legacy admin')).click())
    await lib.waitFor('Legacy admin on screen', () => page.evaluate(() => document.querySelector('.project-tab-active')?.textContent.trim() === 'Legacy admin'), 5000, 50)
    // Scrolled in the frame after the switch.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const active = await page.evaluate(() => {
      const list = document.querySelector('.projects').getBoundingClientRect()
      const tab = document.querySelector('.project-tab-active').getBoundingClientRect()
      return { name: document.querySelector('.project-tab-active')?.textContent.trim(), inView: tab.left >= list.left - 1 && tab.right <= list.right + 1 }
    })
    check('A choosing one switches to it, and its tab is scrolled into view', active.name === 'Legacy admin' && active.inView, active)
    const hints = await page.evaluate(() => [...document.querySelectorAll('.sidebar .sidebar-empty')].map((e) => e.textContent.trim()))
    check('A the sidebar gives the empty-project help once, and "None" elsewhere', hints.filter((h) => h.startsWith('No sessions here')).length === 1 && hints.filter((h) => h === 'None').length === 14, hints)
    check('A no page errors', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.forceKill()
    lib.cleanup(app.profile)
  }
}

async function partB() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-r3-b-'))
  const app = await start({}, docOf([{ id: 'p1', name: 'My project', folder: '', viewport: view }]), { PATCHBAY_TEST_PICK_FOLDER: cwd })
  const { page } = app
  let agentId
  try {
    await page.waitForSelector('[data-empty="new-claude"]')
    await keys(page, 'KeyC', ['Control', 'Shift'])
    await page.waitForSelector('.pop-claude')
    await lib.waitFor('the prompt focused', async () => (await focusIn(page)).attr === 'TEXTAREA', 3000, 25).catch(() => null)
    check('B the prompt has the keyboard, so a task typed first lands there', (await focusIn(page)).attr === 'TEXTAREA')
    check('B with no folder, Choose folder is the button that stands out', await page.evaluate(() => document.querySelector('[data-choose-folder]')?.classList.contains('btn-solid')))
    check('B the form says why Start is off, and what Ctrl+Enter does', /^Choose a folder first/.test((await text(page, '[data-blocked-why]')) ?? ''), await text(page, '[data-blocked-why]'))
    await page.keyboard.type('idle context=20')
    // Ctrl+Enter with no folder asks for one (answered here by PATCHBAY_TEST_PICK_FOLDER), then starts there. Pressed
    // twice, as an impatient person might: one picker, one agent.
    await keys(page, 'Enter', ['Control'])
    await keys(page, 'Enter', ['Control'])
    agentId = await lib.waitFor('the new agent', async () => (await lib.doc(page)).nodes.find((n) => n.kind === 'claude')?.id, 10000, 50)
    const d = await lib.doc(page)
    check('B the chosen folder became the project\'s', d.projects[0].folder === cwd, d.projects[0].folder)
    check('B a toast says where the project now starts, with Change', /My project now starts in/.test((await text(page, '[data-folder-toast]')) ?? '') && !!(await page.$('[data-folder-toast-change]')))
    await lib.waitFor('the new agent selected', () => page.evaluate((i) => document.querySelector(`.react-flow__node[data-id="${i}"]`)?.classList.contains('selected'), agentId), 5000, 50)
    check('B the new agent is selected', true)
    const f = await lib.waitFor('focus in the new terminal', async () => { const x = await focusIn(page); return x.node === agentId && x.xterm && x }, 5000, 50).catch(() => null)
    check('B the new agent has the keyboard', !!f, await focusIn(page))
    await lib.waitFor('idle', async () => (await lib.statusOf(page, agentId)) === 'idle', 20000, 100)
    await page.keyboard.type('hello')
    const echoed = await lib.waitFor('the echo', async () => (await lib.screen(page, agentId)).join('\n').includes('hello'), 8000, 100).catch(() => false)
    check('B typing straight after starting reaches the new agent', echoed)
    check('B Ctrl+Enter twice started one agent', (await lib.doc(page)).nodes.filter((n) => n.kind === 'claude').length === 1)
    // The next agent in this project needs no picker.
    await page.evaluate(() => document.activeElement?.blur())
    await keys(page, 'KeyC', ['Control', 'Shift'])
    await page.waitForSelector('.pop-claude')
    const next = await page.evaluate(() => ({ folder: document.querySelector('.pop-claude .folder')?.getAttribute('title'), disabled: document.querySelector('.pop-claude button[type=submit]')?.disabled, why: !!document.querySelector('[data-blocked-why]') }))
    check('B the next New Claude Code starts in that folder, ready to go', next.folder === cwd && next.disabled === false && !next.why, next)
    await keys(page, 'Escape')
    // New terminal from the dock gets the keyboard too.
    await page.evaluate(() => document.activeElement?.blur())
    await page.click('[data-cmd="add"]').catch(() => {})
    await page.waitForSelector('.menu-panel [role=menuitem]', { timeout: 5000 }).catch(() => null)
    const added = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.menu-panel [role=menuitem]')].find((e) => /^New terminal/.test(e.textContent.trim()))
      item?.click()
      return !!item
    })
    if (added) {
      const termId = await lib.waitFor('the new terminal', async () => (await lib.doc(page)).nodes.find((n) => n.kind === 'terminal')?.id, 10000, 50)
      const tf = await lib.waitFor('focus in the new terminal', async () => { const x = await focusIn(page); return x.node === termId && x.xterm && x }, 5000, 50).catch(() => null)
      check('B New terminal gets the keyboard', !!tf, await focusIn(page))
    } else check('B New terminal gets the keyboard (Add menu item not found)', false)

    // A folder that's gone: "Couldn't start", Choose folder… starts it again there.
    await lib.openNode(page, agent('gone', path.join(cwd, 'deleted-folder'), 'idle', { x: 700, y: 400 }))
    await lib.waitFor("Couldn't start", async () => (await badge(page, 'gone')) === "Couldn't start", 10000, 100)
    check("B a gone folder reads \"Couldn't start\", not Exited", true)
    check('B its strip offers Choose folder…', (await text(page, '.react-flow__node[data-id="gone"] [data-start-fix="folder"]')) === 'Choose folder…')
    // Added straight to the canvas, so it may be outside the view: clicked where it is.
    await page.evaluate(() => document.querySelector('.react-flow__node[data-id="gone"] [data-start-fix="folder"]').click())
    const back = await lib.waitFor('started in the new folder', async () => { const n = await lib.nodeOf(page, 'gone'); return n.cwd === cwd && (await lib.statusOf(page, 'gone')) === 'idle' }, 20000, 100).catch(() => false)
    check('B choosing a folder starts it again there', back, { cwd: (await lib.nodeOf(page, 'gone')).cwd, status: await lib.statusOf(page, 'gone'), strip: await text(page, '.react-flow__node[data-id="gone"] .strip-error'), badge: await badge(page, 'gone') })
    check('B no page errors', app.problems.length === 0, app.problems.slice(0, 3))

    if (process.env.R3_SKIP_D) return
    // D: quit leaving the sessions running, open again: the agents are taken on again and say Reconnecting.
    await app.quitLeavingSessions()
    const again = await lib.launch({ profile: app.profile, env: { PATCHBAY_TEST_PICK_FOLDER: cwd } })
    await again.page.setViewport({ width: 1280, height: 800 })
    const rowBadge = (id) => again.page.evaluate((i) => { const b = document.querySelector(`.sidebar [data-session="${i}"] .st-label`); return b ? { text: b.textContent.trim(), reconnecting: b.hasAttribute('data-reconnecting') } : null }, id)
    const early = await lib.waitFor('a row badge', () => rowBadge(agentId), 5000, 50).catch(() => null)
    check('D just after launch, a reopened agent with no status yet says Reconnecting…', early?.text === 'Reconnecting…' && early.reconnecting, early)
    // Reconnecting lasts 10 s from the first canvas: waited for, not slept.
    const later = await lib.waitFor('its own words', async () => { const b = await rowBadge(agentId); return b && b.text !== 'Reconnecting…' && b }, 15000, 250).catch(() => rowBadge(agentId))
    check('D after the moment passes, its own words stand', !!later && later.text !== 'Reconnecting…', later)
    await again.forceKill()
  } finally {
    await app.forceKill().catch(() => {})
    lib.cleanup(app.profile)
  }
}

async function partC() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-r3-c-'))
  const app = await start({ claudeCommand: 'claude-not-installed-xyz' }, docOf([{ id: 'p1', name: 'Demo', folder: cwd, viewport: view }]))
  const { page } = app
  try {
    await page.waitForSelector('[data-empty="new-claude"]')
    await keys(page, 'KeyC', ['Control', 'Shift'])
    await page.waitForSelector('.pop-claude')
    const warn = await lib.waitFor('the warning', () => text(page, '[data-program-missing]'), 8000, 100).catch(() => null)
    check('C the New form says the program is missing, before Start', /Claude Code command set in Settings wasn't found/.test(warn ?? ''), warn)
    await page.focus('.pop-claude textarea')
    await keys(page, 'Enter', ['Control'])
    const id = await lib.waitFor('the agent', async () => (await lib.doc(page)).nodes.find((n) => n.kind === 'claude')?.id, 10000, 50)
    await lib.waitFor("Couldn't start", async () => (await badge(page, id)) === "Couldn't start", 10000, 100).catch(() => null)
    check("C it reads \"Couldn't start\", held", (await badge(page, id)) === "Couldn't start" && (await page.evaluate((i) => document.querySelector(`.react-flow__node[data-id="${i}"] .unit-head .st-label`)?.dataset.tone, id)) === 'held')
    const msg = await text(page, `.react-flow__node[data-id="${id}"] .strip-error .strip-text`)
    check('C the message names Claude Code', /The Claude Code command "claude-not-installed-xyz" was not found/.test(msg ?? ''), msg)
    await page.click('[data-sidebar-tab="status"]')
    const needs = await lib.waitFor('Need attention', () => page.evaluate((i) => !!document.querySelector(`.sidebar [data-status-section="needs-you"] [data-session="${i}"]`), id), 5000, 50).catch(() => false)
    check('C it is under Need attention', needs)
    await page.click(`.react-flow__node[data-id="${id}"] [data-start-fix="agents"]`)
    const at = await lib.waitFor('Settings at Agents', () => page.evaluate(() => document.querySelector('.set-nav [data-section="claude"]')?.getAttribute('aria-current') === 'page'), 5000, 50).catch(() => false)
    check('C Open Settings › Agents opens Settings at Agents', at)
    check('C no page errors', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.forceKill()
    lib.cleanup(app.profile)
  }
}

;(async () => {
  const only = process.argv[2]
  if (!only || only === 'A') await partA()
  if (only === 'B1') { process.env.R3_SKIP_D = '1'; await partB() }
  if (!only || only === 'B') await partB()
  if (!only || only === 'C') await partC()
  finish()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
