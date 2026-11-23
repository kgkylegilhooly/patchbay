'use strict'
// The main/host audit's app-level probes (.claude/audits/copies/mainhost/audit-{backpressure,busy,run}.cjs), against
// any built copy of the app. Off-screen windows and throwaway profiles through test/acceptance/lib.cjs; no quota used.
//
//   node test/perf/mainhost-app.cjs <app folder> <backpressure|busy|idle> <label> <out.jsonl>
//
// The app folder needs a built out/ with the audit's counters in it: `node test/perf/mainhost-app.cjs <folder>
// instrument` adds them (the audit's own copy already has them).
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const [appDir, scenario, label = scenario, outFile] = process.argv.slice(2)
const root = path.resolve(appDir)

const PRELUDE = `
;(function(){
const fs=require('node:fs'), fsp=require('node:fs/promises');
const a=globalThis.__audit={started:Date.now(),intervals:[],fs:{},outputCount:0,outputBytes:0};
const interval=globalThis.setInterval;
globalThis.setInterval=function(fn,ms,...args){const row={ms,count:0,source:new Error().stack.split('\\n').slice(2,4).join(' ')};a.intervals.push(row);return interval(function(...x){row.count++;return fn(...x)},ms,...args)};
for(const [mod,names] of [[fs,['readFileSync','statSync','readdirSync']],[fsp,['readFile','stat','readdir']]]) for(const name of names){const orig=mod[name];mod[name]=function(...args){const r=a.fs[name]??={n:0};r.n++;return orig.apply(this,args)}}
try{const {app}=require('electron');app.on('web-contents-created',(_e,wc)=>{const send=wc.send.bind(wc);wc.send=(ch,...x)=>{if(ch==='pb:onOutput'){a.outputCount++;a.outputBytes+=String(x[1]).length}return send(ch,...x)}});globalThis.__auditHide=()=>require('electron').BrowserWindow.getAllWindows()[0].hide()}catch{}
a.snapshot=()=>({at:Date.now(),cpu:process.cpuUsage(),memory:process.memoryUsage(),intervals:a.intervals,fs:a.fs,outputCount:a.outputCount,outputBytes:a.outputBytes});
})();
`

function instrument() {
  for (const name of ['index.js', 'sessionHost.js']) {
    const file = path.join(root, 'out', 'main', name)
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('globalThis.__audit=')) continue
    const host = name === 'sessionHost.js' ? `require('node:inspector').open(0,'127.0.0.1');require('node:fs').writeFileSync(require('node:path').join(process.argv[2],'audit-host-url'),require('node:inspector').url());\n` : ''
    fs.writeFileSync(file, PRELUDE + host + text)
  }
  console.log('instrumented', root)
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) (pending.get(m.id)?.(m), pending.delete(m.id))
  }
  return {
    ws,
    send: (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params })))),
    async eval(expression) {
      const m = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (m.result?.exceptionDetails) throw Error(JSON.stringify(m.result.exceptionDetails))
      return m.result?.result?.value
    }
  }
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const record = (data) => { if (outFile) fs.appendFileSync(outFile, JSON.stringify({ label, scenario, ...data }) + '\n'); console.log(JSON.stringify(data)) }
// Never the person's own settings, even for preferences: lib.cjs reads envNotPassed from APPDATA.
process.env.APPDATA = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pb-probe-appdata-'))

async function launchWithDebugger(L, profile) {
  const port = await freePort()
  process.env.PB_MAIN_INSPECT = String(port)
  const t = Date.now()
  const app = await L.launch({ profile, env: { NO_PROXY: '127.0.0.1,localhost' } })
  const canvasMs = Date.now() - t
  const main = await connect((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0].webSocketDebuggerUrl)
  return { app, main, canvasMs }
}

