'use strict'
// Screenshot scenes for Mermaid diagrams and pictures in the Reader, and saving a handoff as a file:
// `node screenshot.js <out.png> --scene reader-diagrams --size 1600x1000` (or reader-diagrams-paper, handoff-saved).
// Each scene also checks, in the page, what the picture can't show: that nothing hostile ran or loaded.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TICKS = '```'

/** A small PNG, drawn here so the scene needs no picture files: a blue-to-green chart with three bars. */
function png(width, height) {
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const bar = [0.25, 0.55, 0.85].findIndex((c) => Math.abs(x / width - c) < 0.08)
      const tall = [0.45, 0.7, 0.3][bar]
      const on = bar >= 0 && y / height > 1 - tall
      const px = on ? [80 + bar * 50, 160, 230 - bar * 40] : [30 + (x * 20) / width, 34, 40 + (y * 20) / height]
      row.set(px.map(Math.round), 1 + x * 3)
    }
    rows.push(row)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

const DOC = `# Ledger switch: how it fits together

The ledger takes over from the legacy invoice tables in two steps.

${TICKS}mermaid
flowchart LR
  App[Billing API] -->|writes| Legacy[(Legacy tables)]
  App -->|writes| Ledger[(Ledger)]
  Legacy --> Compare{{Nightly compare}}
  Ledger --> Compare
  Compare -->|differs| Issue[File an issue]
${TICKS}

## Read path

${TICKS}mermaid
sequenceDiagram
  participant C as Client
  participant A as Billing API
  participant L as Ledger
  C->>A: GET /invoices
  A->>L: read(account)
  L-->>A: entries
  A-->>C: invoices
${TICKS}

## Last week's error rates

![Error rates by phase](shots/error-rates.png)

The chart comes from the dashboard export. The vendor's own chart isn't loaded: ![vendor chart](https://example.com/chart.png)

## Not drawn

A diagram that doesn't parse shows its source and why:

${TICKS}mermaid
flowchart LR
  A -->
  B -->> -- C
${TICKS}

${TICKS}mermaid
flowchart LR
  X["<img src=x onerror=window.__pwned=1>Safe label"] --> Y
  click X "javascript:window.__pwned=2"
  click Y call window.__pwned(3)
${TICKS}

A picture outside the document's folders isn't read: ![secret](../outside/secret.png)
`

function seedDiagrams(doc) {
  const cwd = path.join(doc.projects[0].folder, 'docs')
  fs.mkdirSync(path.join(cwd, 'shots'), { recursive: true })
  fs.mkdirSync(path.join(doc.projects[0].folder, 'outside'), { recursive: true })
  const file = path.join(cwd, 'ledger-switch.md')
  fs.writeFileSync(file, DOC)
  fs.writeFileSync(path.join(cwd, 'shots', 'error-rates.png'), png(360, 150))
  fs.writeFileSync(path.join(doc.projects[0].folder, 'outside', 'secret.png'), png(20, 20))
  // The document's own folder is what it may show from, so the project's folder is set elsewhere for this scene.
  doc.projects[0].folder = cwd
  const planner = doc.nodes.find((n) => n.id === 'idle')
  Object.assign(planner, { title: 'Planner', x: 0, y: 0, width: 480, height: 420 })
  doc.nodes = doc.nodes.filter((n) => n.projectId !== 'p1' || n.id === 'idle')
  doc.nodes.push({ id: 'reader', kind: 'reader', title: 'Ledger switch', path: file, fromNodeId: 'idle', x: 520, y: 0, width: 1000, height: 1060, parentId: null, projectId: 'p1' })
  doc.edges = [{ id: 'e-reader', from: 'idle', to: 'reader', kind: 'link' }]
  doc.viewport = { x: 60, y: 20, zoom: 0.88 }
  doc.projects[0].viewport = doc.viewport
}

const READER = '.react-flow__node[data-id="reader"]'

async function hideSidebar(page) {
  await page.waitForSelector('[data-cmd="toggle-sidebar"]', { timeout: 10000 })
  if (await page.$eval('[data-cmd="toggle-sidebar"]', (b) => b.getAttribute('aria-pressed') === 'true')) await page.click('[data-cmd="toggle-sidebar"]')
  await sleep(200)
}

