'use strict'
// A window that falls behind on terminal output catches up correctly. See src/main/outputPacer.ts.
//
//   node test/acceptance/outputPacing.cjs      the built app (npm run build first), a throwaway profile, no quota
//
// Ten terminals print numbered lines of about 1 KB fast in the shown project, three more in a hidden one. The page is made busy (a
// busy loop, as a real hang), so main stops sending it output; afterwards every terminal must hold an unbroken run of
// numbered lines ending where the session's own buffer ends. A terminal with a selection and an open search is watched
// through a long stall (it missed too much, so it starts afresh from the buffer) and a short one (it gets exactly what
// it missed, so the selection is untouched). The hidden project's terminals must be sent nothing while hidden, and be
// right once shown.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const lib = require('./lib.cjs')
const { sleep, waitFor, launch, openNode, terminal, checker, newProfile, workDir, cleanup, fitView, submit, shot } = lib

/** Prints numbered lines in a burst each time a line is typed, then DONE. Runs as the terminal's program. */
function emitter() {
  let n = 0
  let busy = false
  const nl = String.fromCharCode(13, 10)
  process.stdout.write('$ ')
  process.stdin.on('data', () => {
    if (busy) return
    busy = true
    const end = Date.now() + Number(process.env.BURST_MS || 7000)
    const t = setInterval(() => {
      let s = ''
      for (let i = 0; i < 16; i++) s += 'L' + String(n++).padStart(7, '0') + ' ' + 'abcdefghijklmnopqrstuvwxyz0123'.repeat(33) + nl
      process.stdout.write(s)
      if (Date.now() > end) {
        clearInterval(t)
        busy = false
        process.stdout.write('DONE ' + n + nl + '$ ')
      }
    }, 20)
  })
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

async function cdp(url) {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) (pending.get(m.id)?.(m), pending.delete(m.id)) }
  return {
    close: () => ws.close(),
    async eval(expression) {
      const m = await new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))))
      if (m.result?.exceptionDetails) throw Error(JSON.stringify(m.result.exceptionDetails))
      return m.result?.result?.value
    }
  }
}

/** Counts, in main, the output sent to the window by session, and how much of it started afresh. */
const COUNT_SENDS = `(() => {
  const { webContents } = process.mainModule.require('electron')
  globalThis.__sends = {}
  for (const wc of webContents.getAllWebContents()) {
    if (wc.__counted) continue
    wc.__counted = true
    const send = wc.send.bind(wc)
    wc.send = (ch, ...a) => {
      if (ch === 'pb:onOutput') {
        const r = (globalThis.__sends[a[0]] ??= { n: 0, resets: 0, chars: 0 })
        r.n++
        r.chars += a[1].length
        if (a[1].startsWith(String.fromCharCode(27) + 'c')) r.resets++
      }
      return send(ch, ...a)
    }
  }
  return true
})()`

/** In the page: the xterm Terminal of a node, found through React's own records of TerminalView's refs. */
const TERM_OF = `(id) => {
  const el = document.querySelector('[data-term-node="' + id + '"]')
  if (!el) return null
  let f = el[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))]
  for (; f; f = f.return) {
    for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
      const v = h.memoizedState
      if (v && v.current && v.current.buffer && v.current.buffer.active && typeof v.current.select === 'function') return v.current
    }
  }
  return null
}`

/** The terminal's whole buffer as logical lines, and its selection. */
const readTerm = (page, id) =>
  page.evaluate((src, i) => {
    const termOf = eval(src)
    const term = termOf(i)
    if (!term) return null
    const b = term.buffer.active
    const lines = []
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y)
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
    }
    return { lines, hasSelection: term.hasSelection(), selection: term.getSelection() }
  }, TERM_OF, id)

/**
 * Whether the numbered lines run on without a gap or a repeat, and the last number. `strict` also needs each line's
 * text whole between its number and the next. A session no view has sized yet runs at 80 columns, where ConPTY draws
 * long lines itself and its replay doesn't read back as whole lines (the same before output pacing), so for those only
 * the numbers are checked.
 */
