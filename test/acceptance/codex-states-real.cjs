'use strict'
// Codex's states against what a real Codex emits: working/idle, needs-you (an approval), Esc (Interrupt), a subagent,
// and two failures that spend no quota (a model name the API doesn't know, and no route to the API). Spends a little
// Codex quota on its smallest model at low reasoning; none of Claude's.
//
// Codex runs with a temporary CODEX_HOME holding a copy of the owner's sign-in, so their ~/.codex is never written. A
// tap hook in that home records each hook's raw payload, and each node's rollout is copied, into PB_CODEX_TAP (default:
// a new temp folder, printed), for comparing with test/fixtures/codex. Throwaway profiles; off-screen windows.
// Run after npm run build:  node test/acceptance/codex-states-real.cjs [phase ...]   phases: live, subagent, bad-model, offline
const fs = require('fs')
const os = require('os')
const path = require('path')
const L = require('./lib.cjs')

const c = L.checker()
const MODEL = process.env.PB_CODEX_MODEL || 'gpt-6-luna'
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PreCompact', 'PostCompact']
const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['live', 'subagent', 'bad-model', 'offline']

const tapDir = process.env.PB_CODEX_TAP || fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-tap-'))
fs.mkdirSync(tapDir, { recursive: true })
const tapScript = path.join(tapDir, 'tap.cjs')
fs.writeFileSync(tapScript, `'use strict'
const fs = require('fs')
let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let payload
  try { payload = JSON.parse(raw) } catch { payload = raw }
  fs.appendFileSync(${JSON.stringify(path.join(tapDir, 'hooks.jsonl'))}, JSON.stringify({ at: Date.now(), event: process.argv[2], node: process.env.PATCHBAY_NODE_ID || null, payload }) + '\\n')
  process.exit(0)
})
`)

function codexHome(model) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-home-'))
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(home, 'auth.json'))
  fs.writeFileSync(path.join(home, 'config.toml'), `model = ${JSON.stringify(model)}\nmodel_reasoning_effort = "low"\n`)
  const command = (event) => `node "${tapScript.replace(/\\/g, '/')}" ${event}`
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: command(e) }] }]])) }, null, 2))
  return home
}

/** The rollout and any child rollouts Codex wrote beside it, copied for the record. */
function keepRollouts(home, label) {
  const sessions = path.join(home, 'sessions')
  if (!fs.existsSync(sessions)) return []
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) {
        const to = path.join(tapDir, `${label}-${e.name}`)
        fs.copyFileSync(p, to)
        out.push(to)
      }
    }
  }
  walk(sessions)
  return out
}

const stripAnsi = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