/** Waits for every diagram to be drawn or refused, and every picture shown or refused, then checks them all. */
async function checkDiagrams(page, theme) {
  await page.waitForFunction(
    (sel, theme) => {
      const blocks = [...document.querySelectorAll(`${sel} .code-mermaid`)]
      const pics = [...document.querySelectorAll(`${sel} .reader-img-local`)]
      return blocks.length === 4 && blocks.every((b) => b.dataset.drawn === theme || b.classList.contains('reader-mermaid-failed')) && pics.length === 2 && pics.every((p) => /reader-img-(shown|failed)/.test(p.className))
    },
    { timeout: 30000 },
    READER,
    theme
  )
  const report = await page.evaluate((sel) => {
    const blocks = [...document.querySelectorAll(`${sel} .code-mermaid`)]
    const svgs = blocks.map((b) => b.querySelector('.reader-mermaid img')?.getAttribute('src') ?? null)
    return {
      drawn: blocks.map((b) => b.classList.contains('reader-mermaid-drawn')),
      errors: blocks.map((b) => b.querySelector('.reader-mermaid-error')?.textContent ?? null),
      svg: svgs.map((s) => (s ? decodeURIComponent(s.replace(/^data:image\/svg\+xml;charset=utf-8,/, '')) : null)),
      pwned: window.__pwned ?? null,
      pictures: [...document.querySelectorAll(`${sel} .reader-img-local`)].map((p) => ({ cls: p.className, src: p.querySelector('img')?.getAttribute('src')?.slice(0, 22) ?? null, title: p.title })),
      remote: [...document.querySelectorAll(`${sel} a.reader-img-remote`)].map((a) => a.getAttribute('href')),
      pageImgs: [...document.querySelectorAll(`${sel} .reader-doc img`)].map((i) => i.getAttribute('src')?.slice(0, 15)),
      loose: document.querySelectorAll('body > [id^="dreader-mermaid"], body > [id^="reader-mermaid"]').length
    }
  }, READER)
  const fail = (why) => {
    const short = { ...report, svg: report.svg.map((v) => v && v.replace(/<style>[\s\S]*?<\/style>/, '').slice(0, 1500)) }
    throw new Error(`${why}\n${JSON.stringify(short, null, 1)}`)
  }
  if (report.pwned !== null) fail('Something in a diagram ran')
  if (!report.drawn[0] || !report.drawn[1]) fail('The flowchart and the sequence diagram should be drawn')
  if (report.drawn[2] || !report.errors[2]) fail('The broken diagram should show its source and an error')
  for (const svg of report.svg.filter(Boolean)) {
    if (/<script|<foreignObject|onerror|onload|javascript:|<a[\s>]|<image|href=|url\((?!#)/i.test(svg)) fail('A drawn diagram kept something it should not')
  }
  const words = (svg) => (svg ?? '').replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  if (!/Safe label/.test(words(report.svg[3]))) fail(`The hostile diagram lost its label text: ${words(report.svg[3])} / ${words(report.svg[0])}`)
  if (!/reader-img-shown/.test(report.pictures[0].cls) || report.pictures[0].src !== 'data:image/png;base64,') fail('The local picture should show from a data: URL')
  if (!/reader-img-failed/.test(report.pictures[1].cls) || !/outside the folders/.test(report.pictures[1].title)) fail('The picture outside the folders should be refused')
  if (report.remote.length !== 1 || report.remote[0] !== 'https://example.com/chart.png') fail('The remote picture should be a link')
  if (report.pageImgs.some((s) => !s.startsWith('data:image/'))) fail('Every picture on the page should be a data: URL')
  if (report.loose) fail('Mermaid left elements behind')
  console.log(`reader-diagrams (${theme}): ${report.drawn.filter(Boolean).length} drawn, 1 refused with its error, pictures and remote link as expected, nothing ran`)
}

const scenes = {
  // The same document with no checks, for a picture of a build without diagrams or pictures.
  'reader-diagrams-before': async (page) => {
    await hideSidebar(page)
    await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
    await sleep(1500)
  },
  'reader-diagrams': async (page) => {
    await hideSidebar(page)
    await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
    await checkDiagrams(page, 'dark')
    await sleep(400)
  },
  'reader-diagrams-paper': async (page) => {
    await hideSidebar(page)
    await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
    await checkDiagrams(page, 'dark')
    await page.click(`${READER} .reader-tool[title^="A light page"]`)
    await checkDiagrams(page, 'light')
    // Scrolled to the pictures and the diagrams that weren't drawn.
    await page.evaluate((sel) => {
      const scroll = document.querySelector(`${sel} .reader-scroll`)
      const h = [...scroll.querySelectorAll('.reader-heading')].find((e) => e.textContent.includes('Last week'))
      scroll.scrollTop += h.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10
    }, READER)
    await sleep(500)
  }
}

// "Save as file" in the handoff editor, then "Open in Reader". The save dialog is the system's, which a scene can't
// answer, so the seed names the file through PB_SCENE_SAVE_AS (honoured only when not installed), without .md, as a
// person might type it. Main still checks the path, adds .md and writes the file.
const searchScenes = require('./searchScenes.cjs')

async function saveHandoff(page) {
  await searchScenes.scenes.handoff(page)
  await page.click('.handoff-actions .btn[title^="Save the handoff"]')
  await page.waitForSelector('.handoff-saved', { timeout: 5000 })
  const said = await page.$eval('.handoff-saved', (e) => e.textContent)
  const file = `${process.env.PB_SCENE_SAVE_AS}.md`
  if (!said.includes('Saved to') || !said.includes(file)) throw new Error(`The editor said: ${said}`)
  const text = fs.readFileSync(file, 'utf8')
  if (!text.startsWith('# Handoff: Parser review') || !text.includes('Also add a test with a flag emoji.')) throw new Error(`The saved file holds: ${text.slice(0, 300)}`)
  console.log(`handoff saved: ${file}, ${text.length} characters, with the person's edit`)
  return file
}

scenes['handoff-saved'] = async (page) => {
  await saveHandoff(page)
  await sleep(300)
}

scenes['handoff-open-saved'] = async (page) => {
  const file = await saveHandoff(page)
  await page.click('.handoff-saved .btn')
  await page.waitForFunction(() => !document.querySelector('.handoff'), { timeout: 5000 })
  await page.waitForSelector('.react-flow__node-reader .reader-doc .reader-section', { timeout: 10000 })
  const shown = await page.$eval('.react-flow__node-reader .cwd', (e) => e.getAttribute('title'))
  if (path.resolve(shown) !== path.resolve(file)) throw new Error(`The reader opened ${shown}, not ${file}`)
  await sleep(900)
}

const seedSave = (doc) => {
  searchScenes.seeds.handoff(doc)
  process.env.PB_SCENE_SAVE_AS = path.join(doc.projects[0].folder, 'handoff-parser-review')
}

module.exports = {
  scenes,
  seeds: { 'reader-diagrams-before': seedDiagrams, 'reader-diagrams': seedDiagrams, 'reader-diagrams-paper': seedDiagrams, 'handoff-saved': seedSave, 'handoff-open-saved': seedSave }
}

