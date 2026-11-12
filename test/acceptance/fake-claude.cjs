'use strict'
// Stands in for the `claude` program in UI checks, so showing every status costs no plan quota. It runs in a real
// session and reports through Patchbay's real hook and status line scripts, so everything after that is the real path.
//
// Set it as the Claude command in settings.json. The prompt picks a status: needs, working, idle, unknown or exit.
// A "context=NN" word in the prompt also reports that context %, and "permission" asks to run a long command.
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const args = process.argv.slice(2)

// Name with AI asks for one answer and exits. This records what it was asked, so a check can read that back.
if (args.includes('-p')) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    const log = process.env.FAKE_TITLE_LOG
    if (log) fs.writeFileSync(log, JSON.stringify({ args, cwd: process.cwd(), input, safe: args.includes('--safe-mode') }))
    process.stdout.write(/fail-naming/.test(input) ? '' : '"Pretend title"\n')
    process.exit(/fail-naming/.test(input) ? 3 : 0)
  })
  return
}
const after = (flag) => args[args.indexOf(flag) + 1]
const settings = JSON.parse(fs.readFileSync(after('--settings'), 'utf8'))
const prompt = args.includes('--') ? args[args.indexOf('--') + 1] : ''
const sessionId = args.includes('--session-id') ? after('--session-id') : after('--resume')

const quoted = (command) => command.match(/"([^"]+)"/)[1]

// Longer than a node is wide, with the part that matters at the far end.
const LONG_COMMAND = `for f in ${['api', 'auth', 'billing', 'canvas', 'sessions', 'settings', 'updates'].map((d) => `src/${d}/**/*.test.ts`).join(' ')}; do npx vitest run "$f" --reporter=dot || break; done && git add -A && git commit -m "Fix the login redirect" && git push --force origin main`

function runScript(script, argv, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...argv], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('exit', resolve)
    child.on('error', resolve)
    child.stdin.end(JSON.stringify(payload))
  })
}

const hook = (name, extra = {}) => {
  const entry = settings.hooks[name][0].hooks[0]
  return runScript(quoted(entry.command), [name], { hook_event_name: name, session_id: sessionId, transcript_path: '', ...extra })
}

// With "chat" in the prompt it keeps a transcript in Claude's format, so a chat view has a conversation to show.
const chat = /\bchat\b/.test(prompt)
const transcript = chat ? require('node:path').join(require('node:os').tmpdir(), `pb-fake-${sessionId}.jsonl`) : ''
const say = (type, text) =>
  fs.appendFileSync(transcript, `${JSON.stringify({ type, isSidechain: false, message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } })}\n`)

async function main() {
  process.stdout.write(`Pretend Claude. Prompt: ${prompt || '(none)'}\r\n`)
  if (chat) fs.writeFileSync(transcript, '')
  await hook('SessionStart', { source: 'startup', ...(chat ? { transcript_path: transcript } : {}) })
  const context = /context=(\d+)/.exec(prompt)
  if (context && settings.statusLine) {
    await runScript(quoted(settings.statusLine.command), [], { session_id: sessionId, context_window: { used_percentage: Number(context[1]) } })
  }
  if (/\bneeds\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    await hook('Notification', { notification_type: 'permission_prompt' })
  } else if (/\bpermission\b/.test(prompt)) {
    // Asks to run a long command, and isn't waited for: the request is held until someone answers it.
    await hook('UserPromptSubmit')
    void hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: LONG_COMMAND } })
  } else if (/\bworking\b/.test(prompt)) {
    await hook('UserPromptSubmit')
  } else if (/\bunknown\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    await hook('StopFailure')
  } else if (/\bexit\b/.test(prompt)) {
    process.exit(0)
  }
  // Left idle otherwise, and it stays open, echoing what's typed, like a program waiting for input.
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => process.stdout.write(d))
  // With "turns" in the prompt, each submitted line is a turn: "busy" starts one and leaves it running, "done" ends
  // it, and anything else is a prompt it reports, then finishes a moment later. That's what idle gating needs.
  if (/\bturns\b/.test(prompt)) {
    let line = ''
    process.stdin.on('data', (d) => {
      for (const ch of d) {
        if (ch !== '\r') {
          line += ch
          continue
        }
        const said = line.trim()
        line = ''
        if (said === 'busy') void hook('UserPromptSubmit')
        else if (said === 'done') void hook('Stop')
        else {
          process.stdout.write(`\r\nGOT: ${said}\r\n`)
          void hook('UserPromptSubmit').then(() => setTimeout(() => void hook('Stop'), 500))
        }
      }
    })
  }
  if (chat) {
    let line = ''
    process.stdin.on('data', (d) => {
      for (const ch of d) {
        if (ch !== '\r') {
          line += ch
          continue
        }
        const said = line.trim()
        line = ''
        if (!said) continue
        say('user', said)
        void hook('UserPromptSubmit').then(() => {
          say('assistant', `You said: **${said.split('\n')[0]}**\n\n- one\n- two\n\n[a link](missing-notes.md)`)
          setTimeout(() => void hook('Stop'), 300)
        })
      }
    })
  }
  process.stdin.resume()
  setInterval(() => {}, 60000)
}

main().catch((e) => {
  process.stdout.write(`Pretend Claude failed: ${e.message}\r\n`)
})
