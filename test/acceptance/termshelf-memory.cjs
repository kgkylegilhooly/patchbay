'use strict'
// What terminals kept for a quick switch back hold (terminalShelf.ts): N terminals with full scrollbacks, measured as
// JS heap after garbage collection and DOM nodes, on show, then after switching to an empty project, then once the
// kept terminals would have gone. Run on a build with and without the shelf to compare.
// Env: PB_MEM_N (terminals, default 8), PB_MEM_LINES (lines each prints, default 12000).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

if (require.main === module) U.watchdog(8 * 60_000)
const N = Number(process.env.PB_MEM_N ?? 8)
const LINES = Number(process.env.PB_MEM_LINES ?? 12000)

/** Private memory of this run's window process, in MB: xterm's line buffers live outside the JS heap. */
function rendererMB(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile}*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { $_.PrivatePageCount }`
  const text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  return Math.round(Math.max(0, ...text.split(/\s+/).filter(Boolean).map(Number)) / 1048576)
}

async function heap(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  await L.sleep(300)
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  const dom = await page.evaluate(() => document.getElementsByTagName('*').length)
  return { heapMB: Math.round(usedSize / 1048576), dom, windowMB: rendererMB(page.__profile) }
}

async function main() {
  const cwd = L.workDir('termshelf-memory')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const t = (id, i) => ({ id, kind: 'terminal', title: id, x: 380 + (i % 4) * 560, y: Math.floor(i / 4) * 360, width: 520, height: 320, parentId: null, cwd, projectId: 'p1' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3,
    projects: [
      { id: 'p1', name: 'Full', folder: cwd, viewport: { x: 40, y: 40, zoom: 0.5 } },
      { id: 'p2', name: 'Empty', folder: cwd, viewport: { x: 40, y: 40, zoom: 1 } }
    ],
    activeProjectId: 'p1',
    viewport: { x: 40, y: 40, zoom: 0.5 },
    edges: [],
    closed: [],
    nodes: Array.from({ length: N }, (_, i) => t(`m${i}`, i))
  }))
  const app = await L.launch({ profile })
  const { page } = app
  page.__profile = profile
  const cdp = await page.createCDPSession()
  try {
    const ids = Array.from({ length: N }, (_, i) => `m${i}`)
    await L.waitFor('the shells', async () => (await Promise.all(ids.map((id) => L.snapshot(page, id)))).every((s) => s.includes('$')), 90000)
    // 100-character lines, enough to fill the scrollback.
    for (const id of ids) await L.input(page, id, `node -e "const s='x'.repeat(92);for(let i=1;i<=${LINES};i++)console.log(String(i).padStart(7)+' '+s)"\r`)
    await L.waitFor('every scrollback full', async () => (await Promise.all(ids.map((id) => page.$eval(`.react-flow__node[data-id="${id}"] .xterm-rows`, (r) => r.textContent).catch(() => '')))).every((x) => x.includes(String(LINES))), 120000)
    await L.sleep(2000)
    const shown = await heap(page, cdp)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'switchProject', id: 'p2' }))
    await L.sleep(3000)
    const away = await heap(page, cdp)
    const out = { terminals: N, lines: LINES, shown, away }
    console.log('MEMORY', JSON.stringify(out))
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
}

if (require.main === module) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
