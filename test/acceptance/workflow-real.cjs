'use strict'
// One small real workflow run, Claude only: plan -> your review (approved here) -> implement -> a command. It spends a
// little plan quota on the cheapest model (Haiku, as lib.cjs sets; PB_MODEL overrides). Throwaway profile; every node
// it made is closed at the end, and its worktree removed.
// Run: node test/acceptance/workflow-real.cjs   (needs the dev build in out/)
//
// Permission prompts are answered as a careful person would: `patchbay` and `node` commands, read-only commands,
// reading files, and writes inside the run's folder. Every answer is listed.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const L = require('./lib.cjs')

const c = L.checker()
const LIMIT_MS = 12 * 60_000

function decide(a, folders) {
  const text = a.detail
  const inside = (p) => folders.some((f) => path.resolve(f, p).toLowerCase().startsWith(f.toLowerCase() + path.sep) || path.resolve(f, p).toLowerCase() === f.toLowerCase())
  if (['Read', 'Glob', 'Grep', 'LS'].includes(a.tool)) return 'allow'
  if (['Write', 'Edit', 'MultiEdit'].includes(a.tool)) return inside(text) ? 'allow' : 'deny'
  if (a.tool === 'Bash') {
    const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'ARG').replace(/\s2>&1/g, '').replace(/&&|\|\||;|\|/g, ';')
    if (/`|\$\(|>|</.test(bare)) return 'deny'
    const safe = (p) => /^cd\s/.test(p) || /^patchbay\s/.test(p) || /^node\s/.test(p) || /^(ls|pwd|cat|type|head|tail|wc|echo|grep|find|dir)\b/.test(p) || /^git (status|diff|log)\b/.test(p)
    return bare.split(';').every((p) => !p.trim() || safe(p.trim())) ? 'allow' : 'deny'
  }
  return 'deny'
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
  name: 'Smoke fix',
  inputs: [{ key: 'brief', label: 'Brief', type: 'text' }],
  steps: [
    {
      kind: 'agent', key: 'plan', title: 'Plan', agent: 'claude',
      prompt: 'Read calc.js and test.js in this folder. Do not change them. Write PLAN.md here: two or three sentences on how to do this: {{in:brief}}',
      outputs: [{ key: 'doc', label: 'Plan', type: 'file' }, { key: 'summary', label: 'Summary', type: 'text' }]
    },
    { kind: 'review', key: 'approve', title: 'Approve plan', question: 'Go ahead?', show: [{ step: 'plan', output: 'doc' }] },
    {
      kind: 'agent', key: 'build', title: 'Implement', agent: 'claude',
      prompt: 'Do what the plan in {{out:plan.doc}} says, in this folder. Keep it minimal. Check it with: node test.js',
      outputs: [{ key: 'summary', label: 'What changed', type: 'text' }]
    },
    { kind: 'command', key: 'tests', title: 'Tests', run: ['node', 'test.js'] }
  ]
}

async function main() {
  const work = L.workDir('workflow-real')
  seed(work)
  const profile = L.newProfile({ permissionMode: 'default', notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3, projects: [{ id: 'p1', name: 'Smoke', folder: work, viewport: { x: 0, y: 0, zoom: 0.6 } }], activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.6 }, nodes: [], edges: [], closed: []
  }))
  const env = process.env.PB_MODEL ? { ANTHROPIC_MODEL: process.env.PB_MODEL } : undefined
  const app = await L.launch({ profile, env })
  const { page } = app
  const folders = [work]
  const answered = []
  let stop = false
  const trusted = new Set()
  const answering = (async () => {
    while (!stop) {
      // Each run's worktree is a new folder, so Claude asks once whether to trust it, with "No, exit" chosen. The person
      // made this folder, so the answer is yes: down to "Yes, I trust this folder", then Enter.
      const statuses = await L.statuses(page).catch(() => ({}))
      for (const [id, s] of Object.entries(statuses)) {
        if (s !== 'needs-you' || trusted.has(id)) continue
        const screen = String(await L.snapshot(page, id).catch(() => ''))
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\s+/g, '')
        if (!/Itrustthisfolder/.test(screen) || !folders.slice(1).some((f) => screen.includes(f.replace(/\s+/g, '')))) continue
        trusted.add(id)
        answered.push(`trust  ${id}: the run's own worktree`)
        await L.input(page, id, '\x1b[B')
        await L.sleep(300)
        await L.input(page, id, '\r')
      }
      const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
      for (const a of pending) {
        const d = decide(a, folders)
        answered.push(`${d}  ${a.tool}: ${String(a.detail).replace(/\s+/g, ' ').slice(0, 160)}`)
        await page.evaluate((id, x) => window.patchbay.answerApproval(id, x), a.requestId, d).catch(() => {})
      }
      await L.sleep(400)
    }
  })()
  const runOf = (id) => page.evaluate(async (r) => (await window.patchbayWorkflows.runs('p1')).find((x) => x.id === r), id)
  const current = (run, step) => run.attempts.filter((a) => a.step === step).sort((a, b) => b.n - a.n)[0]
  let runId = null
  try {
    const saved = await page.evaluate((wf) => window.patchbayWorkflows.save({ projectId: 'p1', workflow: wf, where: 'personal', overwrite: true }), WORKFLOW)
    c.check('the workflow saves with no issues', saved.ok && saved.issues.length === 0, saved.ok ? undefined : saved.reason)
    const started = await page.evaluate(() => window.patchbayWorkflows.start({ projectId: 'p1', ref: 'personal:Smoke fix', inputs: { brief: 'make test.js pass' }, at: { x: 0, y: 0 } }))
    c.check('it starts', started.ok, started.ok ? undefined : started.reason)
    if (!started.ok) return
    runId = started.runId
    let run = await runOf(runId)
    folders.push(run.cwd)
    c.check('the run has its own worktree', !!run.worktree && run.cwd !== work, run.worktree)

    const deadline = Date.now() + LIMIT_MS
    /** What a step's node shows and has reported, when something takes too long. */
    const diagnose = async (r, step) => {
      const id = current(r, step)?.nodeId
      if (!id) return
      console.log(`  ${step} statuses seen: ${JSON.stringify(await L.seenStatuses(page, id))}`)
      const screen = await L.snapshot(page, id).catch((e) => `(no snapshot: ${e.message})`)
      console.log(`  ${step} screen, last lines:\n${String(screen).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter((l) => l.trim()).slice(-25).map((l) => `    | ${l}`).join('\n')}`)
    }
    run = await L.waitFor('the review step', async () => {
      const r = await runOf(runId)
      return ['waiting-for-you', 'failed', 'needs-attention'].includes(r.state) && current(r, 'approve') ? r : null
    }, 5 * 60_000, 2000).catch(async (e) => {
      console.log(e.message)
      const r = await runOf(runId)
      await diagnose(r, 'plan')
      return r
    })
    const plan = current(run, 'plan')
    c.check('the plan step finished only with a submitted result', plan?.state === 'succeeded' && plan.outputs?.doc?.type === 'file' && !!plan.outputs.doc.sha256, plan)
    c.check('the review waits for the person', current(run, 'approve')?.state === 'waiting-for-you')
    const routed = plan?.outputs?.doc ? await page.evaluate((p) => window.patchbayWorkflows.reviewFor(p), plan.outputs.doc.path) : null
    c.check("the reader would send the plan's comments as Request changes", routed?.agent === 'Plan', routed)

    if (current(run, 'approve')?.state !== 'waiting-for-you') return
    const ok = await page.evaluate((r, a) => window.patchbayWorkflows.act(r, { type: 'decide', attemptId: a, decision: 'approve', note: 'Keep it minimal.' }), runId, current(run, 'approve')?.id)
    c.check('approving moves on', ok.ok, ok)
    run = await L.waitFor('the run to end', async () => {
      const r = await runOf(runId)
      return ['succeeded', 'failed', 'needs-attention'].includes(r.state) ? r : null
    }, Math.max(60_000, deadline - Date.now()), 2000).catch(async (e) => {
      console.log(e.message)
      const r = await runOf(runId)
      await diagnose(r, 'build')
      return r
    })
    c.check('the implement step finished with its result', current(run, 'build')?.state === 'succeeded', current(run, 'build'))
    c.check('the command ran and passed', current(run, 'tests')?.state === 'succeeded' && current(run, 'tests')?.exitCode === 0, current(run, 'tests'))
    c.check('the run succeeded', run.state === 'succeeded', run.state)
    console.log('\nSteps:')
    for (const a of run.attempts) console.log(`  ${a.step} #${a.n}: ${a.state}${a.why ? ` (${a.why})` : ''}${a.outputs?.summary ? ` — ${a.outputs.summary.text}` : ''}`)
  } finally {
    stop = true
    await answering
    console.log('\nPermission answers:')
    for (const line of answered) console.log(`  ${line}`)
    // Close every node it made, then quit, ending the sessions with it.
    await page.evaluate(async () => {
      const doc = await window.patchbay.getDoc()
      await window.patchbay.dispatch({ op: 'removeNodes', ids: doc.nodes.map((n) => n.id), at: Date.now() })
    }).catch(() => {})
    await L.sleep(1500)
    await app.quit().catch((e) => console.log(`NOTE  ${e.message}`))
    L.cleanup(profile)
    const run = runId && fs.existsSync(path.join(work, '.git')) ? execFileSync('git', ['-C', work, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }) : ''
    for (const line of run.split('\n')) {
      const wt = line.startsWith('worktree ') ? line.slice(9).trim() : null
      if (wt && path.resolve(wt).toLowerCase() !== path.resolve(work).toLowerCase()) {
        try { execFileSync('git', ['-C', work, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' }) } catch {}
      }
    }
    c.finish()
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
