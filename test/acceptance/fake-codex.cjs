'use strict'
// Stands in for the `codex` program, so Codex's states can be checked through the real app with no quota. It replays
// what a live Codex 0.170 wrote and sent (test/fixtures/codex-0.170, recorded by codex-states-real.cjs): rollout lines,
// written as it goes, and hook payloads, run through the hook commands Patchbay passes with -c, as Codex runs them.
//
// Set it as the Codex command in settings.json. The prompt picks a scenario:
//   ok        a turn that answers "ready" (Stop)
//   fail      a turn that fails on an unknown model: task_complete carries the error, and no Stop hook comes
//   usage     the same with a usage limit, after limits that say the 5-hour window is full
//   esc       a turn that runs until Esc, then turn_aborted and the Interrupt hook
//   subagent  a turn that spawns one subagent (SubagentStart / SubagentStop and its forked rollout), then Stop
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
// Patchbay asks whether this Codex knows --no-daemon.
if (args.includes('--help')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run without the shared server\n')
  process.exit(0)
}

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'codex-0.170')
const lines = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const realHooks = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hooks.json'), 'utf8'))

/** The hook commands Patchbay passed: `-c hooks.<Event>=[{hooks=[{type="command",command="..."}]}]`. */
const hookCommands = {}
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] !== '-c') continue
  const m = /^hooks\.(\w+)=.*command=("(?:[^"\\]|\\.)*")/.exec(args[i + 1])
  if (m) hookCommands[m[1]] = JSON.parse(m[2])
}
const prompt = args.includes('--') ? args[args.indexOf('--') + 1] : ''
const resumed = args[0] === 'resume'
const scenario = (/\b(ok|fail|usage|esc|subagent)\b/.exec(prompt) ?? [, 'ok'])[1]

const sessionId = resumed ? args[args.length - 1] : crypto.randomUUID()
const day = new Date().toISOString().slice(0, 10).split('-')
// PB_FAKE_CODEX_DIR keeps its rollouts where the check that started it can remove them.
const sessions = path.join(process.env.PB_FAKE_CODEX_DIR || os.tmpdir(), `pb-fake-codex-${sessionId}`, 'sessions')
const dayDir = path.join(sessions, ...day)
fs.mkdirSync(dayDir, { recursive: true })
const stamp = () => new Date().toISOString()
const rolloutOf = (id) => path.join(dayDir, `rollout-${stamp().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
const rollout = rolloutOf(sessionId)
const turnId = crypto.randomUUID()

/** A recorded line as now: this session's ids and the time it's written. */
function write(file, line) {
  const j = JSON.parse(JSON.stringify(line))
  j.timestamp = stamp()
  if (j.payload && typeof j.payload === 'object') {
    if ('turn_id' in j.payload) j.payload.turn_id = turnId
    if ('thread_id' in j.payload) j.payload.thread_id = sessionId
  }
  fs.appendFileSync(file, `${JSON.stringify(j)}\n`)
}

function hook(name, extra = {}) {
  const command = hookCommands[name]
  if (!command) return Promise.resolve()
  const base = realHooks[name] ?? { hook_event_name: name }
  const payload = { ...base, session_id: sessionId, transcript_path: rollout, cwd: process.cwd(), ...(base.turn_id ? { turn_id: turnId } : {}), ...extra }
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('exit', resolve)
    child.on('error', resolve)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const show = (text) => process.stdout.write(`${text}\r\n`)
const recorded = (name, type) => lines(name).find((l) => l.payload?.type === type)
const userItem = (text) => {
  const l = JSON.parse(JSON.stringify(recorded('live-session.jsonl', 'item_completed')))
  l.payload.item = { ...l.payload.item, content: [{ type: 'text', text, text_elements: [] }] }
  return l
}
const agentItem = (text) => {
  const l = JSON.parse(JSON.stringify(lines('live-session.jsonl').find((x) => x.payload?.item?.type === 'AgentMessage')))
  l.payload.item.content = [{ type: 'Text', text }]
  return l
}

async function turn() {
  show(`› ${prompt}`)
  await hook('UserPromptSubmit', { prompt })
  write(rollout, recorded('live-session.jsonl', 'task_started'))
  write(rollout, userItem(prompt))
  await sleep(1500)
  if (scenario === 'ok') {
    write(rollout, agentItem('ready'))
    write(rollout, recorded('live-session.jsonl', 'token_count'))
    write(rollout, recorded('live-session.jsonl', 'task_complete'))
    show('• ready')
    await hook('Stop', { last_assistant_message: 'ready' })
  } else if (scenario === 'fail' || scenario === 'usage') {
    const done = JSON.parse(JSON.stringify(recorded('failed-turn.jsonl', 'task_complete')))
    if (scenario === 'usage') {
      const limits = JSON.parse(JSON.stringify(recorded('live-session.jsonl', 'token_count')))
      limits.payload.rate_limits.primary.used_percent = 100
      limits.payload.rate_limits.primary.resets_at = Math.floor(Date.now() / 1000) + 2 * 3600
      limits.payload.rate_limits.rate_limit_reached_type = 'rate_limit_reached'
      write(rollout, limits)
      done.payload.error = { message: "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.", codex_error_info: 'usage_limit_exceeded' }
    }
    write(rollout, done)
    show(`■ ${done.payload.error.message}`)
    // No Stop hook: 0.170 sends none after a failed turn.
  } else if (scenario === 'esc') {
    show('• Working (esc to interrupt)')
    await new Promise((resolve) => {
      process.stdin.on('data', (d) => {
        if (String(d).includes('\x1b')) resolve()
      })
    })
    write(rollout, recorded('live-session.jsonl', 'turn_aborted'))
    show('■ Conversation interrupted')
    await hook('Interrupt')
  } else if (scenario === 'subagent') {
    const childId = crypto.randomUUID()
    const child = rolloutOf(childId)
    await hook('SubagentStart', { agent_id: childId })
    for (const l of lines('subagent-child.jsonl')) write(child, l)
    await sleep(1500)
    await hook('SubagentStop', { agent_id: childId, agent_transcript_path: child, last_assistant_message: 'pong' })
    write(rollout, agentItem('pong'))
    write(rollout, recorded('live-session.jsonl', 'task_complete'))
    show('• pong')
    await hook('Stop', { last_assistant_message: 'pong' })
  }
  show('› ')
}

async function main() {
  try { process.stdin.setRawMode?.(true) } catch {}
  process.stdin.resume()
  fs.writeFileSync(rollout, '')
  write(rollout, { type: 'session_meta', payload: { id: sessionId, cli_version: '0.170.0', source: 'cli' } })
  await hook('SessionStart', { source: resumed ? 'resume' : 'startup' })
  show('>_ OpenAI Codex (fake, replaying 0.170)')
  if (prompt && !resumed) await turn()
  // Stays at its prompt, as Codex does, until the session ends.
  setInterval(() => {}, 1 << 30)
}

main()
