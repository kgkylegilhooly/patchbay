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

const COMPOSER = `${READER} .reader-composer textarea`

/**
 * Opens the comment box with `open`, trying again if it didn't open. The reader moves under the pointer as panels
 * open and as it scrolls, and scrolling hides the + on purpose, so one attempt can miss. Waits are on what the page
 * shows, never on fixed times alone.
 */
async function openComposer(page, what, open) {
  let last
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await open()
      await page.waitForSelector(COMPOSER, { timeout: 1500 })
      return
    } catch (e) {
      last = e
      await sleep(250)
    }
  }
  throw new Error(`The comment box didn't open for ${what}: ${last && last.message}`)
}

/** Types a comment into the open box and saves it, then waits until the box has closed. */
async function saveComment(page, text, how) {
  await page.type(COMPOSER, text)
  if (how === 'keys') {
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
  } else {
    await page.click(`${READER} .reader-composer .reader-primary`)
  }
  await page.waitForSelector(COMPOSER, { hidden: true, timeout: 3000 })
}

/** Selects words on the page and comments on them through the selection bubble. */
async function commentOnWords(page, words, text) {
  await openComposer(page, `"${words}"`, async () => {
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
    await page.waitForSelector(`${READER} .reader-bubble`, { timeout: 2000 })
    await page.click(`${READER} .reader-bubble`)
  })
  await saveComment(page, text, 'keys')
}

/** Points at a heading, and comments on it with the + that appears beside it. */
async function commentOnHeading(page, title, text) {
  await openComposer(page, `heading "${title}"`, async () => {
    const found = await page.evaluate(
      (sel, title) => {
        const h = [...document.querySelectorAll(`${sel} .reader-heading`)].find((e) => e.textContent.trim() === title)
        if (!h) return false
        // Into view inside the reader only: scrollIntoView would also move the canvas.
        const scroll = h.closest('.reader-scroll')
        scroll.scrollTop += h.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 120
        return true
      },
      READER,
      title
    )
    if (!found) throw new Error(`No heading "${title}"`)
    // The scroll's own event comes after this, and hides the +; let it pass before pointing.
    await sleep(250)
    const box = await page.evaluate(
      (sel, title) => {
        const h = [...document.querySelectorAll(`${sel} .reader-heading`)].find((e) => e.textContent.trim() === title)
        const r = h.querySelector('h1,h2,h3,h4,h5,h6').getBoundingClientRect()
        return { x: r.left + 30, y: r.top + r.height / 2 }
      },
      READER,
      title
    )
    // From off the heading, so the reader sees the pointer arrive.
    await page.mouse.move(box.x, box.y - 40)
    await page.mouse.move(box.x, box.y)
    await page.waitForSelector(`${READER} .reader-add`, { timeout: 2000 })
    await page.click(`${READER} .reader-add`)
  })
  await saveComment(page, text, 'button')
}

async function commentOnDocument(page, text) {
  await openComposer(page, 'the whole document', () => page.click(`${READER} [data-reader-whole]`))
  await saveComment(page, text, 'button')
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
    // What the agent received, byte for byte, once any second Enter has gone too. The fake's own screen echoes
    // input on top of the console's, so its terminal shows a message twice; the bytes are what count.
    // A planner still starting gets it once it's idle, so wait for the paste to arrive, then for any second Enter.
    const log = () => (fs.existsSync(process.env.FAKE_INPUT_LOG) ? fs.readFileSync(process.env.FAKE_INPUT_LOG, 'utf8') : '')
    for (let i = 0; i < 75 && !log().includes('\x1b[201~'); i++) await sleep(200)
    await sleep(2500)
    const got = log()
    const pastes = got.split('\x1b[200~').length - 1
    if (pastes !== 1) throw new Error(`The agent got ${pastes} pastes: ${JSON.stringify(got)}`)
    if ((got.match(/Comments on "/g) ?? []).length !== 1) throw new Error(`The message arrived more than once: ${JSON.stringify(got)}`)
    for (const line of ['\n\n1. On the whole document:\n   Looks right', '\n2. In "Billing migration plan > Rollout > Phase 2: switch reads", on: "every customer at once"\n   Do this', '\n3. In "Billing migration plan > Risks"']) {
      if (!got.includes(line)) throw new Error(`Line breaks were lost; missing ${JSON.stringify(line)} in ${JSON.stringify(got)}`)
    }
    console.log(`reader-sent: one paste of ${got.length} bytes, line breaks intact`)
    await sleep(300)
  },
  // Opens the planner's plan from its menu.
  'reader-open-plan': async (page) => {
    await hideSidebar(page)
    // The fake agent's transcript, which it made when it started: the newest one.
    const since = Date.now() - 60_000
    let transcript = null
    for (let i = 0; i < 50 && !transcript; i++) {
      const fresh = fs.readdirSync(os.tmpdir()).filter((n) => /^pb-fake-.*\.jsonl$/.test(n)).map((n) => path.join(os.tmpdir(), n)).filter((p) => fs.statSync(p).mtimeMs >= since)
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
  // The fake agent logs every byte typed into it there. Set before the app starts, so its sessions inherit it.
  'reader-sent': (doc) => {
    seedReader(doc)
    doc.nodes.find((n) => n.id === 'idle').prompt = 'idle context=12 paste'
    process.env.FAKE_INPUT_LOG = path.join(doc.projects[0].folder, 'planner-input.log')
  },
  'reader-before': seedBefore,
  'reader-open-plan': seedOpenPlan
}

module.exports = { scenes, seeds }
