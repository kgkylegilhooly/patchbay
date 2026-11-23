'use strict'
// Round 3, failure states and long content (docs/plans/r3-content.md). Off-screen, fake agents, no real quota.
//   node test/acceptance/r3-content.cjs            every flow, with checks, pictures in docs/shots/r3-content/after
//   BEFORE=1 node test/acceptance/r3-content.cjs   only the browser and chat flows, pictures only, for a build before
//     the change. The save and host flows are left out there: before, they opened native dialogs in front of the person.
// ONLY=browser|chat|save|host runs one flow.
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const lib = require('./lib.cjs')
const { sleep, waitFor } = lib

const BEFORE = !!process.env.BEFORE
const ONLY = process.env.ONLY
const SHOTS = path.join(lib.root, 'docs', 'shots', 'r3-content', BEFORE ? 'before' : 'after')
fs.mkdirSync(SHOTS, { recursive: true })
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 }
]
const fwd = (p) => p.split(path.sep).join('/')
const fake = fwd(path.join(__dirname, 'fake-claude.cjs'))
const c = lib.checker()
const check = (name, ok, detail) => (BEFORE ? console.log(`(before) ${name}: ${ok ? 'yes' : 'no'}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`) : c.check(name, ok, detail))

async function shots(page, name) {
  for (const size of SIZES) {
    await page.setViewport(size)
    await sleep(350)
    await page.screenshot({ path: path.join(SHOTS, `${name}-${size.width}x${size.height}.png`) })
  }
  await page.setViewport(SIZES[0])
}

async function start(doc, settings = {}) {
  const profile = lib.newProfile({ claudeCommand: `node "${fake}"`, notifications: 'off', sound: 'off', ...settings })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const app = await lib.launch({ profile })
  await app.page.setViewport(SIZES[0])
  return app
}

const project = (folder = '') => ({ id: 'p1', name: 'Demo', folder, viewport: { x: 340, y: 60, zoom: 1 } })
const docOf = (nodes, folder) => ({ version: 2, projects: [project(folder)], activeProjectId: 'p1', viewport: { x: 340, y: 60, zoom: 1 }, edges: [], closed: [], nodes })
const sel = (id) => `.react-flow__node[data-id="${id}"]`
/** Whether the banner sits wholly above the canvas, so no window's header can be under it. */
const clearOfCanvas = (page, selector) =>
  page.evaluate((s) => {
    const b = document.querySelector(s)?.getBoundingClientRect()
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect()
    const head = document.querySelector('.react-flow__node .unit-head, .react-flow__node header')?.getBoundingClientRect()
    if (!b || !pane) return null
    return { ok: b.bottom <= pane.top + 0.5, bannerBottom: Math.round(b.bottom), canvasTop: Math.round(pane.top), headerTop: head ? Math.round(head.top) : null, height: Math.round(b.height) }
  }, selector)
const textOf = (page, selector) => page.evaluate((s) => document.querySelector(s)?.innerText ?? null, selector)

async function browserFlow() {
  const port = 43000 + Math.floor(Math.random() * 2000)
  const node = { id: 'b', kind: 'browser', title: 'Dev server', url: `http://127.0.0.1:${port}/`, x: 0, y: 0, width: 640, height: 420, parentId: null, projectId: 'p1' }
  const app = await start(docOf([node]))
  const { page } = app
  let srv
  try {
    // Nothing is listening yet: the first load fails before the node has told main which page is its own.
    await sleep(3500)
    const panel = `${sel('b')} [data-browser-failure]`
    const first = await textOf(page, panel)
    check('refused at launch: the node says so in plain words', /Nothing is answering at 127\.0\.0\.1:\d+/.test(first ?? ''), first)
    check('refused at launch: a loopback address is retried on its own', /Trying again/i.test(first ?? ''), first)
    check('refused at launch: Try again is there', !!(await page.$(`${panel} [data-browser="try-again"]`)))
    await shots(page, 'browser-refused')

    // The server comes up: the page appears without anyone clicking Reload.
    srv = http.createServer((_q, r) => r.end('<body style="font:20px sans-serif;padding:24px"><title>Dev server is up</title><h1>Dev server is up</h1></body>')).listen(port, '127.0.0.1')
    const upAt = Date.now()
    const recovered = await waitFor('the page after the server came up', async () => {
      const state = await page.evaluate(() => window.patchbay.getBrowserStates().then((s) => s.b))
      const gone = !(await page.$(panel))
      return state && !state.loading && !state.failure && gone && state.title === 'Dev server is up' ? state : null
    }, 8000, 200).catch(() => null)
    check('server up: the page loads on its own within a few seconds', !!recovered, recovered ? `${Date.now() - upAt} ms` : 'still failing')
    await sleep(500)
    await shots(page, 'browser-recovered')

    // A name that can't be found isn't loopback, so it isn't retried, and it says which name.
    await page.evaluate(() => window.patchbay.browserNavigate('b', 'http://no-such-host.invalid/'))
    const dns = await waitFor('the name failure', () => textOf(page, panel), 15000, 200).catch(() => null)
    check('unknown name: says it can\'t find the host', /Can.t find no-such-host\.invalid/.test(dns ?? ''), dns)
    check('unknown name: not retried on its own', !/Trying again/i.test(dns ?? ''), dns)
    await shots(page, 'browser-dns')
    if (!BEFORE) {
      await page.click(`${panel} [data-browser="try-again"]`)
      await sleep(300)
      check('Try again reloads (the panel says it is trying)', /Trying|Can.t find/.test((await textOf(page, panel)) ?? ''))
    }
  } finally {
    srv?.close()
    srv?.closeAllConnections?.()
    await app.forceKill()
    lib.cleanup(app.profile)
  }
}

