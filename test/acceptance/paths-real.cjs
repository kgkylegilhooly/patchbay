'use strict'
// File paths and links as real programs print them, in a real Git Bash on the canvas: each is hovered and
// right-clicked with the real mouse, and Copy path or Copy link is checked against what's on the clipboard. Nothing
// is opened, since that would launch apps or a browser on the desktop of whoever runs this; Open uses the same path
// resolution that Copy path is checked on. Run after npm run build: node test/acceptance/paths-real.cjs [--packaged]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(6 * 60_000)

/** Where a piece of text is on screen, inside the row that carries a case's tag. */
async function spot(page, id, tag, sub) {
  return L.waitFor(`${tag} on screen`, () =>
    page.evaluate(
      (i, t, s) => {
        const rows = [...document.querySelectorAll(`.react-flow__node[data-id="${i}"] .xterm-rows > div`)]
        const row = rows.find((r) => r.textContent.replace(/\u00a0/g, ' ').includes(t))
        if (!row) return null
        const text = row.textContent.replace(/\u00a0/g, ' ')
        const from = text.indexOf(s, text.indexOf(t) + t.length)
        if (from < 0) return null
        // The middle of the text, through the row's text nodes.
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        const mid = from + Math.floor(s.length / 2)
        let seen = 0
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const len = n.textContent.length
          if (seen + len > mid) {
            const range = document.createRange()
            range.setStart(n, mid - seen)
            range.setEnd(n, mid - seen + 1)
            const box = range.getBoundingClientRect()
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
          }
          seen += len
        }
        return null
      },
      id,
      tag,
      sub
    ),
    15000
  )
}

async function menuAt(page, at, button) {
  await page.mouse.move(at.x - 30, at.y)
  await page.mouse.move(at.x, at.y, { steps: 5 })
  await L.sleep(350)
  // xterm marks the hovered link with a pointer cursor on an element inside the terminal.
  const pointer = await page.evaluate(() => !!document.querySelector('.xterm-cursor-pointer'))
  await page.mouse.click(at.x, at.y, { button })
  const shown = await page.waitForSelector('.menu-panel', { timeout: 3000 }).then(() => true, () => false)
  const labels = shown ? await page.$$eval('.menu-panel .menu-label', (ls) => ls.map((l) => l.textContent)) : []
  // How far the menu's corner is from where the pointer was: a menu opens at the pointer, at any canvas zoom.
  const off = shown ? await page.$eval('.menu-panel', (m, p) => { const r = m.getBoundingClientRect(); return Math.round(Math.hypot(r.left - p.x, r.top - p.y)) }, at) : null
  return { pointer, labels, off }
}

const closeMenu = async (page) => {
  await page.keyboard.press('Escape')
  await page.waitForSelector('.menu-panel', { hidden: true, timeout: 2000 }).catch(() => {})
}

async function copied(page, cmd, want) {
  await page.evaluate(() => window.patchbay.writeClipboard('(nothing yet)'))
  await page.click(`[data-cmd="${cmd}"]`)
  return L.waitFor('the clipboard', () => page.evaluate(() => navigator.clipboard.readText()).then((t) => (t === want ? t : null)), 3000).catch(async () =>
    page.evaluate(() => navigator.clipboard.readText())
  )
}

