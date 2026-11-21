'use strict'
// One small real workflow run with a Codex step, through to its deliverable: implement (Codex) -> `node test.js` (the
// deliverable task's check) -> the person accepts it in the review inbox, by its button. Spends a little Codex quota
// (smallest model, low reasoning; PB_CODEX_MODEL overrides), none of Claude's.
// Codex runs with a temporary CODEX_HOME holding a copy of the owner's sign-in, so their ~/.codex is never written.
// Throwaway profile; off-screen window; every node it made is closed at the end, and its worktree removed.
// Run: node test/acceptance/workflow-codex-real.cjs   (needs the dev build in out/)
//
// Codex's questions are answered as a careful person would: Patchbay's own tool, read-only and `node` commands, and
// writes inside the run's folder. Every answer is listed.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const L = require('./lib.cjs')

const c = L.checker()
const MODEL = process.env.PB_CODEX_MODEL || 'gpt-6-luna'
const LIMIT_MS = 10 * 60_000

function codexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-home-'))
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(home, 'auth.json'))
  fs.writeFileSync(path.join(home, 'config.toml'), `model = ${JSON.stringify(MODEL)}\nmodel_reasoning_effort = "low"\n`)
  return home
}

function decide(a, folders) {
  const text = String(a.detail ?? a.summary ?? '')
  if (a.tool === 'mcp__patchbay__patchbay') return 'allow'
  const inside = (p) => folders.some((f) => path.resolve(f, p).toLowerCase().startsWith(f.toLowerCase()))
  if (/apply_patch|Write|Edit/i.test(a.tool)) return inside(text) ? 'allow' : 'deny'
  const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'ARG').replace(/&&|\|\||;|\|/g, ';')
  const safe = (p) => /^(cd|node|ls|pwd|cat|type|head|tail|wc|echo|grep|find|dir|Get-Content|Get-ChildItem|Get-Location|rg)\b/i.test(p) || /^git (status|diff|log)\b/.test(p)
  return bare.split(';').every((p) => !p.trim() || safe(p.trim())) ? 'allow' : 'deny'
}