async function chatFlow() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-r3-chat-'))
  const sid = 'cccccccc-0000-4000-8000-000000000003'
  // Not the fake's own transcript path: started with "chat", it would empty that file.
  const tpath = path.join(cwd, 'long.jsonl')
  const turns = 300
  const lines = []
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', sessionId: sid, uuid: `u${i}`, cwd, message: { role: 'user', content: `Step ${i}: look at src/mod${i}.ts` } }))
    lines.push(JSON.stringify({ type: 'assistant', sessionId: sid, uuid: `a${i}`, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `Reply ${i}. mod${i} exports one function.` }] } }))
  }
  fs.writeFileSync(tpath, lines.join('\n') + '\n')
  const node = { id: 'long', kind: 'claude', title: 'Long history', x: 0, y: 0, width: 640, height: 520, parentId: null, cwd, prompt: 'idle', sessionId: sid, transcriptPath: null, after: [], projectId: 'p1' }
  const app = await start(docOf([node], cwd))
  const { page } = app
  let stopKeeper = () => {}
  try {
    // Started without "chat", the fake reports no transcript of its own, so the one patched in below stays.
    await waitFor('the agent to start', async () => (await lib.seenStatuses(page, 'long')).length > 0 || null, 20000)
    await sleep(800)
    // The fake's own start hook can land after this and clear the path (the audit's harness race), so it's kept set.
    const keepPath = () => page.evaluate(async (p) => {
      const n = (await window.patchbay.getDoc()).nodes.find((x) => x.id === 'long')
      if (n && n.transcriptPath !== p) await window.patchbay.dispatch({ op: 'patchNode', id: 'long', patch: { transcriptPath: p } })
    }, tpath).catch(() => {})
    await keepPath()
    const keeper = setInterval(keepPath, 250)
    stopKeeper = () => clearInterval(keeper)
    await sleep(300)
    await require('./uilib.cjs').headerTool(page, 'long', 'chat')
    const count = () => page.evaluate((s) => document.querySelectorAll(`${s} .chat-msg`).length, sel('long'))
    await waitFor('the chat', async () => (await count()) || null, 15000, 100).catch(async (e) => {
      console.log('chat shows:', await textOf(page, `${sel('long')} .chat`), 'transcriptPath:', (await lib.nodeOf(page, 'long'))?.transcriptPath)
      throw e
    })
    check('chat opens on the last 200 messages', (await count()) === 200, await count())
    const row = `${sel('long')} [data-chat-earlier]`
    await page.evaluate((s) => { const l = document.querySelector(s + ' .chat-list'); l.scrollTop = 0 }, sel('long'))
    await sleep(300)
    const said = await textOf(page, row)
    check('the top says there are earlier messages', /Earlier messages/i.test(said ?? ''), said)
    await shots(page, 'chat-top')
    if (BEFORE) return
    const firstBefore = await page.evaluate((s) => document.querySelector(`${s} .chat-msg`)?.innerText, sel('long'))
    await page.click(`${row} button`)
    await waitFor('more messages', async () => ((await count()) > 200 ? true : null), 10000, 100)
    check('Show earlier adds 200 more', (await count()) === 400, await count())
    // The message that was at the top is still in view, so reading carries on from where it was.
    const kept = await page.evaluate((s, text) => {
      const list = document.querySelector(s + ' .chat-list')
      const msg = [...list.querySelectorAll('.chat-msg')].find((m) => m.innerText === text)
      if (!msg) return false
      const a = msg.getBoundingClientRect()
      const b = list.getBoundingClientRect()
      return a.bottom > b.top && a.top < b.bottom
    }, sel('long'), firstBefore)
    check('the place being read stays in view', kept)
    await page.click(`${row} button`)
    await waitFor('the rest', async () => ((await count()) >= 600 ? true : null), 10000, 100)
    await page.evaluate((s) => { document.querySelector(s + ' .chat-list').scrollTop = 0 }, sel('long'))
    await sleep(200)
    const start = await textOf(page, row)
    check('with everything shown, the top says it is the start', /start of the conversation/i.test(start ?? '') && !(await page.$(`${row} button`)), start)
    const first = await page.evaluate((s) => document.querySelector(`${s} .chat-msg`)?.innerText, sel('long'))
    check('and the first message is Step 0', /Step 0:/.test(first ?? ''), first)
    await shots(page, 'chat-start')
  } finally {
    stopKeeper()
    await app.forceKill()
    lib.cleanup(app.profile)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

async function saveFlow() {
  const app = await start(docOf([{ id: 's1', kind: 'sticky', title: 'Note', text: 'Saved here', x: 0, y: 0, width: 260, height: 180, parentId: null, projectId: 'p1' }]))
  const { page } = app
  const file = path.join(app.profile, 'canvas.json')
  try {
    await sleep(1500)
    // A read-only save file can't be replaced, as on a full disk or a folder another program has locked.
    fs.chmodSync(file, 0o444)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'patchNode', id: 's1', patch: { title: 'Changed while failing' } }))
    const banner = '[data-app-problem="save"]'
    const said = await waitFor('the save banner', () => textOf(page, banner), 15000, 200).catch(() => null)
    check('a failed save shows an in-app banner, not a dialog', /Can.t save/.test(said ?? ''), said)
    check('the banner says it keeps trying', /trying again/i.test(said ?? ''), said)
    const ipcMoves = await page.evaluate(() => Promise.race([window.patchbay.getStatuses().then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]))
    check('the app still answers while saving fails', ipcMoves)
    const clear = await clearOfCanvas(page, banner)
    check('the banner sits above the canvas, over no window', !!clear?.ok, clear)
    await shots(page, 'save-failing')
    await page.click(`${banner} [data-app-problem-action="hide"]`)
    await sleep(200)
    const slim = await clearOfCanvas(page, banner)
    const slimText = await textOf(page, banner)
    check('Hide folds it to one slim line that still says so', !!slim?.ok && slim.height <= 32 && /Not saving/.test(slimText ?? ''), { slim, slimText })
    await shots(page, 'save-hidden')
    fs.chmodSync(file, 0o644)
    const cleared = await waitFor('the banner to clear', async () => ((await page.$(banner)) ? null : true), 15000, 200).catch(() => false)
    check('saving works again: the failure banner goes on its own', cleared)
    const again = await textOf(page, '[data-app-problem="saved"]')
    check('and it says it saved', /Saved/.test(again ?? ''), again)
    await shots(page, 'save-recovered')
    check('the change made while failing is on disk', /Changed while failing/.test(fs.readFileSync(file, 'utf8')))
  } finally {
    try {
      fs.chmodSync(file, 0o644)
    } catch {}
    await app.forceKill()
    lib.cleanup(app.profile)
  }
}