async function backpressure(L) {
  const cwd = L.workDir('probe-output-' + Date.now())
  const emitter = path.join(cwd, 'emit.cjs')
  fs.writeFileSync(emitter, "process.stdout.write('$ ');process.stdin.once('data',()=>{const chunk=('0123456789abcdef'.repeat(63)+String.fromCharCode(13,10)).repeat(16);const t=setInterval(()=>process.stdout.write(chunk),20);setTimeout(()=>{clearInterval(t);console.log('DONE')},20000)});")
  const profile = L.newProfile({ notifications: 'off', sound: 'off', usageSource: 'off', terminalProfiles: [{ id: 'fake', name: 'Fake output', program: process.execPath, args: [emitter] }], defaultTerminalProfile: 'fake' })
  const { app, main } = await launchWithDebugger(L, profile)
  try {
    const ids = Array.from({ length: 10 }, (_, i) => 'out' + i)
    for (const [i, id] of ids.entries()) await L.openNode(app.page, L.terminal(id, cwd, (i % 4) * 500, Math.floor(i / 4) * 320))
    await L.waitFor('shells', async () => (await Promise.all(ids.map((id) => L.snapshot(app.page, id)))).every((x) => x.includes('$')))
    await L.fitView(app.page)
    for (const id of ids) await L.submit(app.page, id, 'go')
    await L.sleep(1500)
    const cdp = await app.page.createCDPSession()
    await cdp.send('Debugger.enable')
    await cdp.send('Debugger.pause')
    const snap = () => main.eval('({at:Date.now(),count:__audit.outputCount,bytes:__audit.outputBytes,memory:process.memoryUsage()})')
    const a = await snap()
    await L.sleep(5000)
    const b = await snap()
    await cdp.send('Debugger.resume')
    await cdp.send('Debugger.disable')
    const t = Date.now()
    await app.page.evaluate(() => 1)
    const answerMs = Date.now() - t
    // After catching up, every terminal still shows output: the stream carried on after the stall.
    await L.sleep(1500)
    const tails = await Promise.all(ids.map((id) => L.snapshot(app.page, id)))
    record({ pausedMs: b.at - a.at, sentChunks: b.count - a.count, sentBytes: b.bytes - a.bytes, mainRssGrowthMB: (b.memory.rss - a.memory.rss) / 1048576, answerMs, terminalsShowingOutput: tails.filter((s) => s.includes('0123456789abcdef')).length })
  } finally {
    main.ws.close()
    await app.forceKill()
    L.stopHostOf(profile)
  }
}

async function busy(L) {
  const cwd = L.workDir('probe-busy-' + Date.now())
  const profile = L.newProfile({ notifications: 'off', sound: 'off', usageSource: 'off', terminalProfiles: [{ id: 'fake', name: 'Fake busy', program: process.execPath, args: [path.join(root, 'test/acceptance/claude-load.cjs'), '90', '--heavy'] }], defaultTerminalProfile: 'fake' })
  const projects = [1, 2, 3].map((i) => ({ id: 'p' + i, name: 'Probe ' + i, folder: cwd, viewport: { x: 0, y: 0, zoom: 0.5 } }))
  const nodes = Array.from({ length: 10 }, (_, i) => L.terminal('busy' + i, cwd, (i % 4) * 500, Math.floor(i / 4) * 320, { projectId: 'p1' }))
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects, activeProjectId: 'p1', viewport: projects[0].viewport, nodes, edges: [], closed: [] }))
  const { app, main } = await launchWithDebugger(L, profile)
  const host = await connect(fs.readFileSync(path.join(profile, 'audit-host-url'), 'utf8'))
  try {
    await L.waitFor('ten printing fakes', async () => (await Promise.all(nodes.map((n) => L.snapshot(app.page, n.id)))).every((s) => s.includes('Working')))
    await L.fitView(app.page)
    await L.sleep(1500)
    const snap = (d) => d.eval('({at:Date.now(),count:(globalThis.__audit.outputCount||0),bytes:(globalThis.__audit.outputBytes||0),cpu:process.cpuUsage(),memory:process.memoryUsage()})')
    const diff = (a, b) => ({ cpuPct: (b.cpu.user - a.cpu.user + b.cpu.system - a.cpu.system) / 10 / (b.at - a.at), chunks: b.count - a.count, bytes: b.bytes - a.bytes })
    const row = {}
    for (const phase of ['active', 'hidden']) {
      if (phase === 'hidden') {
        await app.page.evaluate(() => window.patchbay.dispatch({ op: 'switchProject', id: 'p2' }))
        await L.sleep(1000)
      }
      const a = await snap(main), h = await snap(host)
      const latency = []
      for (let i = 0; i < 30; i++) {
        const t = Date.now()
        await app.page.evaluate(() => window.patchbay.getApprovals())
        latency.push(Date.now() - t)
        await L.sleep(300)
      }
      const b = await snap(main), j = await snap(host)
      latency.sort((x, y) => x - y)
      row[phase] = { seconds: (b.at - a.at) / 1000, main: diff(a, b), host: diff(h, j), ipcP50: latency[15], ipcP95: latency[28] }
    }
    // Shown again: the latest output is there at once.
    await app.page.evaluate(() => window.patchbay.dispatch({ op: 'switchProject', id: 'p1' }))
    const t = Date.now()
    await L.waitFor('output shown again', async () => (await L.snapshot(app.page, 'busy0')).includes('Working'), 10000, 25)
    row.reshowMs = Date.now() - t
    record(row)
  } finally {
    main.ws.close()
    host.ws.close()
    await app.forceKill()
    L.stopHostOf(profile)
  }
}