async function main() {
  const work = L.workDir('paths-real')
  for (const d of ['src', 'docs', 'build', 'my folder']) fs.mkdirSync(path.join(work, d), { recursive: true })
  for (const f of ['src/app.ts', 'docs/readme.md', 'my folder/notes 2.md', 'my folder/notes.md']) fs.writeFileSync(path.join(work, f), 'x\n')
  const sub = path.join(work, 'build')
  const fwd = work.replace(/\\/g, '/')
  const bash = `/${fwd[0].toLowerCase()}${fwd.slice(2)}`
  const app = path.join(work, 'src', 'app.ts')
  const homeFile = ['.gitconfig', '.bashrc', '.profile'].map((f) => path.join(os.homedir(), f)).find((f) => fs.existsSync(f))

  // [tag, what's printed, the part hovered, what Copy should put on the clipboard]
  const cases = [
    ['c1', 'src/app.ts', 'src/app.ts', app],
    ['c2', './src/app.ts', './src/app.ts', app],
    ['c3', 'src/app.ts:12:5', 'src/app.ts', app],
    ['c4', `${work}\\src\\app.ts`, 'app.ts', app],
    ['c5', `${fwd}/src/app.ts`, 'app.ts', app],
    ['c6', `${bash}/src/app.ts`, 'app.ts', app],
    ['c7', 'Edited src/app.ts.', 'src/app.ts', app],
    ['c8', '(see docs/readme.md)', 'docs/readme.md', path.join(work, 'docs', 'readme.md')],
    ['c9', '"my folder/notes 2.md"', 'notes 2.md', path.join(work, 'my folder', 'notes 2.md')],
    ['c10', `${work}\\my folder\\notes.md`, 'notes.md', path.join(work, 'my folder', 'notes.md')],
    ['c11', `file:///${fwd}/src/app.ts`, 'app.ts', app],
    ['c12', `file:///${fwd}/my%20folder/notes%202.md`, 'notes%202.md', path.join(work, 'my folder', 'notes 2.md')],
    ['c13', 'src/app.ts#L12', 'src/app.ts', app],
    ['c14', `../paths-real/src/app.ts:3`, 'app.ts', app],
    ['c15', './build', './build', sub],
    ...(homeFile ? [['c16', `~/${path.basename(homeFile)}`, path.basename(homeFile), homeFile]] : [])
  ]

  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const appRun = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = appRun
  const dialogs = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  try {
    await L.openNode(page, L.terminal('t', work, 0, 0, { width: 1300, height: 760 }))
    await L.waitFor('the shell', async () => (await L.snapshot(page, 't')).includes('$'), 20000)
    await L.sleep(800)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'setViewport', viewport: { x: 10, y: 10, zoom: 1 } }))
    await L.fitView(page)
    // Every case on its own line, then OSC 8 hyperlinks as Claude Code prints them, and a plain web link.
    const lines = [
      ...cases.map(([tag, text]) => `[${tag}] ${text}`),
      `[o1] \x1b]8;;file:///${fwd}/src/app.ts\x1b\\Open app.ts\x1b]8;;\x1b\\`,
      '[o2] \x1b]8;;https://example.com/docs?a=1&b=2\x1b\\the docs\x1b]8;;\x1b\\',
      '[w1] https://example.com/page?x=1#top',
      '[n1] just some plain words here'
    ]
    const script = path.join(work, 'print.sh')
    fs.writeFileSync(script, `clear\n${lines.map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join('\n')}\n`)
    await L.submit(page, 't', 'bash print.sh')
    await spot(page, 't', '[w1]', 'example.com')

    for (const [tag, text, hover, want] of cases) {
      const at = await spot(page, 't', `[${tag}]`, hover).catch(() => null)
      if (!at) {
        c.check(`${tag} ${text}: on screen`, false)
        continue
      }
      const { pointer, labels } = await menuAt(page, at, 'right')
      const isPathMenu = labels.includes('Copy path')
      const got = isPathMenu ? await copied(page, 'path-copy', want) : null
      if (!isPathMenu) await closeMenu(page)
      c.check(`${tag} ${text}: shows as a link, right-click offers the path menu, and copies the full path`, pointer && isPathMenu && got === want, { pointer, labels, got, want })
    }

    // A left-click on an OSC 8 file link: Patchbay's path menu, not xterm's "Do you want to navigate" confirm.
    let at = await spot(page, 't', '[o1]', 'Open app.ts')
    let r = await menuAt(page, at, 'left')
    c.check('A left-click on a hyperlinked file offers the path menu, with no confirm() popup', r.labels.includes('Copy path') && dialogs.length === 0, { r, dialogs })
    c.check('Its Copy path gives the file the link points at', (await copied(page, 'path-copy', app)) === app)

    // Right-click on a hyperlinked web link and a plain one: Open link and Copy link, and Copy gives the URL itself.
    at = await spot(page, 't', '[o2]', 'the docs')
    r = await menuAt(page, at, 'right')
    c.check('Right-click on a hyperlinked web link offers Open link and Copy link', JSON.stringify(r.labels) === '["Open link","Copy link"]', r)
    const zoom = await page.$eval('.react-flow__viewport', (el) => new DOMMatrix(getComputedStyle(el).transform).a)
    c.check(`The menu opens where the pointer is, at ${Math.round(zoom * 100)}% zoom`, r.off !== null && r.off < 30, { off: r.off, zoom })
    // The confirmation goes after a couple of seconds, so it's watched for from the click.
    await page.evaluate(() => {
      window.__notices = []
      const seen = () => {
        const t = [...document.querySelectorAll('.term-notice')].map((n) => n.textContent).join(' | ')
        if (window.__notices.at(-1) !== t) window.__notices.push(t)
      }
      window.__noticeWatch = setInterval(seen, 50)
    })
    const said = page.waitForFunction(() => /Link copied/.test(document.querySelector('.term-notice')?.textContent ?? ''), { timeout: 3000, polling: 100 }).then(() => true, () => false)
    c.check('Copy link copies the address behind the text', (await copied(page, 'link-copy', 'https://example.com/docs?a=1&b=2')) === 'https://example.com/docs?a=1&b=2')
    c.check('It says the link was copied', await said, await page.evaluate(() => window.__notices))
    const gone = await page.waitForFunction(() => !/Link copied/.test(document.querySelector('.term-notice')?.textContent ?? ''), { timeout: 5000, polling: 100 }).then(() => true, () => false)
    c.check('And the confirmation clears by itself', gone)
    if (process.env.PB_SHOTS) {
      // Measured again: the notice above the terminal moves its rows while it shows.
      await page.waitForFunction(() => !document.querySelector('.term-notice'), { timeout: 5000, polling: 100 }).catch(() => {})
      await menuAt(page, await spot(page, 't', '[o2]', 'the docs'), 'right')
      await page.screenshot({ path: path.join(process.env.PB_SHOTS, 'link-menu.png') })
      await closeMenu(page)
    }
    at = await spot(page, 't', '[w1]', 'example.com')
    r = await menuAt(page, at, 'right')
    c.check('Right-click on a plain web link offers Copy link too', r.labels.includes('Copy link') && r.pointer, r)
    c.check('And copies it whole, query and anchor included', (await copied(page, 'link-copy', 'https://example.com/page?x=1#top')) === 'https://example.com/page?x=1#top')

    // Right-click away from any link still gives the window's own menu.
    const plain = await spot(page, 't', '[n1]', 'plain words')
    await page.mouse.move(plain.x, plain.y, { steps: 3 })
    await L.sleep(300)
    await page.mouse.click(plain.x, plain.y, { button: 'right' })
    const own = await page.waitForSelector('.menu-panel', { timeout: 3000 }).then(() => page.$$eval('.menu-panel .menu-label', (ls) => ls.map((l) => l.textContent)), () => [])
    c.check("Right-click away from a link still opens the window's menu", own.length > 0 && !own.includes('Copy link') && !own.includes('Copy path'), own)
    await closeMenu(page)

    // A link in a note: right-click gives Open link and Copy link, and copies the address, not the words shown.
    await page.evaluate(() =>
      window.patchbay.dispatch({ op: 'addNode', node: { id: 'note', kind: 'sticky', title: 'Links', x: 1400, y: 0, width: 300, height: 180, parentId: null, text: 'See [the guide](https://example.com/guide?v=2) first.' } })
    )
    await L.fitView(page)
    const anchor = await page.waitForSelector('.react-flow__node[data-id="note"] .note-body a', { visible: true, timeout: 5000 }).catch(() => null)
    c.check('The note shows its link', !!anchor)
    if (anchor) {
      const box = await anchor.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    }
    const noteMenu = await page.waitForSelector('.menu-panel', { timeout: 3000 }).then(() => page.$$eval('.menu-panel .menu-label', (ls) => ls.map((l) => l.textContent)), () => [])
    c.check('Right-click on a link in a note offers Open link and Copy link', JSON.stringify(noteMenu) === '["Open link","Copy link"]', noteMenu)
    if (noteMenu.includes('Copy link')) c.check('And copies the address, not the words shown', (await copied(page, 'link-copy', 'https://example.com/guide?v=2')) === 'https://example.com/guide?v=2')

    // A path that isn't there: Copy still gives what was printed, and says it wasn't found.
    const missing = await page.evaluate(() => window.patchbay.resolveTerminalPath('t', 'src/gone.ts'))
    c.check('A missing file is reported, not guessed', missing.ok === false && /not found/i.test(missing.reason), missing)
    c.check('No confirm() or other dialogs anywhere', dialogs.length === 0, dialogs)
    c.check('No errors in the page', appRun.problems.length === 0, appRun.problems.slice(0, 3))
  } finally {
    await appRun.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
