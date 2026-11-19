'use strict'
// Screenshot scenes for the reader: `node screenshot.js <out.png> --scene reader` (or reader-live, reader-paper,
// reader-sent, reader-open-plan, reader-before). The plan is a real file in the scene's folder, and comments are made
// through the page the way a person makes them, so each picture also checks that path.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PLAN = `# Billing migration plan

Move every account from the legacy invoice tables to the new **ledger service** without downtime. The ledger already
runs in shadow mode; this plan makes it the source of truth.

## Goals

- [x] Ledger writes in shadow mode for two weeks
- [ ] Reads served from the ledger for all plans
- [ ] Legacy tables read-only, then archived

## Rollout

### Phase 1: dual write

Every write goes to both stores. A nightly job compares them and files an issue for any account that differs.

\`\`\`ts
export async function recordCharge(c: Charge): Promise<void> {
  await legacy.insert(c)
  await ledger.append({ account: c.accountId, cents: c.amountCents, at: c.createdAt })
}
\`\`\`

### Phase 2: switch reads

Switch reads for every customer at once, behind the \`ledger-reads\` flag, then watch error rates for a day.

| Step | Owner | Est. |
| --- | --- | --- |
| Flip flag for staff | Billing | 1 d |
| Flip flag for all | Billing | 1 d |
| Archive legacy tables | Platform | 2 d |

## Risks

> Refunds issued during the switch could be written twice.

- Proration rounding differs by up to one cent.
- The comparison job is slow on large accounts. See [the ledger notes](./ledger-notes.md).

\`\`\`mermaid
graph LR; Legacy --> Compare; Ledger --> Compare
\`\`\`
`

function writePlan(cwd) {
  const file = path.join(cwd, 'billing-plan.md')
  fs.writeFileSync(file, PLAN)
  fs.writeFileSync(path.join(cwd, 'ledger-notes.md'), '# Ledger notes\n\nAppend-only. Every entry has an idempotency key.\n')
  return file
}

/** The planner agent on the left, and its plan in a reader beside it, cabled together. */
function seedReader(doc) {
  const cwd = doc.projects[0].folder
  const file = writePlan(cwd)
  const planner = doc.nodes.find((n) => n.id === 'idle')
  Object.assign(planner, { title: 'Planner', x: 0, y: 0, width: 520, height: 420 })
  doc.nodes = doc.nodes.filter((n) => n.projectId !== 'p1' || n.id === 'idle')
  doc.nodes.push({ id: 'reader', kind: 'reader', title: 'Billing migration plan', path: file, fromNodeId: 'idle', x: 560, y: 0, width: 1080, height: 800, parentId: null, projectId: 'p1' })
  doc.edges = [{ id: 'e-reader', from: 'idle', to: 'reader', kind: 'link' }]
  doc.viewport = { x: 100, y: 40, zoom: 0.85 }
  doc.projects[0].viewport = doc.viewport
}

/** Before the reader: the same plan pasted into a note, the closest the canvas had. */
function seedBefore(doc) {
  seedReader(doc)
  doc.nodes = doc.nodes.filter((n) => n.id !== 'reader')
  doc.nodes.push({ id: 'note-plan', kind: 'sticky', title: 'Billing migration plan', text: PLAN, x: 560, y: 0, width: 1080, height: 800, parentId: null, projectId: 'p1' })
  doc.edges = []
}

/**
 * A planner with nothing open yet. It runs the fake agent in chat mode, which keeps a transcript in Claude Code's
 * format; the scene adds plan mode's ExitPlanMode call to it once the agent has started.
 */
function seedOpenPlan(doc) {
  seedReader(doc)
  doc.nodes = doc.nodes.filter((n) => n.id !== 'reader')
  doc.edges = []
  Object.assign(doc.nodes.find((n) => n.id === 'idle'), { prompt: 'idle context=12 chat' })
}