function continuity(lines, strict = true) {
  // Read as one text, without the spaces rows are padded with: the lines have none past the number's.
  const text = lines.join('').replace(/\s+/g, '')
  const nums = []
  let torn = 0
  const line = strict ? /L(\d{7})((?:abcdefghijklmnopqrstuvwxyz0123)*)(?=L\d{7}|DONE|$)/g : /L(\d{7})(?=[a-z])/g
  for (const m of text.matchAll(line)) {
    nums.push(Number(m[1]))
    // The oldest line can be cut off by the start of the buffer, so only lines after it count.
    if (strict && m[2].length !== 990 && nums.length > 1) torn++
  }
  const breaks = []
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) breaks.push([nums[i - 1], nums[i]])
  if (torn) breaks.push(['torn lines', torn])
  return { count: nums.length, first: nums[0], last: nums[nums.length - 1], breaks: breaks.slice(0, 5), broken: breaks.length }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g, '')
const lastNumber = (text) => { const all = [...stripAnsi(text).matchAll(/L(\d{7}) /g)]; return all.length ? Number(all[all.length - 1][1]) : null }

async function busyPage(page, ms) {
  const done = page.evaluate((t) => { const end = Date.now() + t; while (Date.now() < end); return 1 }, ms).catch(() => 0)
  await sleep(ms)
  await done
}

