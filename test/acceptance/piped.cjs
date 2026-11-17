'use strict'
// The patchbay command in a real terminal on the canvas, with a diagram piped in from a heredoc, as the skill teaches:
// one command, no file, and an apostrophe in a label that would break a single-quoted --diagram. No Claude runs.
// Run: node test/acceptance/piped.cjs [--packaged]
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)

async function main() {
  const cwd = L.workDir('piped')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const at = (id, kind, x, extra) => ({ id, kind, title: id, x, y: 0, width: 520, height: 320, parentId: null, projectId: 'p1', ...extra })
  fs.writeFileSync(
    path.join(profile, 'canvas.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: 'p1', name: 'Piped', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
      activeProjectId: 'p1',
      viewport: { x: 20, y: 20, zoom: 0.8 },
      nodes: [at('agent', 'terminal', 0, { cwd }), at('board', 'whiteboard', 600, { shapes: [] })],
      edges: [{ id: 'l', from: 'agent', to: 'board', kind: 'link' }],
      closed: []
    })
  )
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = app
  try {
    await L.waitFor('the shell', async () => /\$/.test(await L.snapshot(page, 'agent')), 30000)
    await L.sleep(1500)
    const out = `${cwd.replace(/\\/g, '/')}/drew`
    const lines = [
      `patchbay draw --node board --diagram-file - > ${out}.txt 2>&1 <<'EOF'`,
      '{ "title": "Sign-in", "boxes": [ { "id": "page", "label": "Can\'t sign in" }, { "id": "api", "label": "Auth API" } ],',
      '  "arrows": [ { "from": "page", "to": "api" } ] }',
      'EOF',
      `echo $? > ${out}.code`
    ]
    for (const line of lines) {
      await L.submit(page, 'agent', line)
      await L.sleep(250)
    }
    await L.waitFor('patchbay draw', () => fs.existsSync(`${out}.code`) && fs.readFileSync(`${out}.code`, 'utf8').trim() !== '', 30000, 200)
    const code = fs.readFileSync(`${out}.code`, 'utf8').trim()
    const said = fs.readFileSync(`${out}.txt`, 'utf8')
    c.check('A diagram piped in from a heredoc is drawn', code === '0' && /"added"/.test(said), said.slice(0, 300))
    const board = (await L.doc(page)).nodes.find((n) => n.id === 'board')
    const words = board.shapes.filter((s) => s.type === 'text').map((s) => s.text)
    c.check("Its labels arrive whole, apostrophe and all", words.includes("Can't sign in") && words.includes('Auth API'), words)
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
