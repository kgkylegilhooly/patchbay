'use strict'
// Real Claude windows working in several project tabs at once, on small coding tasks: what that costs in CPU, for
// Patchbay and for the whole PC, how a terminal answers meanwhile, and how often each agent really runs its status line
// and tool hooks. It spends a little plan quota (Haiku unless PB_MODEL says otherwise), and stops before starting if
// less than PB_MIN_LEFT percent (default 25) of the 5-hour limit is left.
//
// Edits and shell commands inside the work folder are allowed, as a person trusting the task would. Anything else is
// declined. Run after npm run build: node test/acceptance/real-tabs.cjs   (PB_TABS 3, PB_AGENTS 2)
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(20 * 60_000)
const TABS = Number(process.env.PB_TABS || 3)
const AGENTS = Number(process.env.PB_AGENTS || 2)
const MIN_LEFT = Number(process.env.PB_MIN_LEFT || 25)

const TASK = (name) =>
  `In this folder, write ${name}.js exporting these, one at a time: add, subtract, multiply, divide (throwing on ` +
  'division by zero), clamp, average, median, mode, range, slugify, titleCase, truncate (with an ellipsis), ' +
  `wordCount, isPalindrome and chunk. After adding each one, add its checks to ${name}.test.js with node:assert, ` +
  'several cases apiece, and run the file with node, fixing anything that fails before going on to the next. When all ' +
  'of them pass, reply with one line saying so.'