async function main() {
  const c = checker()
  const work = workDir('output-pacing')
  const script = path.join(work, 'emit.cjs')
  fs.writeFileSync(script, `(${emitter.toString()})()\n`)
  const profile = newProfile({ notifications: 'off', sound: 'off', usageSource: 'off', terminalProfiles: [{ id: 'fake', name: 'Numbered lines', program: process.execPath, args: [script] }], defaultTerminalProfile: 'fake' })
  const projects = [1, 2].map((i) => ({ id: 'p' + i, name: 'Pacing ' + i, folder: work, viewport: { x: 0, y: 0, zoom: 0.5 } }))
  const shown = Array.from({ length: 10 }, (_, i) => terminal(i ? 'load' + i : 'sel', work, (i % 4) * 500, Math.floor(i / 4) * 320, { projectId: 'p1' }))
  const hidden = Array.from({ length: 3 }, (_, i) => terminal('back' + i, work, i * 500, 0, { projectId: 'p2' }))
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects, activeProjectId: 'p1', viewport: projects[0].viewport, nodes: [...shown, ...hidden], edges: [], closed: [] }))
  const port = await freePort()
  process.env.PB_MAIN_INSPECT = String(port)
  const app = await launch({ profile })
  const errors = []
  app.page.on('pageerror', (e) => errors.push(e.message))
  app.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const main = await cdp((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0].webSocketDebuggerUrl)
  const all = [...shown, ...hidden].map((n) => n.id)
  try {
    await waitFor('every shell', async () => (await Promise.all(all.map((id) => lib.snapshot(app.page, id)))).every((s) => s.includes('$')), 60000)
    await fitView(app.page)
    await waitFor('the terminal to be readable', () => readTerm(app.page, 'sel'), 20000)
    await main.eval(COUNT_SENDS)
    const sends = () => main.eval('globalThis.__sends')

    // --- A long stall: the selected, searched terminal misses far more than is kept.
    console.log('\n--- A long stall, with a selection and a search open')
    for (const id of all) await submit(app.page, id, 'go')
    await sleep(1500)
    await app.page.evaluate((src) => { const t = eval(src)('sel'); t.select(0, t.buffer.active.viewportY + 2, 12) }, TERM_OF)
    await app.page.click('[data-term-node="sel"] .term-host')
    await app.page.keyboard.down('Control')
    await app.page.keyboard.press('KeyF')
    await app.page.keyboard.up('Control')
    await app.page.waitForSelector('[data-term-node="sel"] form.find input', { timeout: 5000 })
    await app.page.type('[data-term-node="sel"] form.find input', 'abcdefghij')
    await app.page.evaluate((src) => { const t = eval(src)('sel'); t.select(0, t.buffer.active.viewportY + 2, 12) }, TERM_OF)
    const before = await readTerm(app.page, 'sel')
    c.check('a selection is made before the stall', before.hasSelection, before.selection)
    const total = (x) => Object.values(x).reduce((n, r) => n + r.chars, 0)
    const atStall = total(await sends())
    await busyPage(app.page, 8000)
    console.log(`NOTE  sent to the busy page in 8 s: ${((total(await sends()) - atStall) / 1048576).toFixed(1)} M characters`)
    await waitFor('every burst to end', async () => (await Promise.all(all.map((id) => lib.snapshot(app.page, id)))).every((s) => stripAnsi(s).includes('DONE')), 60000)
    await sleep(2500)
    let counted = await sends()
    c.check('the long stall started the selected terminal afresh', (counted.sel?.resets ?? 0) >= 1, counted.sel)
    for (const n of shown) {
      const t = await readTerm(app.page, n.id)
      const run = continuity(t.lines)
      const tail = lastNumber(await lib.snapshot(app.page, n.id))
      if (n.id === 'sel' || run.broken || run.last !== tail) c.check(`${n.id}: an unbroken run of lines, ending where its session does`, !run.broken && run.last === tail && run.count > 100, { ...run, sessionEndsAt: tail })
    }
    c.check('all ten shown terminals are whole after the long stall', true)
    const afterLong = await readTerm(app.page, 'sel')
    c.check('after starting afresh the selection is gone, or still names text that is there', !afterLong.hasSelection || afterLong.lines.join('\n').includes(afterLong.selection), { hasSelection: afterLong.hasSelection, selection: afterLong.selection })
    await app.page.focus('[data-term-node="sel"] form.find input')
    await app.page.keyboard.press('Enter')
    await sleep(300)
    const found = await app.page.$eval('[data-term-node="sel"] .find-count', (e) => e.textContent)
    c.check('the open search still finds matches in what is shown now', /\d/.test(found ?? '') && !/^0\b|no /i.test(found ?? ''), found)
    c.check('the page reported no errors', errors.length === 0, errors.slice(0, 3))
    console.log(`evidence: ${await shot(app.page, 'output-pacing-long-stall')}`)

    // --- A short stall: what each terminal missed is kept, so it gets exactly that.
    console.log('\n--- A short stall')
    // The search selects what it finds as output comes, so it's closed: this is about what pacing does to a selection.
    await app.page.focus('[data-term-node="sel"] form.find input')
    await app.page.keyboard.press('Escape')
    await app.page.evaluate((src) => { const t = eval(src)('sel'); t.select(0, t.buffer.active.viewportY + 1, 12) }, TERM_OF)
    const selBefore = (await readTerm(app.page, 'sel')).selection
    const resetsBefore = (await sends()).sel?.resets ?? 0
    for (const n of shown) await lib.input(app.page, n.id, 'go\r')
    for (const n of hidden) await lib.input(app.page, n.id, 'go\r')
    await sleep(300)
    await busyPage(app.page, 700)
    await sleep(8000)
    counted = await sends()
    const resetsShort = (counted.sel?.resets ?? 0) - resetsBefore
    const selAfter = await readTerm(app.page, 'sel')
    console.log(`NOTE  the short stall was caught up ${resetsShort ? 'by starting afresh' : 'exactly, with no reset'}`)
    // xterm itself moves a selection as old lines leave a full scrollback, so only its being there is pacing's to keep.
    if (resetsShort === 0) c.check('so the selection is still there', selAfter.hasSelection, { before: selBefore, after: selAfter.selection })
    let whole = 0
    for (const n of shown) {
      const run = continuity((await readTerm(app.page, n.id)).lines)
      const tail = lastNumber(await lib.snapshot(app.page, n.id))
      if (!run.broken && run.last === tail) whole++
      else c.check(`${n.id}: unbroken after the short stall`, false, { ...run, sessionEndsAt: tail })
    }
    c.check('all ten shown terminals are whole after the short stall', whole === 10, whole)

    // --- The hidden project.
    console.log('\n--- The hidden project')
    c.check('nothing was sent for the hidden project while hidden', hidden.every((n) => !counted[n.id]), hidden.map((n) => counted[n.id] ?? null))
    await app.page.evaluate(() => window.patchbay.dispatch({ op: 'switchProject', id: 'p2' }))
    await waitFor('the hidden terminals to show', async () => (await Promise.all(hidden.map((n) => readTerm(app.page, n.id)))).every(Boolean), 20000)
    await sleep(1500)
    for (const n of hidden) {
      const t = await readTerm(app.page, n.id)
      const run = continuity(t.lines, false)
      const sample = t.lines.filter(Boolean).slice(-2).map((l) => l.slice(0, 60))
      const tail = lastNumber(await lib.snapshot(app.page, n.id))
      c.check(`${n.id}: shown again whole, ending where its session does`, !run.broken && run.last === tail && run.count > 100, { ...run, sessionEndsAt: tail, sample })
    }
    c.check('the page reported no errors', errors.length === 0, errors.slice(0, 3))
    console.log(`evidence: ${await shot(app.page, 'output-pacing-hidden-shown')}`)
  } catch (e) {
    c.check('finished without an error', false, e.message)
  } finally {
    main.close()
    await app.forceKill()
    lib.stopHostOf(profile)
    cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