async function idle(L) {
  const cwd = L.workDir('probe-idle-' + Date.now())
  const profile = L.newProfile({ notifications: 'off', sound: 'off', usageSource: 'off', claudeCommand: `node "${path.join(root, 'test/acceptance/fake-claude.cjs')}"` })
  const projects = [1, 2, 3].map((i) => ({ id: 'p' + i, name: 'Probe ' + i, folder: cwd, viewport: { x: 20, y: 20, zoom: 0.45 } }))
  const nodes = Array.from({ length: 10 }, (_, i) => L.claude('idle' + i, cwd, (i % 4) * 640, Math.floor(i / 4) * 440, { projectId: 'p1', prompt: 'idle chat' }))
  nodes.push(...Array.from({ length: 12 }, (_, i) => ({ id: 'note' + i, kind: 'sticky', title: 'Note ' + i, text: 'saved node', x: i * 20, y: i * 30, width: 300, height: 200, parentId: null, projectId: 'p2' })))
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects, activeProjectId: 'p1', viewport: projects[0].viewport, nodes, edges: [], closed: [] }))
  const { app, main, canvasMs } = await launchWithDebugger(L, profile)
  const host = await connect(fs.readFileSync(path.join(profile, 'audit-host-url'), 'utf8'))
  try {
    await L.waitFor('ten idle agents', async () => { const s = await L.statuses(app.page); return nodes.slice(0, 10).every((n) => s[n.id] === 'idle') }, 90000)
    await L.sleep(5000)
    const sample = async () => {
      const a = await main.eval('__audit.snapshot()'), h = await host.eval('__audit.snapshot()')
      await L.sleep(30000)
      const b = await main.eval('__audit.snapshot()'), j = await host.eval('__audit.snapshot()')
      const d = (x, y) => ({
        cpuPct: (100 * ((y.cpu.user - x.cpu.user + y.cpu.system - x.cpu.system) / 1000)) / (y.at - x.at),
        callbacks: y.intervals.reduce((n, v, i) => n + v.count - (x.intervals[i]?.count || 0), 0),
        dirReads: ['readdirSync', 'readdir'].reduce((n, k) => n + ((y.fs[k]?.n || 0) - (x.fs[k]?.n || 0)), 0),
        byInterval: y.intervals.map((v, i) => ({ ms: v.ms, count: v.count - (x.intervals[i]?.count || 0), source: v.source.replace(/\s+/g, ' ').slice(0, 160) })).filter((v) => v.count)
      })
      return { main: d(a, b), host: d(h, j) }
    }
    const visible = await sample()
    await main.eval('__auditHide()')
    const hidden = await sample()
    record({ canvasMs, visible, hidden })
  } finally {
    main.ws.close()
    host.ws.close()
    await app.forceKill()
    L.stopHostOf(profile)
  }
}

async function main() {
  if (scenario === 'instrument') return instrument()
  const L = require(path.join(root, 'test/acceptance/lib.cjs'))
  await { backpressure, busy, idle }[scenario](L)
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
