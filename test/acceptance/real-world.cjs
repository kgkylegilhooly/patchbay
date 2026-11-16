'use strict'
// Real Claude windows given the jobs people bring to Patchbay, all on one busy canvas: test a web page and fix it,
// fix a failing test from a terminal's output, ask another agent a question, tidy the canvas, have Codex review a
// file, and sketch a plan on a whiteboard. It spends a little plan quota (and a Codex turn). PB_MODEL picks the model
// (Haiku unless set). Run: node test/acceptance/real-world.cjs [--dev]
//
// Permission prompts are answered here as a careful person would: `patchbay` commands, read-only shell commands,
// `node` scripts in the work folder, reading files, and writes inside the work folder. Every answer is listed.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const c = L.checker()
const LIMIT_MS = 14 * 60_000
const PORT = 4319

/** Every tool call an agent made, with what came back, from its transcript. */
function calls(file) {
  if (!file || !fs.existsSync(file)) return []
  const out = []
  const byId = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    for (const part of e.message?.content ?? []) {
      if (part?.type === 'tool_use' && !byId.has(part.id)) {
        const call = { tool: part.name, input: part.input?.command ?? part.input?.file_path ?? JSON.stringify(part.input ?? {}).slice(0, 200), result: '' }
        byId.set(part.id, call)
        out.push(call)
      }
      if (part?.type === 'tool_result' && byId.has(part.tool_use_id)) {
        const r = part.content
        byId.get(part.tool_use_id).result = (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 500)
      }
    }
  }
  return out
}

function lastWords(file) {
  if (!file || !fs.existsSync(file)) return ''
  const said = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      const text = (e.message?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
      if (text) said.push(text)
    } catch {}
  }
  return said.slice(-2).join('\n')
}