async function withApp({ home, env, label }, body) {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  // Outside any git repository, because Codex trusts a whole repository at once.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-codex-work-'))
  const app = await L.launch({ profile, realHome: true, env: { CODEX_HOME: home, ...env } })
  const { page } = app
  const text = async (id) => (await L.screen(page, id)).join('\n')
  const tail = async (id, n = 14) => (await text(id)).split('\n').filter((l) => l.trim()).slice(-n).join('\n')
  /** Codex asks once to trust new hooks, the folder, and (new CODEX_HOME) about its sandbox. Answered here. */
  const answerSetup = async (id) => {
    const s = await text(id)
    if (/Trust this folder\?|Do you trust the contents/.test(s)) {
      await L.input(page, id, '\r')
      await L.sleep(1500)
    } else if (/Trust all and continue/.test(s) || /non-admin sandbox/.test(s)) {
      await L.input(page, id, '2')
      await L.sleep(300)
      await L.input(page, id, '\r')
      await L.sleep(1500)
    }
  }
  const allowAll = async (id, log) => {
    for (const a of await L.approvals(page, id)) {
      log?.push({ status: await L.statusOf(page, id), tool: a.tool, summary: a.summary })
      await page.evaluate((r) => window.patchbay.answerApproval(r, 'allow'), a.requestId)
    }
  }
  const stops = () => page.evaluate(() => window.patchbayStops.all())
  try {
    await body({ page, cwd, text, tail, answerSetup, allowAll, stops, app })
  } finally {
    console.log(`ROLLOUTS ${label}:`, keepRollouts(home, label).map((p) => path.basename(p)).join(', '))
    await app.quit().catch(() => {})
    L.cleanup(profile)
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}

async function live(home) {
  await withApp({ home, label: 'live' }, async ({ page, cwd, tail, answerSetup, allowAll, stops }) => {
    await L.openNode(page, L.claude('cx', cwd, 0, 0, { agent: 'codex', title: 'Codex', width: 760, height: 460, prompt: 'Reply with just the word ready.' }))
    const first = await L.waitFor('the first turn', async () => {
      await answerSetup('cx')
      const seen = await L.seenStatuses(page, 'cx')
      return seen.includes('working') && (await L.statusOf(page, 'cx')) === 'idle' ? seen : null
    }, 150000, 1000).catch(async (e) => `${e.message}\n${await tail('cx')}`)
    c.check('working, then idle', Array.isArray(first), first)

    // needs-you: a canvas change through the patchbay tool comes to the person.
    const asked = []
    await L.submit(page, 'cx', 'Call the patchbay tool with args ["sticky", "--text", "codex states"] and reply with only the word done.')
    await L.waitFor('the note', async () => {
      await answerSetup('cx')
      await allowAll('cx', asked)
      const d = await L.doc(page)
      return d.nodes.some((n) => n.kind === 'sticky' && n.text === 'codex states') && (await L.statusOf(page, 'cx')) === 'idle'
    }, 150000, 1000).catch(async (e) => console.log(e.message, '\n', await tail('cx')))
    c.check('an approval shows as needs-you, with buttons', asked[0]?.status === 'needs-you', asked)

    // Esc while it writes.
    const before = (await L.seenStatuses(page, 'cx')).length
    await L.submit(page, 'cx', 'Write a 1500-word story about a lighthouse keeper. No tools.')
    await L.waitFor('it to be working', async () => (await L.statusOf(page, 'cx')) === 'working', 60000, 300).catch(() => {})
    await L.sleep(2500)
    const pressedAt = Date.now()
    await L.input(page, 'cx', '\x1b')
    const afterEsc = await L.waitFor('idle after Esc', async () => ((await L.statusOf(page, 'cx')) === 'idle' ? Date.now() - pressedAt : null), 30000, 200).catch(async (e) => `${e.message}\n${await tail('cx')}`)
    console.log('STATUSES after Esc', JSON.stringify((await L.seenStatuses(page, 'cx')).slice(before)))
    c.check('Esc: idle (Interrupt)', typeof afterEsc === 'number', afterEsc)
    console.log('SCREEN after Esc:\n' + (await tail('cx', 8)))
    // What `patchbay read` gives for this node: the conversation, from the rollout.
    const read = await page.evaluate(() => window.patchbay.getDoc().then((d) => d.nodes.find((n) => n.id === 'cx')))
    const messages = await page.evaluate((id) => window.patchbay.readConversation?.(id), 'cx').catch(() => null)
    console.log('CONVERSATION', JSON.stringify(messages)?.slice(0, 600), read.transcriptPath)
    console.log('STOPS', JSON.stringify(await stops()))
  })
}

async function subagent(home) {
  await withApp({ home, label: 'subagent' }, async ({ page, cwd, tail, answerSetup, allowAll }) => {
    // Codex spawns subagents only when asked to, and with Patchbay's guide it reaches for `patchbay open-agent`
    // unless told otherwise.
    const prompt = 'Do not use the patchbay tool. Use your collaboration spawn_agent tool to start one sub-agent whose whole task is: reply with the single word pong. Wait for it with wait_agent, then reply with just its answer.'
    await L.openNode(page, L.claude('cx', cwd, 0, 0, { agent: 'codex', title: 'Codex', width: 760, height: 460, prompt }))
    const cards = []
    const sub = await L.waitFor('the subagent turn', async () => {
      await answerSetup('cx')
      await allowAll('cx')
      const snap = await page.evaluate(() => window.patchbaySubagents.get()).catch(() => null)
      const mine = snap?.cx?.cards ?? []
      if (mine.length) cards.push({ at: Date.now(), cards: JSON.parse(JSON.stringify(mine)) })
      const seen = await L.seenStatuses(page, 'cx')
      return (await L.statusOf(page, 'cx')) === 'idle' && seen.includes('working') && /pong/i.test(await tail('cx', 6)) ? true : null
    }, 180000, 1000).catch(async (e) => `${e.message}\n${await tail('cx')}`)
    c.check('the subagent turn finishes', sub === true, sub)
    fs.writeFileSync(path.join(tapDir, 'subagent-cards.json'), JSON.stringify(cards, null, 2))
    c.check('a subagent card was shown', cards.length > 0, cards.at(-1))
    c.check('the card ended done', cards.at(-1)?.cards?.every((x) => x.status === 'done'), cards.at(-1))
    console.log('STATUSES subagent', JSON.stringify(await L.seenStatuses(page, 'cx')))
    console.log('SHOT', await L.shot(page, 'codex-live-subagent'))
  })
}

async function failure(home, label, env, expectKind) {
  await withApp({ home, env, label }, async ({ page, cwd, tail, answerSetup, stops }) => {
    await L.openNode(page, L.claude('cx', cwd, 0, 0, { agent: 'codex', title: 'Codex', width: 760, height: 460, prompt: 'Reply with just the word ready.' }))
    let lastStops = null
    const ended = await L.waitFor(`a stop for ${label}`, async () => {
      await answerSetup('cx')
      lastStops = await stops()
      return lastStops?.cx ? lastStops.cx : null
    }, 240000, 1500).catch(async (e) => `${e.message}\n${await tail('cx')}`)
    console.log(`STATUSES ${label}`, JSON.stringify(await L.seenStatuses(page, 'cx')), 'now', await L.statusOf(page, 'cx'))
    console.log(`SCREEN ${label}:\n${await tail('cx', 10)}`)
    c.check(`${label}: Patchbay records a stop`, typeof ended === 'object', ended)
    if (expectKind) c.check(`${label}: of kind ${expectKind}`, ended?.kind === expectKind, ended)
    c.check(`${label}: status unknown`, (await L.statusOf(page, 'cx')) === 'unknown', await L.statusOf(page, 'cx'))
    console.log('SHOT', await L.shot(page, `codex-live-${label}`))
  })
}

async function offline(home) {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
  await withApp({ home, env, label: 'offline' }, async ({ page, cwd, tail, answerSetup }) => {
    await L.openNode(page, L.claude('cx', cwd, 0, 0, { agent: 'codex', title: 'Codex', width: 760, height: 460, prompt: 'Reply with just the word ready.' }))
    const status = await L.waitFor('Codex to give up', async () => {
      await answerSetup('cx')
      const s = await L.statusOf(page, 'cx')
      return s === 'exited' || s === 'unknown' ? s : null
    }, 240000, 1500).catch((e) => e.message)
    const screen = await tail('cx', 10)
    console.log(`STATUSES offline`, JSON.stringify(await L.seenStatuses(page, 'cx')))
    console.log(`SCREEN offline:\n${screen}`)
    c.check('offline: the node shows exited, with Codex\'s reason on its screen', status === 'exited' && /failed/i.test(screen), status)
    console.log('SHOT', await L.shot(page, 'codex-live-offline'))
  })
}

async function main() {
  console.log('TAP', tapDir)
  const homes = []
  try {
    for (const phase of phases) {
      if (phase === 'live') {
        const h = codexHome(MODEL)
        homes.push(h)
        await live(h)
      } else if (phase === 'subagent') {
        const h = codexHome(MODEL)
        homes.push(h)
        await subagent(h)
      } else if (phase === 'bad-model') {
        const h = codexHome('pb-no-such-model')
        homes.push(h)
        await failure(h, 'bad-model', {}, 'error')
      } else if (phase === 'offline') {
        const h = codexHome(MODEL)
        homes.push(h)
        // Nothing listens on port 9. 0.170 can't read the account at start-up and quits before any turn ("account/read
        // failed: workspace routing discovery failed"), so this is an exit, not a failed turn.
        await offline(h)
      }
    }
  } finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
