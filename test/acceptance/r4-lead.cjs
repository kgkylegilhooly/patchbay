'use strict'
// A lead's loop on the real app, with stand-in agents (fake-claude.cjs in its "turns" mode), so no quota is used:
// wait --next ignores members already idle and returns at the next turn that ends; a send to an agent with no
// transcript is confirmed by the prompt its hook reports; team gives one line per member; and open-agent into a group
// that went with its last member fails through the real CLI, on stderr with exit 1, creating nothing. Run after
// npm run build.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFile } = require('node:child_process')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')
const CLI = path.join(__dirname, '..', '..', 'resources', 'cli', 'patchbay.cjs')

function seed(profile, cwd) {
  const agent = (id, title, x) => ({ id, kind: 'claude', title, x, y: 80, width: 520, height: 320, parentId: null, projectId: 'p1', cwd, prompt: 'turns paste', sessionId: null, transcriptPath: null, after: [], openedBy: 'lead' })
  fs.writeFileSync(
    path.join(profile, 'canvas.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: 'p1', name: 'Lead', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
      activeProjectId: 'p1',
      viewport: { x: 20, y: 20, zoom: 0.6 },
      nodes: [
        { id: 'lead', kind: 'terminal', title: 'Lead', x: 0, y: -400, width: 460, height: 280, parentId: null, cwd, projectId: 'p1' },
        agent('a', 'Alpha', 0),
        agent('b', 'Beta', 600)
      ],
      edges: [
        { id: 'la', from: 'lead', to: 'a', kind: 'link' },
        { id: 'lb', from: 'lead', to: 'b', kind: 'link' }
      ],
      closed: []
    })
  )
}

const tokenOf = (profile, node) => crypto.createHmac('sha256', fs.readFileSync(path.join(profile, 'secret'), 'utf8')).update(node).digest('hex')

function rpc(profile, node, verb, args) {
  const { port } = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'endpoint.json'), 'utf8'))
  const body = JSON.stringify({ verb, args })
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-patchbay-node': node, authorization: `Bearer ${tokenOf(profile, node)}` } },
      (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** The real `patchbay` command, as the lead's shell would run it. */
function cli(profile, args) {
  const env = { ...process.env, PATCHBAY_ENDPOINT_FILE: path.join(profile, 'control', 'endpoint.json'), PATCHBAY_NODE_ID: 'lead', PATCHBAY_TOKEN: tokenOf(profile, 'lead') }
  return new Promise((done) => execFile(process.execPath, [CLI, ...args], { env, windowsHide: true, timeout: 60_000 }, (e, stdout, stderr) => done({ code: e ? (e.code ?? -1) : 0, stdout, stderr })))
}

async function main() {
  const cwd = L.workDir('r4-lead')
  const profile = L.newProfile({ claudeCommand: `node "${fakeClaude}"`, notifications: 'off', sound: 'off' })
  seed(profile, cwd)
  const app = await L.launch({ profile })
  const page = app.page
  try {
    for (const id of ['a', 'b']) await L.waitFor(`agent ${id} idle`, async () => (await L.statusOf(page, id)) === 'idle', 40000)

    // Both are idle, as members waiting for review are. --any returns at once; --next waits for something new.
    const t0 = Date.now()
    const any = await rpc(profile, 'lead', 'wait', { nodes: ['a', 'b'], any: true, timeout: 20 })
    c.check('wait --any still returns at once for a member already idle', any.json.result?.done === true && Date.now() - t0 < 6000, { ms: Date.now() - t0, r: any.json })

    const t1 = Date.now()
    let nextAt = 0
    const next = rpc(profile, 'lead', 'wait', { nodes: ['a', 'b'], next: true, timeout: 40 }).then((r) => ((nextAt = Date.now()), r))
    await L.sleep(4000)
    c.check('wait --next is still waiting after 4 s with both members idle', nextAt === 0)
    const sent = await rpc(profile, 'lead', 'send', { node: 'b', text: 'Please re-run the review on your branch.' })
    c.check('A send to an agent with no transcript is confirmed by the prompt its hook reported', sent.json.result?.delivered === true && sent.json.result?.confirmed === true, sent.json)
    const woke = await next
    c.check('wait --next returns when that member finishes the turn it started', woke.json.result?.done === true && woke.json.result?.next?.node === 'b' && woke.json.result?.next?.why === 'finished', woke.json)
    c.check('...and not before', nextAt - t1 >= 4000, nextAt - t1)

    // The lead is busy with b's result while a takes and finishes a turn: the next --next returns it at once.
    await rpc(profile, 'lead', 'send', { node: 'a', text: 'Please add the empty-file case.' })
    await L.waitFor('a to finish that turn', async () => (await L.statusOf(page, 'a')) === 'idle' && (await L.snapshot(page, 'a')).includes('GOT:'), 15000).catch(() => {})
    await L.sleep(1500)
    const t2 = Date.now()
    const between = await rpc(profile, 'lead', 'wait', { nodes: ['a', 'b'], next: true, timeout: 20 })
    c.check('A turn that ended between two --next calls is the next one\'s answer, at once', between.json.result?.next?.node === 'a' && between.json.result?.next?.why === 'finished' && Date.now() - t2 < 2000, { ms: Date.now() - t2, r: between.json })
    const again = await rpc(profile, 'lead', 'wait', { nodes: ['a', 'b'], next: true, timeout: 3 })
    c.check('...and is not handed out again', again.json.result?.timedOut === true, again.json)

    const team = await cli(profile, ['team'])
    c.check('team prints one line per member it opened', team.code === 0 && /Agents you opened \(2\):/.test(team.stdout) && /- Alpha \[a\] idle/.test(team.stdout) && /- Beta \[b\] idle/.test(team.stdout), team)

    // A team whose last member closes takes its group with it. Opening into that group fails plainly.
    const made = await cli(profile, ['spawn-team', '--label', 'Short-lived', '--members', '[{"name":"solo","prompt":"turns"}]'])
    const ids = JSON.parse(made.stdout || '{}')
    await L.waitFor('the solo member', async () => (await L.statusOf(page, ids.members?.solo)) === 'idle', 40000).catch(() => {})
    const closed = await cli(profile, ['close', '--node', ids.members?.solo ?? 'x'])
    c.check('Closing the last member removes its group', closed.code === 0 && JSON.parse(closed.stdout).removedGroup === ids.group, closed)
    const before = (await L.doc(page)).nodes.length
    const gone = await cli(profile, ['open-agent', '--group', ids.group ?? 'x', '--prompt', 'turns', '--title', 'Late reviewer'])
    c.check('open-agent --group <gone group> exits 1 and says on stderr the group is gone', gone.code === 1 && gone.stdout === '' && /is gone: it was removed when its last member, "solo", closed\. Nothing was created\./.test(gone.stderr), gone)
    await L.sleep(500)
    c.check('...and nothing was created', (await L.doc(page)).nodes.length === before)
    console.log('SHOT', await L.shot(page, 'r4-lead'))
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
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