function decide(approval, work) {
  const text = approval.detail
  if (approval.tool === 'Bash') {
    // Pipes between safe commands are fine, as with `patchbay list | grep id`, and so is writing a file in the work
    // folder with a heredoc, as for a diagram's JSON. Patchbay shows a command with its whitespace collapsed, so a
    // heredoc arrives on one line: cat > f <<'EOF' body EOF rest. Its body is data; whatever follows is judged as usual.
    const into = /^(?:cd ("[^"]+"|\S+) && )?cat > ("[^"]+"|\S+) <<-?'?EOF'? [\s\S]*? EOF(?: (.*))?$/.exec(text)
    if (into) {
      const dir = into[1] ? into[1].replace(/"/g, '') : work
      const target = path.resolve(dir, into[2].replace(/"/g, '')).toLowerCase()
      // Inside the work folder, or a Claude session's own scratch folder.
      if (!target.startsWith(work.toLowerCase() + path.sep) && !/[\\/]temp[\\/]claude[\\/]/.test(target)) return 'deny'
      const rest = (into[3] ?? '').trim()
      return rest ? decide({ tool: 'Bash', detail: rest }, work) : 'allow'
    }
    const bare = text
      // A variable set for one command, as in B=abc patchbay browser read --node $B.
      .replace(/(^|;|&&)\s*\w+=[\w-]+\s+(?=\S)/g, '$1 ')
      .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'ARG')
      .replace(/\s2?>\s*\/dev\/null/g, '')
      .replace(/2>&1/g, '')
      .replace(/[()]/g, ' ')
      .replace(/&&|\|\||;|\|/g, ';')
    if (/`|\$\(|>|</.test(bare)) return 'deny'
    const safe = (part) =>
      /^patchbay\s/.test(part) ||
      /^(cd|ls|pwd|cat|dir|type|head|tail|wc|echo|grep|find|sleep|sort|uniq)\b/.test(part) ||
      /^node\s/.test(part) ||
      /^git (status|diff|log)\b/.test(part) ||
      /^curl\s/.test(part) ||
      /^for \w+ in [\w\s-]+$|^do\b|^done$/.test(part) ||
      /^\w+=[\w-]+$/.test(part)
    return bare.split(';').every((part) => !part.trim() || safe(part.trim())) ? 'allow' : 'deny'
  }
  if (['Read', 'Glob', 'Grep'].includes(approval.tool)) return 'allow'
  // Patchbay's own tool, as Codex calls it.
  if (approval.tool === 'mcp__patchbay__patchbay') return 'allow'
  if (['Write', 'Edit', 'MultiEdit'].includes(approval.tool)) {
    const target = path.resolve(work, text).toLowerCase()
    // Inside the work folder, or a Claude session's own scratch folder, as for a diagram's JSON.
    return target.startsWith(work.toLowerCase() + path.sep) || /[\\/]temp[\\/]claude[\\/]/.test(target) ? 'allow' : 'deny'
  }
  return 'deny'
}

/** The folders each job works in, with the files a person would already have. */
function fixtures(work) {
  const dir = (name, files) => {
    const d = path.join(work, name)
    fs.mkdirSync(d, { recursive: true })
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body)
    return d
  }
  const site = dir('todo-site', {
    'server.js': `const http = require('http')\nconst fs = require('fs')\nconst path = require('path')\nhttp.createServer((req, res) => {\n  res.setHeader('Content-Type', 'text/html')\n  res.end(fs.readFileSync(path.join(__dirname, 'index.html')))\n}).listen(${PORT}, () => console.log('To-do page on http://localhost:${PORT}'))\n`,
    'index.html': `<!doctype html>\n<title>To-do</title>\n<h1>My to-dos</h1>\n<form id="add">\n  <input id="item" placeholder="New to-do" aria-label="New to-do">\n  <button>Add</button>\n</form>\n<ul id="list"></ul>\n<script>\n  document.getElementById('add').addEventListener('submit', (e) => {\n    e.preventDefault()\n    const input = document.getElementById('itme')\n    const li = document.createElement('li')\n    li.textContent = input.value\n    document.getElementById('list').appendChild(li)\n    input.value = ''\n  })\n</script>\n`
  })
  const tests = dir('calc', {
    'calc.js': `function add(a, b) {\n  return a - b\n}\nfunction mul(a, b) {\n  return a * b\n}\nmodule.exports = { add, mul }\n`,
    'test.js': `const assert = require('assert')\nconst { add, mul } = require('./calc')\nlet failed = 0\nfor (const [name, fn] of Object.entries({\n  'add 2 + 3 = 5': () => assert.strictEqual(add(2, 3), 5),\n  'mul 4 * 5 = 20': () => assert.strictEqual(mul(4, 5), 20)\n})) {\n  try {\n    fn()\n    console.log('PASS', name)\n  } catch (e) {\n    failed++\n    console.log('FAIL', name, '-', e.message)\n  }\n}\nconsole.log(failed ? failed + ' failing' : 'all passing')\n`
  })
  const billing = dir('billing', { 'README.md': '# Billing API\n\nOwned by the Billing node.\n' })
  const review = dir('review', {
    'slugify.js': `// Turns a title into a URL slug.\nfunction slugify(title) {\n  return title.toLowerCase().replace(' ', '-')\n}\nmodule.exports = slugify\n`
  })
  const ops = dir('ops', {})
  const plan = dir('plan', {})
  return { site, tests, billing, review, ops, plan }
}

function seed(profile, work) {
  const f = fixtures(work)
  const at = (x, y) => ({ x, y, parentId: null, projectId: 'p1' })
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Real world', folder: work, viewport: { x: 0, y: 0, zoom: 0.4 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.3 },
    nodes: [],
    edges: [],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const agent = (id, title, x, y, cwd, prompt) => ({ ...at(x, y), id, kind: 'claude', title, width: 620, height: 420, cwd, sessionId: null, transcriptPath: null, after: [], prompt })
  const term = (id, title, x, y, cwd, command) => ({ ...at(x, y), id, kind: 'terminal', title, width: 480, height: 300, cwd, ...(command ? { command } : {}) })
  return {
    f,
    // In order: what's opened first, and what each agent is linked to before it starts.
    steps: [
      { node: term('tests-term', 'Tests', 700, 500, f.tests, 'node test.js') },
      { node: term('web-term', 'Web server', 1400, 1500, f.ops) },
      { node: term('api-term', 'API server', 1950, 1500, f.ops) },
      { node: term('worker-term', 'Queue worker', 2500, 1500, f.ops) },
      { node: { ...at(700, 2100), id: 'board', kind: 'whiteboard', title: 'Plan', width: 640, height: 420, shapes: [] } },
      { node: agent('owner', 'Billing API owner', 700, 1000, f.billing, 'You own the billing API in this folder. The facts other nodes may ask about: the rate limit is 120 requests per minute per API key, and clients should retry with exponential backoff starting at 1 second. Answer questions that other nodes send you. For now, just say you are ready.') },
      { node: agent('tester', 'Site check', 0, 0, f.site, `There's a small to-do page in this folder. Start it with \`node server.js\` in a terminal node on the canvas, open http://localhost:${PORT} in a browser node, try adding a to-do called "buy milk", and tell me whether it works. If it doesn't, fix the page and check again.`) },
      { node: agent('fixer', 'Test fixer', 0, 500, f.tests, 'The terminal linked to you ran the tests and one is failing. Find out why from its output, fix the code, then rerun the tests in that terminal and tell me the result.'), link: 'tests-term' },
      { node: agent('asker', 'Integrations', 0, 1000, f.billing, 'Ask the billing API owner node linked to you what the rate limit is and how clients should retry, then tell me its answer.'), link: 'owner' },
      { node: agent('tidier', 'Tidy up', 0, 1500, f.ops, 'Tidy up the canvas: put the Web server, API server and Queue worker terminals in a group called Servers, laid out in a row, and add a note in that group that says what each of them is for.') },
      { node: agent('delegator', 'Review lead', 0, 2000, f.review, 'Have a Codex agent review slugify.js in this folder for bugs, and tell me what it found. Do not change the file yourself.') },
      { node: agent('planner', 'Planner', 0, 2500, f.plan, 'On the whiteboard linked to you, sketch a plan for adding password reset to a web app: the steps from the user asking for a reset to logging in with the new password. Keep it to about six boxes.'), link: 'board' }
    ]
  }
}

async function main() {
  const exe = process.argv.includes('--dev') ? undefined : L.packagedExe
  const work = L.workDir('real-world')
  const profile = L.newProfile({ permissionMode: 'default', notifications: 'off', sound: 'off' })
  const { f, steps } = seed(profile, work)
  const env = process.env.PB_MODEL ? { ANTHROPIC_MODEL: process.env.PB_MODEL } : undefined
  const app = await L.launch({ profile, exe, env })
  const { page } = app
  const answered = []
  let stop = false
  const answering = (async () => {
    while (!stop) {
      const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
      for (const a of pending) {
        const decision = decide(a, work)
        answered.push(`${decision}  ${a.nodeId}  ${a.tool}: ${a.detail.replace(/\s+/g, ' ').slice(0, 200)}`)
        await page.evaluate((id, d) => window.patchbay.answerApproval(id, d), a.requestId, decision).catch(() => {})
      }
      await L.sleep(400)
    }
  })()
  const agents = ['owner', 'tester', 'fixer', 'asker', 'tidier', 'delegator', 'planner']
  try {
    for (const { node, link } of steps) {
      await page.evaluate(async (n, to) => {
        await window.patchbay.dispatch({ op: 'addNode', node: n })
        if (to) await window.patchbay.dispatch({ op: 'addEdge', edge: { id: `link-${n.id}`, from: n.id, to, kind: 'link' } })
        if (n.kind === 'terminal' || n.kind === 'claude') await window.patchbay.startNode(n.id)
      }, node, link)
      // The owner gets its first turn done before anyone asks it something, as it would be on a real canvas.
      if (node.id === 'owner') await L.waitFor('the owner to be ready', async () => (await L.statusOf(page, 'owner')) === 'idle', 120_000).catch(() => {})
    }
    // Codex in a folder it has never seen asks whether to trust it, which only the person can answer. Nobody answers
    // here: what matters is that the canvas says it needs the person, rather than leaving it at starting.
    // Codex asks only about a git repository it hasn't been told to trust.
    const fresh = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pb-untrusted-'))
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: fresh })
    await L.openNode(page, L.claude('untrusted', fresh, 1400, 2600, { agent: 'codex', title: 'Codex, new folder', prompt: 'Say hello.' }))
    const askedTrust = await L.waitFor('the trust question', async () => (await L.statusOf(page, 'untrusted')) === 'needs-you', 60_000).catch(() => false)
    c.check('Codex at its folder-trust question shows needs-you', askedTrust, await L.statusOf(page, 'untrusted'))
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['untrusted'], at: Date.now() }))
    fs.rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })

    const started = Date.now()
    let calm = null
    for (;;) {
      await L.sleep(4000)
      const doc = await L.doc(page)
      const ids = [...agents, ...doc.nodes.filter((n) => (n.kind === 'claude' || n.kind === 'codex') && !agents.includes(n.id)).map((n) => n.id)]
      const states = await Promise.all(ids.map((id) => L.statusOf(page, id)))
      const done = states.every((s) => s === 'idle' || s === 'exited' || s === 'needs-you' || s === undefined || s === null)
      calm = done ? (calm ?? Date.now()) : null
      if (calm && Date.now() - calm > 25_000) break
      if (Date.now() - started > LIMIT_MS) {
        console.log('NOTE  stopped at the time limit', Object.fromEntries(ids.map((id, i) => [id, states[i]])))
        break
      }
    }
    if (process.env.PB_SHOTS) {
      await L.fitView(page)
      await L.sleep(800)
      await page.screenshot({ path: path.join(process.env.PB_SHOTS, 'real-world.png') })
    }
    const doc = await L.doc(page)
    const report = {}
    const everyAgent = [...agents, ...doc.nodes.filter((n) => (n.kind === 'claude' || n.kind === 'codex') && !agents.includes(n.id)).map((n) => n.id)]
    for (const id of everyAgent) {
      const n = doc.nodes.find((x) => x.id === id)
      report[id] = { calls: calls(n?.transcriptPath), words: lastWords(n?.transcriptPath) }
      console.log(`\n=== ${id} (${n?.kind}, ${n?.title}) status=${await L.statusOf(page, id)} ===`)
      for (const k of report[id].calls) console.log(`  ${k.tool}: ${String(k.input).replace(/\s+/g, ' ').slice(0, 240)}\n    -> ${k.result.replace(/\s+/g, ' ').slice(0, 300)}`)
      console.log(`  said: ${report[id].words.replace(/\n/g, ' | ').slice(0, 900)}`)
    }
    console.log('\n=== permission answers ===')
    for (const a of answered) console.log(`  ${a}`)
    const messages = await page.evaluate(() => window.patchbay.getMessages()).catch(() => [])
    console.log('\n=== messages ===')
    for (const m of messages) console.log(`  ${m.from} -> ${m.to}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 200)}`)
    console.log('\n=== canvas ===')
    for (const n of doc.nodes) console.log(`  ${n.kind} ${n.id} "${n.title}" parent=${n.parentId ?? '-'}${n.kind === 'group' ? ` label=${n.label ?? n.title}` : ''}${n.kind === 'sticky' ? ` text=${JSON.stringify(n.text).slice(0, 200)}` : ''}${n.kind === 'browser' ? ` url=${n.url}` : ''}`)
    for (const e of doc.edges) console.log(`  edge ${e.kind} ${e.from} -> ${e.to}`)
    console.log('')

    const ran = (id, re) => report[id]?.calls.some((k) => k.tool === 'Bash' && re.test(k.input))
    const refused = (id) => (report[id]?.calls ?? []).filter((k) => k.tool === 'Bash' && /patchbay\s/.test(k.input) && /Exit code [1-9]|patchbay: /.test(k.result))

    const html = fs.readFileSync(path.join(f.site, 'index.html'), 'utf8')
    c.check('Site check opened a terminal and a browser', ran('tester', /patchbay open-terminal/) && ran('tester', /patchbay open-browser/))
    c.check('Site check used the page through the browser verbs', ran('tester', /patchbay browser (type|click)/))
    c.check('Site check fixed the page', !html.includes("'itme'"), html.match(/getElementById\('[^']*'\)/g))
    c.check('Test fixer read the terminal', ran('fixer', /patchbay read --node tests-term|patchbay read .*tests-term/))
    c.check('Test fixer fixed calc.js', /a \+ b/.test(fs.readFileSync(path.join(f.tests, 'calc.js'), 'utf8')))
    c.check('Test fixer reran the tests in the terminal', ran('fixer', /patchbay send .*tests-term/))
    c.check('Integrations asked the owner and passed on the answer', ran('asker', /patchbay send .*owner/) && /120/.test(report.asker.words), report.asker.words.slice(0, 300))
    c.check('The owner replied with patchbay send', ran('owner', /patchbay send .*asker/))
    const servers = doc.nodes.find((n) => n.kind === 'group' && /servers/i.test(n.label ?? n.title ?? ''))
    c.check('Tidy up made a Servers group with the three terminals', servers && ['web-term', 'api-term', 'worker-term'].every((id) => doc.nodes.find((n) => n.id === id)?.parentId === servers.id), servers)
    c.check('Tidy up put a note in it', servers && doc.nodes.some((n) => n.kind === 'sticky' && n.parentId === servers.id))
    c.check('Review lead opened a Codex agent', ran('delegator', /patchbay open-agent .*--agent codex/))
    c.check('Review lead passed on what Codex found', /replace|first|only|global|space/i.test(report.delegator.words), report.delegator.words.slice(0, 300))
    c.check('Review lead left the file alone', fs.readFileSync(path.join(f.review, 'slugify.js'), 'utf8').includes(".replace(' ', '-')"))
    const board = doc.nodes.find((n) => n.id === 'board')
    c.check('Planner drew on the board', ran('planner', /patchbay draw/) && board.shapes.length >= 8, board.shapes.length)
    for (const id of everyAgent) c.check(`${id}: no patchbay command was refused`, refused(id).length === 0, refused(id).map((k) => `${k.input} -> ${k.result}`))
    c.check('No permission was denied', answered.every((a) => a.startsWith('allow')), answered.filter((a) => !a.startsWith('allow')))
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    stop = true
    await answering.catch(() => {})
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