/** What Claude Code writes when plan mode ends: the plan, and the file it keeps it in under .claude/plans. */
function finishPlanMode(cwd, transcript) {
  const plans = path.join(cwd, '.claude', 'plans')
  fs.mkdirSync(plans, { recursive: true })
  const planFile = path.join(plans, 'billing-ledger-switch.md')
  fs.writeFileSync(planFile, PLAN)
  const call = { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: PLAN, planFilePath: planFile } }] } }
  fs.appendFileSync(transcript, `${JSON.stringify(call)}
`)
}

const READER = '.react-flow__node[data-id="reader"]'

/** The sessions sidebar starts open and would cover the canvas. Best taken at --size 1600x1000. */
async function hideSidebar(page) {
  await page.waitForSelector('[data-cmd="toggle-sidebar"]', { timeout: 10000 })
  if (await page.$eval('[data-cmd="toggle-sidebar"]', (b) => b.getAttribute('aria-pressed') === 'true')) await page.click('[data-cmd="toggle-sidebar"]')
  await sleep(200)
}

async function waitForReader(page) {
  await hideSidebar(page)
  await page.waitForSelector(`${READER} .reader-doc .reader-section`, { timeout: 15000 })
  await sleep(300)
}

/** Selects words on the page and comments on them through the selection bubble. */
async function commentOnWords(page, words, text) {
  const ok = await page.evaluate(
    (sel, words) => {
      const article = document.querySelector(`${sel} .reader-doc`)
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.data.indexOf(words)
        if (at < 0) continue
        window.getSelection().setBaseAndExtent(n, at, n, at + words.length)
        article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return true
      }
      return false
    },
    READER,
    words
  )
  if (!ok) throw new Error(`"${words}" isn't on the page`)
  await page.waitForSelector(`${READER} .reader-bubble`, { timeout: 3000 })
  await page.click(`${READER} .reader-bubble`)
  await page.waitForSelector(`${READER} .reader-composer textarea`, { timeout: 3000 })
  await page.type(`${READER} .reader-composer textarea`, text)
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')
  await sleep(200)
}

/** Points at a heading, and comments on it with the + that appears beside it. */
async function commentOnHeading(page, title, text) {
  const box = await page.evaluate(
    (sel, title) => {
      const h = [...document.querySelectorAll(`${sel} .reader-heading`)].find((e) => e.textContent.trim() === title)
      if (!h) return null
      // Into view inside the reader only: scrollIntoView would also move the canvas.
      const scroll = h.closest('.reader-scroll')
      scroll.scrollTop += h.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120
      const r = h.querySelector('h1,h2,h3,h4,h5,h6').getBoundingClientRect()
      return { x: r.left + 30, y: r.top + r.height / 2 }
    },
    READER,
    title
  )
  if (!box) throw new Error(`No heading "${title}"`)
  await page.mouse.move(box.x, box.y)
  await page.waitForSelector(`${READER} .reader-add`, { timeout: 3000 })
  await page.click(`${READER} .reader-add`)
  await page.waitForSelector(`${READER} .reader-composer textarea`, { timeout: 3000 })
  await page.type(`${READER} .reader-composer textarea`, text)
  await page.click(`${READER} .reader-composer .reader-primary`)
  await sleep(200)
}

async function commentOnDocument(page, text) {
  await page.click(`${READER} [data-reader-whole]`)
  await page.type(`${READER} .reader-composer textarea`, text)
  await page.click(`${READER} .reader-composer .reader-primary`)
  await sleep(200)
}

async function threeComments(page) {
  await waitForReader(page)
  await commentOnWords(page, 'every customer at once', 'Do this in batches: staff, then 5%, then everyone. A single flip is too risky for billing.')
  await commentOnHeading(page, 'Risks', 'Add a rollback step for each phase.')
  await commentOnDocument(page, 'Looks right overall. Say how long dual write runs before Phase 2.')
  const count = await page.$$eval(`${READER} .reader-card`, (cards) => cards.length)
  if (count !== 3) throw new Error(`Expected 3 comments, found ${count}`)
}