async function hostFlow() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-r3-host-'))
  const node = { id: 't1', kind: 'terminal', title: 'Shell', x: 0, y: 0, width: 560, height: 320, parentId: null, cwd, after: [], projectId: 'p1' }
  const app = await start(docOf([node], cwd))
  const { page } = app
  try {
    const pid = await waitFor('the session host', () => lib.hostPid(app.profile), 20000)
    await sleep(1000)
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
    const banner = '[data-app-problem="host"]'
    const said = await waitFor('the host banner', () => textOf(page, banner), 20000, 200).catch(() => null)
    check('a lost host shows an in-app banner, not a dialog', /Background sessions stopped/.test(said ?? ''), said)
    const clear = await clearOfCanvas(page, banner)
    check('the host banner sits above the canvas, over no window', !!clear?.ok, clear)
    await shots(page, 'host-lost')
    await page.click(`${banner} [data-app-problem-action="hide"]`)
    await sleep(200)
    check('Not now folds it to a slim line with Bring them back', /Background sessions stopped/.test((await textOf(page, banner)) ?? '') && !!(await page.$(`${banner}[data-folded] [data-app-problem-action="bring-back"]`)))
    await shots(page, 'host-hidden')
    await page.click(`${banner} [data-app-problem-action="bring-back"]`)
    const back = await waitFor('a new host', () => {
      const now = lib.hostPid(app.profile)
      return now && now !== pid ? now : null
    }, 20000).catch(() => null)
    check('Bring them back starts a new host', !!back, back)
    const gone = await waitFor('the banner to go', async () => ((await page.$(banner)) ? null : true), 10000, 200).catch(() => false)
    check('and the banner goes', gone)
    await sleep(1500)
    check('the terminal runs again', ['idle', undefined, null].includes(await lib.statusOf(page, 't1')), await lib.statusOf(page, 't1'))
    await shots(page, 'host-back')
  } finally {
    await app.forceKill()
    lib.stopHostOf?.(app.profile)
    lib.cleanup(app.profile)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

;(async () => {
  const flows = { browser: browserFlow, chat: chatFlow, ...(BEFORE ? {} : { save: saveFlow, host: hostFlow }) }
  for (const [name, flow] of Object.entries(flows)) {
    if (ONLY && ONLY !== name) continue
    console.log(`--- ${name}`)
    await flow().catch((e) => check(`${name} ran to the end`, false, e.message))
  }
  console.log(`pictures in ${SHOTS}`)
  if (!BEFORE) c.finish()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
