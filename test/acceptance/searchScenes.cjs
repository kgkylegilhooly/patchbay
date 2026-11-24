'use strict'
// Screenshot scenes for search and handoffs: `node screenshot.js <out.png> --scene search` (or `handoff`).
// The closed conversations get real transcripts in the scene's folder, in the shapes Claude Code and Codex write.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (ms) => new Date(ms).toISOString()
const user = (text, at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text } })
const says = (text, at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const tool = (id, name, input, at) => JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id, content, at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
const codexItem = (item, at) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item } })

function seedSearch(doc) {
  const cwd = doc.projects[0].folder
  const t = Date.now() - 3 * 3600_000
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'src', 'tokenize.ts'), 'export const tokenize = (s: string) => [...s]\n')
  spawnSync('git', ['init', '-q'], { cwd })
  const parser = path.join(cwd, 'parser-review.jsonl')
  fs.writeFileSync(
    parser,
    [
      user('The parser drops emoji and other unicode characters outside the BMP. Find out why and fix it.', t),
      says('The tokenizer walks UTF-16 code units, so a surrogate pair becomes two broken tokens.', t + 60_000),
      says('I decided to iterate by code point with for...of instead of indexing the string, which keeps the public API unchanged.', t + 90_000),
      tool('e1', 'Edit', { file_path: path.join(cwd, 'src', 'tokenize.ts'), old_string: 'a', new_string: 'b' }, t + 120_000),
      tool('b1', 'Bash', { command: 'npx vitest run test/parser' }, t + 150_000),
      result('b1', 'Test Files 3 passed (3)', t + 170_000),
      tool('e2', 'Write', { file_path: path.join(cwd, 'src', 'unicode-table.ts'), content: '...' }, t + 200_000),
      says('Fixed the unicode handling in the tokenizer.\n- [ ] Regenerate the unicode table fixtures\nStill need to check the CLI output on Windows terminals.', t + 230_000),
      ''
    ].join('\n')
  )
  const site = path.join(cwd, 'landing-copy.jsonl')
  fs.writeFileSync(
    site,
    [
      codexItem({ type: 'UserMessage', content: [{ type: 'text', text: 'Rewrite the hero copy so it mentions unicode support.' }] }, t - 26 * 3600_000),
      codexItem({ type: 'AgentMessage', content: [{ type: 'Text', text: 'The hero now says: full unicode support, emoji included.' }] }, t - 26 * 3600_000 + 60_000),
      ''
    ].join('\n')
  )
  const closedA = doc.closed.find((c) => c.id === 'closed-a')
  Object.assign(closedA, { transcriptPath: parser, closedAt: t + 240_000 })
  Object.assign(doc.closed.find((c) => c.id === 'closed-b'), { transcriptPath: site, agent: 'codex' })
  Object.assign(doc.nodes.find((n) => n.id === 'note'), { text: '## Plan\n- Fix login\n- Ship the unicode fix' })
}

async function openSearch(page, query) {
  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.press('s')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await page.waitForSelector('.search-input', { timeout: 10000 })
  await page.type('.search-input', query)
  await page.waitForSelector('.search-hit', { timeout: 15000 })
  await sleep(400)
}

const scenes = {
  search: async (page) => openSearch(page, 'unicode'),
  // Opens a closed Codex conversation at the message that matched, read from the index.
  'search-source': async (page) => {
    await openSearch(page, 'emoji included')
    await page.click('.search-hit-main')
    await page.waitForSelector('.source-focus', { timeout: 15000 })
    await sleep(400)
  },
  // A conversation hit under the pointer shows Continue with another agent in place of its date (ux-review P23).
  'search-hover': async (page) => {
    await openSearch(page, 'unicode')
    await page.waitForFunction(() => document.querySelectorAll('.search-hit').length >= 3, { timeout: 15000 })
    await page.hover('.search-hit:nth-child(2) .search-hit-main')
    await sleep(400)
  },
  handoff: async (page) => {
    await openSearch(page, 'surrogate')
    await page.click('.search-continue')
    await page.waitForSelector('.handoff-section', { timeout: 15000 })
    // An edit by the person, at the end of the objective, with the top of the editor in view.
    await page.focus('#handoff-objective')
    await page.keyboard.down('Control')
    await page.keyboard.press('End')
    await page.keyboard.up('Control')
    await page.keyboard.type('\nAlso add a test with a flag emoji.')
    await page.evaluate(() => document.querySelector('.handoff-body').scrollTo(0, 0))
    await sleep(300)
  },
  // Starts the edited handoff. The scene's Claude is fake-claude.cjs, which shows the prompt it was started with.
  'handoff-start': async (page) => {
    await scenes.handoff(page)
    await page.click('.handoff .btn-solid')
    await page.waitForFunction(() => !document.querySelector('.handoff'), { timeout: 15000 })
    await page.waitForFunction(() => [...document.querySelectorAll('.react-flow__node')].some((n) => n.textContent.includes('Continue: Parser review')), { timeout: 20000 })
    await sleep(800)
  }
}

module.exports = { scenes, seeds: { search: seedSearch, 'search-source': seedSearch, 'search-hover': seedSearch, handoff: seedSearch, 'handoff-start': seedSearch } }