const scenes = {
  'reader-before': async (page) => {
    await hideSidebar(page)
    await sleep(600)
  },
  reader: async (page) => {
    await threeComments(page)
    // Focus the comment on the words, so its highlight shows strongest.
    await page.click(`${READER} .reader-card[data-comment-state="anchored"] .reader-c-head`)
    await sleep(500)
  },
  // The file changes on disk: the reader follows it, says so, and the comment whose words went is outdated.
  'reader-live': async (page) => {
    await threeComments(page)
    const file = await page.evaluate((sel) => document.querySelector(`${sel} .cwd`).getAttribute('title'), READER)
    fs.writeFileSync(file, PLAN.replace('Switch reads for every customer at once', 'Switch reads in three waves (staff, 5%, everyone)'))
    await page.waitForSelector(`${READER} .reader-changed-now`, { timeout: 8000 })
    await page.waitForSelector(`${READER} .reader-card[data-comment-state="outdated"]`, { timeout: 3000 })
    await sleep(300)
  },
  'reader-paper': async (page) => {
    await threeComments(page)
    await page.click(`${READER} .reader-tool[title^="A light page"]`)
    await page.click(`${READER} .reader-fold[aria-label="Collapse Phase 1: dual write"]`)
    await sleep(400)
  },
  // Sends all three to the planner, which is idle, so they go at once.
  'reader-sent': async (page) => {
    await threeComments(page)
    await page.click(`${READER} [data-reader-send]`)
    await page.waitForSelector(`${READER} .reader-result`, { timeout: 5000 })
    const said = await page.$eval(`${READER} .reader-result`, (e) => e.textContent)
    if (!/Sent to Planner|Queued for Planner/.test(said)) throw new Error(`Send said: ${said}`)
    const unsent = await page.$$eval(`${READER} .reader-c-sent`, (s) => s.filter((e) => e.textContent === 'Not sent yet').length)
    if (unsent) throw new Error(`${unsent} comments still unsent`)
    await sleep(300)
  },
  // Opens the planner's plan from its menu.
  'reader-open-plan': async (page) => {
    await hideSidebar(page)
    // The fake agent's transcript, which it made when it started: the newest one.
    const since = Date.now() - 60_000
    let transcript = null
    for (let i = 0; i < 50 && !transcript; i++) {
      const fresh = fs.readdirSync(os.tmpdir()).filter((n) => /^pb-fake-.*.jsonl$/.test(n)).map((n) => path.join(os.tmpdir(), n)).filter((p) => fs.statSync(p).mtimeMs >= since)
      transcript = fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
      if (!transcript) await sleep(200)
    }
    if (!transcript) throw new Error("The planner didn't start")
    await sleep(500)
    const cwd = await page.evaluate(() => document.querySelector('.react-flow__node[data-id="idle"] .cwd')?.getAttribute('title') || '')
    finishPlanMode(cwd || os.tmpdir(), transcript)
    await page.waitForSelector('.react-flow__node[data-id="idle"] .unit-head', { timeout: 10000 })
    await sleep(500)
    const head = await page.$('.react-flow__node[data-id="idle"] .unit-head .title')
    const box = await head.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await page.waitForSelector('.menu-panel [data-cmd="open-plan"]', { timeout: 3000 })
    await page.click('.menu-panel [data-cmd="open-plan"]')
    await page.waitForSelector('.react-flow__node-reader .reader-doc .reader-section, .reader-notice', { timeout: 10000 })
    const notice = await page.$eval('.reader-notice', (e) => e.textContent).catch(() => null)
    if (notice) throw new Error(`Open plan said: ${notice}`)
    await sleep(900)
  }
}

const seeds = {
  reader: seedReader,
  'reader-live': seedReader,
  'reader-paper': seedReader,
  'reader-sent': seedReader,
  'reader-before': seedBefore,
  'reader-open-plan': seedOpenPlan
}

module.exports = { scenes, seeds }