function seed(work) {
  fs.writeFileSync(path.join(work, 'calc.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
  fs.writeFileSync(path.join(work, 'test.js'), "const assert = require('assert')\nconst { add } = require('./calc')\nassert.strictEqual(add(2, 3), 5)\nconsole.log('all passing')\n")
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', ...args], { stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'Start')
}

const WORKFLOW = {
  schema: 1,
  name: 'Codex fix',
  inputs: [{ key: 'brief', label: 'Brief', type: 'text' }],
  steps: [
    {
      kind: 'agent', key: 'build', title: 'Implement', agent: 'codex',
      prompt: 'In this folder: {{in:brief}}. Change only calc.js, minimally. Check it with: node test.js',
      outputs: [{ key: 'summary', label: 'What changed', type: 'text' }]
    },
    { kind: 'command', key: 'tests', title: 'Tests', run: ['node', 'test.js'], taskCheck: true }
  ],
  deliverable: { criteria: ['node test.js passes'] }
}

async function main() {
  const home = codexHome()
  const work = L.workDir('workflow-codex-real')
  seed(work)
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3, projects: [{ id: 'p1', name: 'Smoke', folder: work, viewport: { x: 0, y: 0, zoom: 0.6 } }], activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.6 }, nodes: [], edges: [], closed: []
  }))
  const app = await L.launch({ profile, env: { CODEX_HOME: home } })
  const { page } = app
  const folders = [work]
  const answered = []
  let stop = false
  const setupDone = new Set()
  const answering = (async () => {
    while (!stop) {
      const doc = await L.doc(page).catch(() => ({ nodes: [] }))
      for (const n of doc.nodes.filter((x) => x.kind === 'claude' && x.agent === 'codex')) {
        // A new CODEX_HOME asks about its sandbox and new hooks once, and each new folder whether to trust it.
        const s = (await L.screen(page, n.id).catch(() => [])).join('\n')
        if (/Trust this folder\?|Do you trust the contents/.test(s)) {
          answered.push(`trust  ${n.id}: the run's own worktree`)
          await L.input(page, n.id, '\r')
          await L.sleep(1500)
        } else if (/Trust all and continue|non-admin sandbox/.test(s) && !setupDone.has(s.slice(-200))) {
          setupDone.add(s.slice(-200))
          answered.push(`setup  ${n.id}: trust Patchbay's hooks / sandbox`)
          await L.input(page, n.id, '2')
          await L.sleep(300)
          await L.input(page, n.id, '\r')
          await L.sleep(1500)
        }
      }
      const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
      for (const a of pending) {
        const d = decide(a, folders)
        answered.push(`${d}  ${a.tool}: ${String(a.detail ?? a.summary).replace(/\s+/g, ' ').slice(0, 160)}`)
        await page.evaluate((id, x) => window.patchbay.answerApproval(id, x), a.requestId, d).catch(() => {})
      }
      await L.sleep(500)
    }
  })()
  const runOf = (id) => page.evaluate(async (r) => (await window.patchbayWorkflows.runs('p1')).find((x) => x.id === r), id)
  const current = (run, step) => run.attempts.filter((a) => a.step === step).sort((a, b) => b.n - a.n)[0]
  let runId = null
  try {
    const saved = await page.evaluate((wf) => window.patchbayWorkflows.save({ projectId: 'p1', workflow: wf, where: 'personal', overwrite: true }), WORKFLOW)
    c.check('the workflow saves with no issues', saved.ok && saved.issues.length === 0, saved.ok ? saved.issues : saved.reason)
    const started = await page.evaluate(() => window.patchbayWorkflows.start({ projectId: 'p1', ref: 'personal:Codex fix', inputs: { brief: 'make test.js pass' }, at: { x: 0, y: 0 } }))
    c.check('it starts', started.ok, started.ok ? undefined : started.reason)
    if (!started.ok) return
    runId = started.runId
    let run = await runOf(runId)
    folders.push(run.cwd)
    c.check('the run has its own worktree and a deliverable task', !!run.worktree && run.cwd !== work && !!run.taskId, { worktree: run.worktree, taskId: run.taskId })

    run = await L.waitFor('the run to end', async () => {
      const r = await runOf(runId)
      return ['succeeded', 'failed', 'needs-attention', 'stopped'].includes(r.state) ? r : null
    }, LIMIT_MS, 2000).catch(async (e) => {
      console.log(e.message)
      const r = await runOf(runId)
      const id = current(r, 'build')?.nodeId
      if (id) {
        console.log(`  build statuses seen: ${JSON.stringify(await L.seenStatuses(page, id))}`)
        console.log(`  build screen:\n${(await L.screen(page, id)).filter((l) => l.trim()).slice(-25).map((l) => `    | ${l}`).join('\n')}`)
      }
      return r
    })
    const build = current(run, 'build')
    c.check('the Codex step finished only with a submitted result', build?.state === 'succeeded' && build.decidedBy !== 'person' && !!build.outputs?.summary?.text, build)
    c.check('the check step ran and passed', current(run, 'tests')?.state === 'succeeded' && current(run, 'tests')?.exitCode === 0, current(run, 'tests'))
    c.check('the run succeeded', run.state === 'succeeded', run.state)
    c.check('calc.js is fixed in the run\'s worktree, and only there', /a \+ b/.test(fs.readFileSync(path.join(run.cwd, 'calc.js'), 'utf8')) && /a - b/.test(fs.readFileSync(path.join(work, 'calc.js'), 'utf8')))
    const buildNode = build?.nodeId
    if (buildNode) {
      const said = await page.evaluate((id) => window.patchbay.readConversation(id), buildNode).catch((e) => ({ ok: false, reason: e.message }))
      c.check("the Codex step's conversation can be read", said.ok && said.messages.some((m) => m.role === 'assistant'), said.ok ? said.messages.slice(-2) : said)
    }

    // The deliverable, in the review inbox: ready, then accepted by its button.
    // The run is saved as succeeded first; its check evidence and submission follow within seconds.
    const succeededAt = Date.now()
    const view = await L.waitFor('the deliverable to be submitted', async () => {
      const v = await page.evaluate((t) => window.patchbay.taskShow('p1', t), run.taskId)
      return v.task.submissionId && v.readiness.ready ? v : null
    }, 30000, 250).catch(() => page.evaluate((t) => window.patchbay.taskShow('p1', t), run.taskId))
    console.log(`DELIVERABLE submitted ${Date.now() - succeededAt} ms after the run read as succeeded`)
    c.check('the deliverable task has the submission, its check passed, and it is ready', !!view.task.submissionId && view.task.state === 'ready-for-review' && view.readiness.ready, { state: view.task.state, readiness: view.readiness })
    // As the person goes: the dock's Work button, which counts what's waiting, then Review inbox.
    const workSays = await page.$eval('[data-cmd="work"]', (b) => b.getAttribute('aria-label'))
    c.check('the Work button says a submission is waiting', /1 waiting/.test(workSays), workSays)
    await page.click('[data-cmd="work"]')
    await page.waitForSelector('[data-cmd="review-inbox"]', { timeout: 5000 })
    await page.click('[data-cmd="review-inbox"]')
    await page.waitForSelector(`[data-review-task="${run.taskId}"]`, { timeout: 15000 })
    await page.click(`[data-review-task="${run.taskId}"]`)
    await page.waitForSelector(`[data-review-detail="${run.taskId}"] [data-review="accept"]:not([disabled])`, { timeout: 20000 }).catch(() => {})
    console.log('SHOT', await L.shot(page, 'workflow-codex-review-inbox'))
    const ready = await page.$eval(`[data-review-detail="${run.taskId}"] [data-review="accept"]`, (b) => !b.disabled).catch(() => false)
    c.check('the inbox offers Accept for it', ready)
    if (ready) {
      await page.click(`[data-review-detail="${run.taskId}"] [data-review="accept"]`)
      await L.sleep(800)
      const anyway = await page.$('[data-review="accept-anyway"]')
      if (anyway) await anyway.click()
      const task = await L.waitFor('the task to be accepted', async () => {
        const t = (await page.evaluate((id) => window.patchbay.taskShow('p1', id), run.taskId)).task
        return t.state === 'accepted' ? t : null
      }, 20000, 500).catch((e) => e.message)
      c.check('accepting it in the review inbox closes the deliverable', task?.state === 'accepted' && task.acceptances.length === 1, task?.state ?? task)
      console.log('SHOT', await L.shot(page, 'workflow-codex-accepted'))
    }
    console.log('\nSteps:')
    for (const a of run.attempts) console.log(`  ${a.step} #${a.n}: ${a.state}${a.why ? ` (${a.why})` : ''}${a.outputs?.summary ? ` — ${a.outputs.summary.text}` : ''}`)
    c.check('No errors in the page', app.problems.length === 0, app.problems)
  } finally {
    stop = true
    await answering
    console.log('\nAnswers:')
    for (const line of answered) console.log(`  ${line}`)
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      await window.patchbay.dispatch({ op: 'removeNodes', ids: doc.nodes.map((n) => n.id), at: Date.now() })
    }).catch(() => {})
    await L.sleep(1500)
    await app.quit().catch((e) => console.log(`NOTE  ${e.message}`))
    L.cleanup(profile)
    const list = runId && fs.existsSync(path.join(work, '.git')) ? execFileSync('git', ['-C', work, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }) : ''
    for (const line of list.split('\n')) {
      const wt = line.startsWith('worktree ') ? line.slice(9).trim() : null
      if (wt && path.resolve(wt).toLowerCase() !== path.resolve(work).toLowerCase()) {
        try { execFileSync('git', ['-C', work, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }) } catch {}
      }
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    c.finish()
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
