'use strict'
// Prints what Claude Code prints while it works hard, for load tests: no quota spent. Claude Code redraws the bottom
// of the screen many times a second, a spinner and status line and its input box, wrapped in synchronized-output
// marks, and erases the lines it drew last time first. Finished messages and tool output are printed above that and
// stay in the scrollback. All of it in truecolor.
//
// Run: node claude-load.cjs [seconds] [--heavy]
//
// Set as the Claude command in settings.json, it stands in for Claude itself, with its prompt as those arguments
// ("60 heavy"). It then also does the rest of what Claude does while it works, the way Claude Code does it on Windows:
// it runs Patchbay's status line each time its output changes, at most every 300 ms, and Patchbay's hooks before and
// after each tool call, each through Git Bash, and it writes its conversation to a transcript as it goes.
// PB_LOAD_TRANSCRIPT_MB starts that transcript off at about that size, as a long conversation would be.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const asClaude = argv.includes('--settings')
const words = asClaude ? (argv.includes('--') ? argv[argv.indexOf('--') + 1] : '').split(/\s+/) : argv
const seconds = Number(words.find((w) => /^\d+$/.test(w)) || 60)
const heavy = words.includes('--heavy') || words.includes('heavy')
const FRAME_MS = heavy ? 30 : 60
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']
const WORDS = 'the session host keeps every terminal running while the window redraws its canvas and each agent streams its answer'.split(' ')

const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`
const RESET = '\x1b[0m'
const out = (s) => process.stdout.write(s)
const cols = () => process.stdout.columns || 100
let drawn = 0
let tick = 0
let tokens = 0
const started = Date.now()

const sentence = (n) => Array.from({ length: n }, (_, i) => WORDS[(tick * 7 + i * 3) % WORDS.length]).join(' ')

/** The part that's redrawn each frame: what's streaming in, the spinner line and the input box. */
function frame() {
  const width = Math.max(20, cols() - 2)
  const lines = []
  const streaming = heavy ? 14 : 6
  for (let i = 0; i < streaming; i++) lines.push(`  ${rgb(150, 150, 160)}${sentence(4 + ((tick + i) % 9)).slice(0, width - 4)}${RESET}`)
  const elapsed = Math.round((Date.now() - started) / 1000)
  lines.push(`${rgb(215, 119, 87)}${SPIN[tick % SPIN.length]} Working… ${RESET}${rgb(120, 120, 130)}(${elapsed}s · ↓ ${tokens} tokens · esc to interrupt)${RESET}`)
  lines.push('')
  lines.push(`${rgb(80, 80, 90)}╭${'─'.repeat(width - 2)}╮${RESET}`)
  lines.push(`${rgb(80, 80, 90)}│${RESET} > ${' '.repeat(Math.max(0, width - 5))}${rgb(80, 80, 90)}│${RESET}`)
  lines.push(`${rgb(80, 80, 90)}╰${'─'.repeat(width - 2)}╯${RESET}`)
  lines.push(`  ${rgb(100, 100, 110)}? for shortcuts${RESET}`)
  return lines
}

function draw(above = []) {
  let s = '\x1b[?2026h'
  // Back over what was drawn last time, erasing it, as Ink does.
  for (let i = 0; i < drawn; i++) s += '\x1b[2K' + (i < drawn - 1 ? '\x1b[1A' : '')
  s += '\r'
  for (const line of above) s += `${line}\r\n`
  const lines = frame()
  s += lines.join('\r\n')
  s += '\x1b[?2026l'
  drawn = lines.length
  out(s)
}

// What Claude does besides drawing, when this stands in for it.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const after = (flag) => argv[argv.indexOf(flag) + 1]
const settings = asClaude ? JSON.parse(fs.readFileSync(after('--settings'), 'utf8')) : null
const sessionId = asClaude ? (argv.includes('--session-id') ? after('--session-id') : after('--resume')) : ''
const transcript = asClaude ? path.join(os.tmpdir(), `pb-load-${sessionId}.jsonl`) : ''
let toolCalls = 0
let statusLines = 0

/** Runs a configured command the way Claude Code does on Windows: through Git Bash, with the event on stdin. */
function runCommand(command, payload) {
  return new Promise((resolve) => {
    const child = fs.existsSync(GIT_BASH) ? spawn(GIT_BASH, ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }) : spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('exit', resolve)
    child.on('error', resolve)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}
const hook = (name, extra = {}) => {
  const entry = settings.hooks?.[name]?.[0]?.hooks?.[0]
  return entry ? runCommand(entry.command, { hook_event_name: name, session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), ...extra }) : Promise.resolve()
}
const say = (type, text) => fs.appendFileSync(transcript, `${JSON.stringify({ type, isSidechain: false, message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } })}\n`)

async function behaveLikeClaude() {
  const mb = Number(process.env.PB_LOAD_TRANSCRIPT_MB || 0)
  const filler = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { text: 'x'.repeat(4000) } }] } })
  fs.writeFileSync(transcript, mb ? `${filler}\n`.repeat(Math.ceil((mb * 1024 * 1024) / filler.length)) : '')
  await hook('SessionStart', { source: 'startup' })
  say('user', 'Work hard')
  await hook('UserPromptSubmit')
  const end = Date.now() + seconds * 1000
  // The status line, each time the output changes, at most every 300 ms, and never two at once.
  void (async () => {
    while (Date.now() < end) {
      const t = Date.now()
      if (settings.statusLine?.command && !process.env.PB_LOAD_NO_STATUSLINE) {
        await runCommand(settings.statusLine.command, { session_id: sessionId, transcript_path: transcript, cost: { total_cost_usd: tokens / 1e5 }, context_window: { used_percentage: Math.min(99, Math.round(tokens / 2000)) } })
        statusLines++
      }
      await new Promise((r) => setTimeout(r, Math.max(0, 300 - (Date.now() - t))))
    }
  })()
  // Tool calls, one after another, each with a hook before and after.
  while (Date.now() < end) {
    await hook('PreToolUse', { tool_name: 'Bash' })
    await new Promise((r) => setTimeout(r, heavy ? 400 : 1200))
    await hook('PostToolUse', { tool_name: 'Bash' })
    toolCalls++
    say('assistant', `Ran a tool. ${sentence(12)}`)
  }
  await hook('Stop')
}

out('\x1b[?25l')
if (asClaude) void behaveLikeClaude().catch((e) => out(`\r\nload failed: ${e.message}\r\n`))
const timer = setInterval(() => {
  tick++
  tokens += 17 + (tick % 13)
  const above = []
  // A finished message every so often, and now and then a long tool result.
  if (tick % (heavy ? 4 : 8) === 0) above.push(`${rgb(98, 220, 138)}●${RESET} ${sentence(10 + (tick % 12))}`)
  if (tick % (heavy ? 25 : 60) === 0) {
    above.push(`${rgb(127, 168, 255)}●${RESET} Bash(npm test)`)
    for (let i = 0; i < (heavy ? 120 : 40); i++) above.push(`  ⎿  ${rgb(160, 160, 170)}✓ test/case-${tick}-${i}.test.ts ${sentence(5)}${RESET}`)
  }
  draw(above)
  if (Date.now() - started > seconds * 1000) {
    clearInterval(timer)
    out(`\r\n\x1b[?25h${RESET}LOAD-DONE tools=${toolCalls} statuslines=${statusLines}\r\n`)
    // As Claude does, it stays open for the next prompt.
    if (asClaude) process.stdin.resume()
  }
}, FRAME_MS)