function processStats(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.KernelModeTime, $_.UserModeTime, $_.Name, $_.CommandLine }`
  let text = ''
  try {
    text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  } catch {
    return {}
  }
  const cpu = {}
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [kernel, user, name, cmd] = line.split('|')
    if (!/^(electron|patchbay)\.exe$/i.test(name)) continue
    const role = /--type=([\w-]+)/.exec(cmd)?.[1] ?? (/hostLauncher|sessionHost|hostProcess/i.test(cmd) ? 'host' : 'main')
    cpu[role] = (cpu[role] ?? 0) + (Number(kernel) + Number(user)) / 1e7
  }
  return cpu
}
/** CPU seconds of every claude.exe and what they run, which is Claude's own cost. */
function claudeSeconds() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process claude -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum"], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
}
function machine() {
  let busy = 0
  let all = 0
  for (const { times: t } of os.cpus()) {
    const total = t.user + t.nice + t.sys + t.irq + t.idle
    all += total
    busy += total - t.idle
  }
  return { busy, all }
}

async function main() {
  const work = L.workDir('real-tabs')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, realHome: true })
  const { page } = app
  const signals = path.join(profile, 'sessions', 'signals')
  try {
    // The plan's limits arrive with the first status line, so a quick look first.
    const ids = []
    const tabs = []
    const first = (await L.doc(page)).activeProjectId
    for (let t = 0; t < TABS; t++) {
      const projectId = t === 0 ? first : `tab${t}`
      if (t > 0) await page.evaluate((p) => window.patchbay.dispatch({ op: 'addProject', project: p }), { id: projectId, name: `Tab ${t + 1}`, folder: work, viewport: { x: 0, y: 0, zoom: 0.7 } })
      const agents = []
      for (let i = 0; i < AGENTS; i++) {
        const id = `t${t}a${i}`
        const dir = path.join(work, id)
        fs.mkdirSync(dir, { recursive: true })
        await L.openNode(page, { ...L.claude(id, dir, (i % 2) * 640, 0), width: 620, height: 420, prompt: TASK(`lib_${id}`) })
        agents.push(id)
        ids.push(id)
      }
      const term = `t${t}term`
      await L.openNode(page, L.terminal(term, work, 0, 460))
      tabs.push({ projectId, agents, term })
    }
    await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), tabs[0].projectId)

    const usage = await L.waitFor('the plan limits', async () => {
      const u = await page.evaluate(() => window.patchbay.getUsage())
      return u.plan?.fiveHour ? u : null
    }, 90000).catch(() => null)
    const left = usage ? 100 - usage.plan.fiveHour.percent : null
    console.log('PLAN 5h left', left === null ? 'unknown' : `${left}%`)
    if (left !== null && left < MIN_LEFT) {
      console.log(`STOPPING: under ${MIN_LEFT}% of the 5-hour limit is left.`)
      await page.evaluate((all) => Promise.all(all.map((id) => window.patchbay.stopNode(id))), ids)
      return
    }

    // Approvals: inside the work folder, yes; anything else, no.
    const answered = []
    let answering = true
    const answer = (async () => {
      while (answering) {
        const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
        for (const a of pending) {
          const text = `${a.tool} ${a.detail}`
          const inside = !/\.\.[\\/]/.test(a.detail) && (a.tool !== 'Bash' || !/\b(rm|del|curl|wget|git push|Invoke-WebRequest)\b/.test(a.detail))
          const decision = inside ? 'allow' : 'deny'
          answered.push(`${decision} ${text.slice(0, 120)}`)
          await page.evaluate((id, d) => window.patchbay.answerApproval(id, d), a.requestId, decision).catch(() => {})
        }
        await L.sleep(400)
      }
    })()

    // Counts how often each agent's status line and tool hooks run, from their files' times.
    const seen = new Map()
    const counts = { status: 0, tool: 0 }
    const watch = setInterval(() => {
      for (const [dir, kind] of [[path.join(signals, 'status'), 'status'], [signals, 'tool']]) {
        let names = []
        try {
          names = fs.readdirSync(dir)
        } catch {}
        for (const name of names) {
          if (kind === 'tool' && !/\.PostToolUse(Failure)?$/.test(name)) continue
          if (kind === 'status' && !/\.status$/.test(name)) continue
          try {
            const at = fs.statSync(path.join(dir, name)).mtimeMs
            if (seen.has(name) && seen.get(name) !== at) counts[kind]++
            seen.set(name, at)
          } catch {}
        }
      }
    }, 100)

    await L.fitView(page)
    await page.click(`.react-flow__node[data-id="${tabs[0].term}"] .xterm-screen`).catch(() => {})
    // Every process's CPU each second, by name, from Windows' own counters: short-lived ones are caught while they run.
    const counterFile = path.join(os.tmpdir(), `pb-real-tabs-${Date.now()}.csv`)
    const counters = require('node:child_process').spawn('typeperf', ['\\Process(*)\\% Processor Time', '-si', '1', '-o', counterFile, '-f', 'CSV', '-y'], { stdio: 'ignore', windowsHide: true })
    const s0 = processStats(profile)
    const c0 = claudeSeconds()
    const m0 = machine()
    const t0 = Date.now()
    const samples = []
    let done = false
    const keys = []
    let n = 0
    let priorities = null
    while (!done && Date.now() - t0 < 8 * 60_000) {
      const st = await L.statuses(page)
      done = ids.every((id) => st[id] === 'idle') && Date.now() - t0 > 20000
      const k = Date.now()
      await page.evaluate(() => window.patchbay.getApprovals())
      samples.push(Date.now() - k)
      // A key typed in the terminal on screen, timed until it shows.
      const token = `k${n++}x`
      const shown = page.evaluate(
        (i, tok) =>
          new Promise((resolve) => {
            const t = performance.now()
            const check = () => {
              if ((document.querySelector(`.react-flow__node[data-id="${i}"] .xterm-rows`)?.textContent ?? '').includes(tok)) resolve(Math.round(performance.now() - t))
              else if (performance.now() - t > 10000) resolve(10000)
              else requestAnimationFrame(check)
            }
            check()
          }),
        tabs[0].term,
        token
      )
      await page.keyboard.type(token)
      keys.push(await shown)
      if (n % 5 === 0) await page.keyboard.down('Control').then(() => page.keyboard.press('u')).then(() => page.keyboard.up('Control'))
      if (!priorities) {
        const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -like '*patchbay-accept-*' } | ForEach-Object { $_.Priority }"], { encoding: 'utf8', windowsHide: true })
        priorities = [...new Set(out.split(/\r?\n/).filter(Boolean).map(Number))]
      }
      await L.sleep(1500)
    }
    const sortedKeys = [...keys].sort((a, b) => a - b)
    console.log('KEYS ms', JSON.stringify({ p50: sortedKeys[Math.floor(sortedKeys.length / 2)], worst: sortedKeys.at(-1), samples: keys.length }))
    console.log("CLAUDE's priority", JSON.stringify(priorities), '(6 is below normal, 8 normal)')
    const seconds = (Date.now() - t0) / 1000
    counters.kill()
    await L.sleep(1500)
    try {
      const rows = fs.readFileSync(counterFile, 'utf8').trim().split(/\r?\n/).map((r) => r.split('","').map((x) => x.replace(/^"|"$/g, '')))
      const names = rows[0].slice(1).map((h) => /\\Process\(([^)#]+)/.exec(h)?.[1] ?? h)
      const byName = new Map()
      for (const row of rows.slice(1)) row.slice(1).forEach((v, i) => byName.set(names[i], (byName.get(names[i]) ?? 0) + (Number(v) || 0)))
      const samples = rows.length - 1
      const top = [...byName].filter(([n]) => n !== '_Total' && n !== 'Idle').map(([n, v]) => [n, Math.round(v / samples)]).sort((a, b) => b[1] - a[1]).slice(0, 15)
      console.log('BY PROGRAM % of one core', JSON.stringify(top))
      fs.rmSync(counterFile, { force: true })
    } catch (e) {
      console.log('BY PROGRAM unavailable', e.message)
    }
    clearInterval(watch)
    answering = false
    await answer
    const s1 = processStats(profile)
    const c1 = claudeSeconds()
    const m1 = machine()
    const cpu = Object.fromEntries(Object.keys(s1).map((k) => [k, Math.round((((s1[k] ?? 0) - (s0[k] ?? 0)) / seconds) * 100)]))
    const minutes = seconds / 60
    console.log('REAL', TABS, 'tabs x', AGENTS, 'agents for', Math.round(seconds), 's', done ? '(all finished)' : '(time ran out)')
    console.log('PATCHBAY CPU % of one core', JSON.stringify(cpu))
    console.log("CLAUDE's own CPU % of one core", Math.round(((c1 - c0) / seconds) * 100))
    console.log('PC busy %', Math.round(((m1.busy - m0.busy) / (m1.all - m0.all)) * 100))
    console.log('PER AGENT per minute', JSON.stringify({ statusLines: Math.round((counts.status / ids.length / minutes) * 10) / 10, toolCalls: Math.round((counts.tool / ids.length / minutes) * 10) / 10 }))
    console.log('MAIN answer ms worst', Math.max(...samples))
    const results = ids.map((id) => {
      const dir = path.join(work, id)
      let passes = false
      try {
        execFileSync('node', [`lib_${id}.test.js`], { cwd: dir, stdio: 'ignore', timeout: 20000 })
        passes = true
      } catch {}
      return { id, passes }
    })
    console.log('RESULTS', JSON.stringify(results))
    console.log('APPROVALS', answered.length, 'declined', answered.filter((a) => a.startsWith('deny')).length)
    c.check('Every agent finished its task', done)
    c.check("Every agent's tests pass", results.every((r) => r.passes), results)
    c.check('Patchbay answered within 250 ms throughout', Math.max(...samples) < 250, Math.max(...samples))
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.forceKill().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
