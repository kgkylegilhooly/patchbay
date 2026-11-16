'use strict'
// Real Claude windows given everyday Patchbay tasks, to see how they use the skill: what they run, what's refused,
// what they retry, and whether they get the task right. It spends a little plan quota. PB_MODEL picks the model
// (Haiku unless set). Run: node test/acceptance/skill-real.cjs [--dev]
//
// Permission prompts are answered here, narrowly, as in team-real.cjs, and every answer is listed: plain `patchbay`
// commands, read-only shell commands, reading files, and writes inside the work folder.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const c = L.checker()
const LIMIT_MS = 10 * 60_000

/** Every tool call an agent made, with what came back, from its transcript. */
function calls(file) {
  if (!file || !fs.existsSync(file)) return []
  const out = []
  // Claude Code can write the same tool call more than once, so each is kept once, by its id.
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
        byId.get(part.tool_use_id).result = (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 400)
      }
    }
  }
  return out
}

/** The agent's last two messages, whole. A message's later lines are part of it, not separate entries. */
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

function decide(approval, roots) {
  const text = approval.detail
  if (approval.tool === 'Bash') {
    const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'ARG').replace(/\s2?>\s*\/dev\/null/g, '').replace(/&&|\|\|/g, ';')
    if (/`|\$\(|>|<|\|/.test(bare)) return 'deny'
    const safe = (part) => /^patchbay\s/.test(part) || /^(ls|pwd|cat|dir|type|head|wc|echo)\b/.test(part)
    return bare.split(';').every((part) => safe(part.trim())) ? 'allow' : 'deny'
  }
  if (approval.tool === 'Read') return 'allow'
  if (['Write', 'Edit', 'MultiEdit'].includes(approval.tool)) {
    const target = path.resolve(roots.work, text).toLowerCase()
    return target.startsWith(roots.work.toLowerCase() + path.sep) ? 'allow' : 'deny'
  }
  return 'deny'
}

function seed(profile, work) {
  const at = (x, y) => ({ x, y, parentId: null, projectId: 'p1' })
  const agent = (id, title, x, y, prompt) => ({ ...at(x, y), id, kind: 'claude', title, width: 620, height: 420, cwd: work, sessionId: null, transcriptPath: null, after: [], prompt })
  const ink = '#1f1f22'
  const box = (x, label) => [
    { type: 'rect', color: ink, size: 4, x1: x, y1: 120, x2: x + 130, y2: 190 },
    { type: 'text', color: ink, size: 4, x: x + 20, y: 140, text: label }
  ]
  const sketch = [
    { type: 'text', color: '#2f6fd6', size: 8, x: 36, y: 30, text: 'Login flow' },
    ...box(40, 'Browser'),
    ...box(270, 'API'),
    ...box(500, 'Auth'),
    { type: 'arrow', color: ink, size: 4, x1: 176, y1: 155, x2: 262, y2: 155 },
    { type: 'arrow', color: ink, size: 4, x1: 406, y1: 155, x2: 492, y2: 155 },
    { type: 'ellipse', color: '#d64545', size: 4, x1: 480, y1: 100, x2: 650, y2: 210 },
    { type: 'text', color: '#d64545', size: 2, x: 470, y: 222, text: 'session token lost on redirect' }
  ]
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Skill tour', folder: work, viewport: { x: 0, y: 0, zoom: 0.5 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.4 },
    nodes: [
      { ...at(700, 0), id: 'sketch', kind: 'whiteboard', title: 'Login sketch', width: 720, height: 420, shapes: sketch },
      { ...at(700, 500), id: 'plan', kind: 'whiteboard', title: 'Architecture', width: 640, height: 460, shapes: [] },
      { ...at(700, 1000), id: 'team', kind: 'sticky', title: 'Team board', width: 300, height: 220, text: "## Who's on what\n- Lead: planning\n- Docs: README" }
    ],
    edges: [],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  // The agents are added once the app is open, each linked before it starts, as the person would wire them up.
  return [
    { node: agent('viewer', 'Viewer', 0, 0, 'Look at the whiteboard I linked to you. What problem is it pointing at? Answer in two sentences.'), link: 'sketch' },
    { node: agent('drawer', 'Drawer', 0, 500, 'On the whiteboard linked to you, sketch how a request flows through a typical three-tier web app: browser, web server, app server, database. Then say you are done.'), link: 'plan' },
    { node: agent('noter', 'Parser tests', 0, 1000, 'Add yourself to the team note linked to you: you are taking the parser tests. Do not change anything else in it.'), link: 'team' },
    { node: agent('asker', 'Newcomer', 0, 1500, 'Which node are you on the Patchbay canvas, and what can you reach? Answer in a few lines.'), link: null }
  ]
}

async function main() {
  const exe = process.argv.includes('--dev') ? undefined : L.packagedExe
  const work = L.workDir('skill-real')
  const profile = L.newProfile({ permissionMode: 'default', notifications: 'off', sound: 'off' })
  const wiring = seed(profile, work)
  const env = process.env.PB_MODEL ? { ANTHROPIC_MODEL: process.env.PB_MODEL } : undefined
  const app = await L.launch({ profile, exe, env })
  const { page } = app
  const answered = []
  let stop = false
  const answering = (async () => {
    while (!stop) {
      const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
      for (const a of pending) {
        const decision = decide(a, { work, profile })
        answered.push(`${decision}  ${a.nodeId}  ${a.tool}: ${a.detail.slice(0, 160)}`)
        await page.evaluate((id, d) => window.patchbay.answerApproval(id, d), a.requestId, decision).catch(() => {})
      }
      await L.sleep(400)
    }
  })()
  const agents = ['viewer', 'drawer', 'noter', 'asker']
  try {
    for (const { node, link } of wiring) {
      await page.evaluate(async (n, to) => {
        await window.patchbay.dispatch({ op: 'addNode', node: n })
        if (to) await window.patchbay.dispatch({ op: 'addEdge', edge: { id: `link-${n.id}`, from: n.id, to, kind: 'link' } })
        await window.patchbay.startNode(n.id)
      }, node, link)
    }
    const started = Date.now()
    let calm = null
    for (;;) {
      await L.sleep(3000)
      const states = await Promise.all(agents.map((id) => L.statusOf(page, id)))
      const done = states.every((s) => s === 'idle' || s === 'exited')
      calm = done ? (calm ?? Date.now()) : null
      if (calm && Date.now() - calm > 15_000) break
      if (Date.now() - started > LIMIT_MS) {
        console.log('NOTE  stopped at the time limit', states)
        break
      }
    }
    const doc = await L.doc(page)
    const report = {}
    for (const id of agents) {
      const n = doc.nodes.find((x) => x.id === id)
      report[id] = { calls: calls(n?.transcriptPath), words: lastWords(n?.transcriptPath), transcript: n?.transcriptPath }
      console.log(`\n=== ${id} ===`)
      for (const k of report[id].calls) console.log(`  ${k.tool}: ${String(k.input).replace(/\s+/g, ' ').slice(0, 200)}\n    -> ${k.result.replace(/\s+/g, ' ').slice(0, 220)}`)
      console.log(`  said: ${report[id].words.replace(/\n/g, ' | ').slice(0, 600)}`)
    }
    console.log('\n=== permission answers ===')
    for (const a of answered) console.log(`  ${a}`)
    console.log('')

    const ran = (id, re) => report[id].calls.some((k) => k.tool === 'Bash' && re.test(k.input))
    const refusedPatchbay = (id) => report[id].calls.filter((k) => k.tool === 'Bash' && /^patchbay/.test(k.input) && /Exit code [1-9]|patchbay: /.test(k.result))
    const viewerRead = report.viewer.calls.some((k) => k.tool === 'Read' && /\.png$/i.test(k.input))
    c.check('Viewer exported the board with patchbay whiteboard', ran('viewer', /^patchbay whiteboard\s/))
    c.check('Viewer looked at the picture it saved', viewerRead)
    c.check('Viewer saw the problem: the token lost on redirect', /token|redirect/i.test(report.viewer.words), report.viewer.words.slice(0, 300))
    const plan = doc.nodes.find((n) => n.id === 'plan')
    c.check('Drawer drew on its board with patchbay draw', ran('drawer', /^patchbay draw\s/) && plan.shapes.length >= 8, plan.shapes.length)
    c.check('Drawer\'s boxes are the four tiers', ['browser', 'web', 'app', 'data'].every((w) => plan.shapes.some((s) => s.type === 'text' && s.text.toLowerCase().includes(w))), plan.shapes.filter((s) => s.type === 'text').map((s) => s.text))
    const team = doc.nodes.find((n) => n.id === 'team')
    c.check('Note-taker added a line with note --append', ran('noter', /^patchbay note\s.*--append/), report.noter.calls.filter((k) => /patchbay note/.test(k.input)).map((k) => k.input))
    c.check('The note kept what was there and gained the new line', team.text.startsWith("## Who's on what\n- Lead: planning\n- Docs: README") && /parser/i.test(team.text), team.text)
    c.check('Newcomer answered with its node and what it can reach', /Newcomer|asker/.test(report.asker.words) && /nothing|no other|none|can't reach|cannot reach|not linked/i.test(report.asker.words), report.asker.words.slice(0, 300))
    for (const id of agents) c.check(`${id}: no patchbay command was refused`, refusedPatchbay(id).length === 0, refusedPatchbay(id).map((k) => `${k.input} -> ${k.result}`))
    c.check('No permission was denied', answered.every((a) => a.startsWith('allow')), answered.filter((a) => !a.startsWith('allow')))
    // Patchbay's own settings let agents read its skill and exports and run the looking verbs without asking.
    const askedNeedlessly = answered.filter((a) => /Read: .*(skill|whiteboards|browser-shots)/i.test(a) || /Bash: patchbay (whoami|list|read|wait|whiteboard|issues|prs|guide)\b[^;&|]*$/.test(a))
    c.check('Reading the skill, exports, and looking verbs needed no permission prompt', askedNeedlessly.length === 0, askedNeedlessly)
    if (process.env.PB_SHOTS) {
      await L.fitView(page)
      await L.sleep(500)
      const plan = await page.$('.react-flow__node[data-id="plan"]')
      if (plan) await plan.screenshot({ path: path.join(process.env.PB_SHOTS, 'drawer-board.png') })
    }
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
