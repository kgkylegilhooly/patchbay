'use strict'
// Screenshot scenes for pictures in the Reader, and saving a handoff as a file:
// `node screenshot.js <out.png> --scene reader-pictures --size 1600x1000` (or reader-pictures-before, handoff-saved,
// handoff-open-saved). Each scene also checks, in the page, what the picture can't show.
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

const DOC = `# Ledger switch: error rates

Error rates fell in every phase of the switch.

![Error rates by phase](shots/error-rates.png)

The same chart by absolute path: ![chart again](<CHART>)

The chart comes from the dashboard export. The vendor's own chart isn't loaded: ![vendor chart](https://example.com/chart.png)

A file that only claims to be a picture isn't shown: ![fake](shots/fake.png)

A picture outside the document's folders isn't read: ![secret](../outside/secret.png)

Mermaid blocks stay as their source:

${TICKS}mermaid
flowchart LR
  Legacy --> Compare
  Ledger --> Compare
${TICKS}
`

function seedPictures(doc) {
  const cwd = path.join(doc.projects[0].folder, 'docs')
  fs.mkdirSync(path.join(cwd, 'shots'), { recursive: true })
  fs.mkdirSync(path.join(doc.projects[0].folder, 'outside'), { recursive: true })
  const file = path.join(cwd, 'ledger-switch.md')
  fs.writeFileSync(file, DOC.replace('<CHART>', require('node:url').pathToFileURL(path.join(cwd, 'shots', 'error-rates.png')).href))
  fs.writeFileSync(path.join(cwd, 'shots', 'error-rates.png'), png(360, 150))
  fs.writeFileSync(path.join(cwd, 'shots', 'fake.png'), '<html><script>window.__pwned = 1</script></html>')
  fs.writeFileSync(path.join(doc.projects[0].folder, 'outside', 'secret.png'), png(20, 20))
  // The document's own folder is what it may show from, so the project's folder is set elsewhere for this scene.
  doc.projects[0].folder = cwd
  const planner = doc.nodes.find((n) => n.id === 'idle')
  Object.assign(planner, { title: 'Planner', x: 0, y: 0, width: 480, height: 420 })
  doc.nodes = doc.nodes.filter((n) => n.projectId !== 'p1' || n.id === 'idle')
  doc.nodes.push({ id: 'reader', kind: 'reader', title: 'Ledger switch', path: file, fromNodeId: 'idle', x: 520, y: 0, width: 1000, height: 1000, parentId: null, projectId: 'p1' })
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

/** Waits for every picture to be shown or refused, then checks them all. */
async function checkPictures(page) {
  await page.waitForFunction(
    (sel) => {
      const pics = [...document.querySelectorAll(`${sel} .reader-img-local`)]
      return pics.length === 4 && pics.every((p) => /reader-img-(shown|failed)/.test(p.className))
    },
    { timeout: 15000 },
    READER
  )
  const report = await page.evaluate((sel) => ({
    pictures: [...document.querySelectorAll(`${sel} .reader-img-local`)].map((p) => ({ cls: p.className, src: p.querySelector('img')?.getAttribute('src')?.slice(0, 22) ?? null, title: p.title })),
    remote: [...document.querySelectorAll(`${sel} a.reader-img-remote`)].map((a) => a.getAttribute('href')),
    pageImgs: [...document.querySelectorAll(`${sel} .reader-doc img`)].map((i) => i.getAttribute('src')?.slice(0, 15)),
    mermaid: [...document.querySelectorAll(`${sel} .code-lang`)].map((e) => e.textContent),
    pwned: window.__pwned ?? null
  }), READER)
  const fail = (why) => {
    throw new Error(`${why}
${JSON.stringify(report, null, 1)}`)
  }
  const [beside, absolute, fake, outside] = report.pictures
  if (report.pwned !== null) fail('Something ran')
  for (const p of [beside, absolute]) if (!/reader-img-shown/.test(p.cls) || p.src !== 'data:image/png;base64,') fail('The local pictures should show from data: URLs')
  if (!/reader-img-failed/.test(fake.cls) || !/isn't a picture/.test(fake.title)) fail('The fake picture should be refused')
  if (!/reader-img-failed/.test(outside.cls) || !/outside the folders/.test(outside.title)) fail('The picture outside the folders should be refused')
  if (report.remote.length !== 1 || report.remote[0] !== 'https://example.com/chart.png') fail('The remote picture should be a link')
  if (report.pageImgs.some((src) => !src.startsWith('data:image/'))) fail('Every picture on the page should be a data: URL')
  if (!report.mermaid.includes('Mermaid diagram (source)')) fail('A Mermaid block should stay as its source')
  console.log('reader-pictures: 2 shown from data: URLs, fake and outside refused, remote is a link, nothing ran')
}

const scenes = {
  // The same document with no checks, for a picture of a build without pictures.
  'reader-pictures-before': async (page) => {
    await hideSidebar(page)
    await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
    await sleep(1500)
  },
  'reader-pictures': async (page) => {
    await hideSidebar(page)
    await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
    await checkPictures(page)
    await sleep(400)
  }
}

// "Save as file" in the handoff editor, then "Open in Reader". The save dialog is the system's, which a scene can't
// answer, so the seed names the file through PB_SCENE_SAVE_AS (honoured only in off-screen test runs, see src/main/testPickers.ts), without .md, as a
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
  seeds: { 'reader-pictures-before': seedPictures, 'reader-pictures': seedPictures, 'handoff-saved': seedSave, 'handoff-open-saved': seedSave }
}

