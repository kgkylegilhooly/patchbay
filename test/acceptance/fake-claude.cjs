'use strict'
// Stands in for the `claude` program in UI checks, so showing every status costs no plan quota. It runs in a real
// session and reports through Patchbay's real hook and status line scripts, so everything after that is the real path.
//
// Set it as the Claude command in settings.json. The prompt picks a status: needs, working, idle, unknown or exit.
// A "context=NN" word in the prompt also reports that context %, and "permission" asks to run a long command.
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const args = process.argv.slice(2)

// Patchbay asks which Claude Code this is, to know whether it can start a hook's program directly (exec form).
if (args[0] === '--version') {
  if (process.env.FAKE_VERSION_LOG) fs.appendFileSync(process.env.FAKE_VERSION_LOG, 'asked\n')
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION || '2.1.330'} (Claude Code)\n`)
  process.exit(0)
}

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


// Longer than a node is wide, with the part that matters at the far end.
const LONG_COMMAND = `for f in ${['api', 'auth', 'billing', 'canvas', 'sessions', 'settings', 'updates'].map((d) => `src/${d}/**/*.test.ts`).join(' ')}; do npx vitest run "$f" --reporter=dot || break; done && git add -A && git commit -m "Fix the login redirect" && git push --force origin main`

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

/**
 * Runs a configured command as Claude Code does on Windows, with the event on stdin: with `args`, the program itself
 * and no shell (exec form); otherwise the line through Git Bash.
 */
function runCommand(command, payload, execArgs) {
  return new Promise((resolve) => {
    const child = execArgs
      ? spawn(command, execArgs, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      : fs.existsSync(GIT_BASH)
      ? spawn(GIT_BASH, ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      : spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('exit', resolve)
    child.on('error', resolve)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * Posts an http hook as Claude Code 2.1.330 does: the event as the JSON body, headers with `$VAR` / `${VAR}` taken
 * from the environment only for names in allowedEnvVars (others become empty), cancelled at its timeout. Resolves to
 * the status, or -1 when it couldn't connect or was cancelled, and the answer's body.
 *
 * Like 2.1.330, it goes through HTTPS_PROXY / HTTP_PROXY unless the URL's host is listed, exactly, in NO_PROXY:
 * `localhost` doesn't cover 127.0.0.1. Through a proxy it asks for a tunnel (CONNECT), as Claude does.
 */
function postHook(entry, payload) {
  const http = require('node:http')
  const allowed = new Set(entry.allowedEnvVars ?? [])
  const fill = (v) => String(v).replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => (allowed.has(a ?? b) ? (process.env[a ?? b] ?? '') : ''))
  const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, fill(v)]))
  const body = JSON.stringify(payload)
  const env = (name) => process.env[name] ?? process.env[name.toLowerCase()]
  const proxy = env('HTTPS_PROXY') || env('HTTP_PROXY')
  const target = new URL(entry.url)
  const bypass = (env('NO_PROXY') ?? '').split(',').map((h) => h.trim()).includes(target.hostname)
  if (proxy && !bypass) {
    const via = new URL(proxy)
    return new Promise((resolve) => {
      const req = http.request({ host: via.hostname, port: via.port, method: 'CONNECT', path: `${target.hostname}:${target.port}` })
      req.on('connect', (res, socket) => {
        socket.destroy()
        resolve({ code: res.statusCode === 200 ? -2 : -1, answer: '', proxied: true })
      })
      req.on('response', () => resolve({ code: -1, answer: '', proxied: true }))
      req.on('error', () => resolve({ code: -1, answer: '', proxied: true }))
      req.end()
    })
  }
  return new Promise((resolve) => {
    const req = http.request(entry.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: (entry.timeout ?? 600) * 1000 }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ code: res.statusCode, answer: text }))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve({ code: -1, answer: '' }))
    req.end(body)
  })
}

const hook = (name, extra = {}) => {
  const entry = settings.hooks[name]?.[0]?.hooks?.[0]
  if (!entry) return Promise.resolve()
  const started = Date.now()
  // As Claude does, UserPromptSubmit says what was asked, when the prompt gives one with ask= (underscores for spaces).
  const said = name === 'UserPromptSubmit' && asked ? { prompt: asked } : {}
  const payload = { hook_event_name: name, session_id: sessionId, transcript_path: '', ...said, ...extra }
  if (entry.type === 'http') {
    return postHook(entry, payload).then(({ code, answer, proxied }) => {
      const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
      if (process.env.FAKE_HOOK_LOG) fs.appendFileSync(process.env.FAKE_HOOK_LOG, `${JSON.stringify({ node: process.env.PATCHBAY_NODE_ID, name, form: 'http', code, answer, ms: Date.now() - started, at: Date.now(), timeout: entry.timeout, proxied: !!proxied, noProxy })}\n`)
      return code === 200 ? 0 : 1
    })
  }
  return runCommand(entry.command, payload, entry.args).then((code) => {
    // Which way each hook ran and how long it took, for a check to read back.
    if (process.env.FAKE_HOOK_LOG) fs.appendFileSync(process.env.FAKE_HOOK_LOG, `${JSON.stringify({ node: process.env.PATCHBAY_NODE_ID, name, form: entry.args ? 'exec' : 'shell', code, ms: Date.now() - started, at: Date.now(), timeout: entry.timeout })}\n`)
    return code
  })
}

// With "chat" in the prompt it keeps a transcript in Claude's format, so a chat view has a conversation to show.
// "edits=a.ts,b.ts" also keeps one, and runs a turn that edits those files in its folder. See editTurn.
const edits = /\bedits=(\S+)/.exec(prompt)?.[1].split(',').filter(Boolean) ?? null
// In that turn, "writes=x,y" changes files with no edit call, as a shell command would, and "subedits=z" edits files
// through a pretend subagent, whose transcript is written where Claude Code writes one.
const writes = /\bwrites=(\S+)/.exec(prompt)?.[1].split(',').filter(Boolean) ?? []
const subedits = /\bsubedits=(\S+)/.exec(prompt)?.[1].split(',').filter(Boolean) ?? []
const chat = /\bchat\b/.test(prompt) || !!edits
const asked = /\bask=(\S+)/.exec(prompt)?.[1].replace(/_/g, ' ') ?? null
// "fanout=N" starts N pretend subagents, written where Claude Code writes them. See fanOut below.
const fanout = Number(/\bfanout=(\d+)/.exec(prompt)?.[1] ?? 0)
const transcript = chat || fanout ? require('node:path').join(require('node:os').tmpdir(), `pb-fake-${sessionId}.jsonl`) : ''
const say = (type, text) =>
  fs.appendFileSync(transcript, `${JSON.stringify({ type, isSidechain: false, message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } })}\n`)

const AGENT_TASKS = [
  ['Explore', 'Map the session host and its protocol'],
  ['general-purpose', 'Review the parser for edge cases'],
  ['Explore', 'Find every caller of spotNear'],
  ['Plan', 'Plan the placement rewrite'],
  ['general-purpose', 'Write tests for the reducer'],
  ['Explore', 'Survey the CSS for unused rules'],
  ['general-purpose', 'Check the preload bridge types'],
  ['Explore', 'List the IPC channels'],
  ['general-purpose', 'Profile the canvas render'],
  ['Explore', 'Read the hook scripts']
]

/**
 * Pretend subagents, in the files Claude Code 2.1.328 writes beside the transcript: agent-<id>.jsonl and its
 * meta.json, which says "finished" once the agent is done. The first finishes, the second fails on an API error, and
 * the rest keep running, each calling a tool every few seconds.
 */
function fanOut(count) {
  const path = require('node:path')
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const line = (o) => `${JSON.stringify({ isSidechain: true, timestamp: new Date().toISOString(), ...o })}\n`
  for (let i = 0; i < count; i++) {
    const id = `a${String(i).padStart(4, '0')}fake`
    const [agentType, description] = AGENT_TASKS[i % AGENT_TASKS.length]
    const meta = (extra) => fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType, description, spawnDepth: 1, ...extra }))
    const file = path.join(dir, `agent-${id}.jsonl`)
    meta({})
    fs.writeFileSync(file, line({ type: 'user', message: { content: `${description}. Report back briefly.` } }))
    let tokens = 9000 + i * 3100
    const call = (name) => {
      tokens += 2400
      const usage = { input_tokens: 4, cache_read_input_tokens: tokens, output_tokens: 300 }
      fs.appendFileSync(file, line({ type: 'assistant', message: { id: `m${tokens}`, content: [{ type: 'tool_use', name, input: { file_path: 'src/main/index.ts' } }], usage } }))
    }
    for (let k = 0; k <= i % 4; k++) call(k % 2 ? 'Grep' : 'Read')
    if (i === 0) {
      fs.appendFileSync(file, line({ type: 'assistant', message: { id: 'end', content: [{ type: 'text', text: 'The host speaks framed JSON.' }], usage: { input_tokens: 4, cache_read_input_tokens: tokens, output_tokens: 900 } } }))
      meta({ finished: true })
    } else if (i === 1) {
      fs.appendFileSync(file, line({ type: 'assistant', isApiErrorMessage: true, message: { id: 'err', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }))
      meta({ finished: true })
    } else {
      setInterval(() => call('Read'), 3000 + i * 250)
    }
  }
}

/**
 * One turn that edits files as Claude's Edit tool would: the file changes, and the transcript records the call and its
 * result. A name starting with "?" gets no result line, so it stays unconfirmed. Waits first, for the turn's snapshot.
 */
async function editTurn(files) {
  const path = require('node:path')
  const line = (entry) => fs.appendFileSync(transcript, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`)
  say('user', `Edit ${files.join(', ')}`)
  await hook('UserPromptSubmit')
  await new Promise((r) => setTimeout(r, 2500))
  files.forEach((name, i) => {
    const open = name.startsWith('?')
    const file = path.join(process.cwd(), open ? name.slice(1) : name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    fs.writeFileSync(file, `${before}// edited by ${process.env.PATCHBAY_NODE_ID}\nexport const changed${i} = true\n`)
    const id = `toolu_fake_${i}`
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: '', new_string: 'x' } }] } })
    if (!open) line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'The file was updated.' }] } })
  })
  for (const name of writes) {
    const file = path.join(process.cwd(), name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `{"generated": "${new Date().toISOString()}"}\n`)
  }
  if (subedits.length) {
    const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    const sub = path.join(dir, 'agent-fakesub01.jsonl')
    const subLine = (entry) => fs.appendFileSync(sub, `${JSON.stringify({ ...entry, isSidechain: true, agentId: 'fakesub01', timestamp: new Date().toISOString() })}\n`)
    subedits.forEach((name, i) => {
      const file = path.join(process.cwd(), name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `export const bySubagent${i} = true\n`)
      const id = `toolu_sub_${i}`
      subLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: 'x' } }] } })
      subLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'File created.' }] } })
    })
    fs.writeFileSync(path.join(dir, 'agent-fakesub01.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Write the slug tests', toolUseId: 'toolu_task', spawnDepth: 1, finished: true }))
  }
  await hook('PostToolUse')
  say('assistant', `Edited ${files.length} files.`)
  await hook('Stop')
}

async function main() {
  process.stdout.write(`Pretend Claude. Prompt: ${prompt || '(none)'}\r\n`)
  if (chat || fanout) fs.writeFileSync(transcript, '')
  await hook('SessionStart', { source: 'startup', ...(chat || fanout ? { transcript_path: transcript } : {}) })
  const context = /context=(\d+)/.exec(prompt)
  if (context && settings.statusLine) {
    await runCommand(settings.statusLine.command, { session_id: sessionId, context_window: { used_percentage: Number(context[1]) } })
  }
  if (edits) await editTurn(edits)
  if (/\bneeds\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    await hook('Notification', { notification_type: 'permission_prompt' })
  } else if (/\bpermission\b/.test(prompt)) {
    // Asks to run a long command, and isn't waited for: the request is held until someone answers it. Offers a rule for
    // "don't ask again", as Claude does, in the shape its PermissionRequest hook documents.
    await hook('UserPromptSubmit')
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npx vitest run:*' }], behavior: 'allow', destination: 'localSettings' }
    void hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: LONG_COMMAND }, permission_suggestions: [suggestion] })
  } else if (/\blater=(\d+)\b/.test(prompt)) {
    // Works for that many seconds, then asks to run a command and ends its turn, as when the app may have closed.
    await hook('UserPromptSubmit')
    setTimeout(async () => {
      await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } })
      await hook('Stop')
    }, Number(/\blater=(\d+)\b/.exec(prompt)[1]) * 1000)
  } else if (/\bworking\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    if (fanout) fanOut(fanout)
  } else if (/\blimit\b/.test(prompt)) {
    // Ends its turn on the usage limit, as Claude does with StopFailure.
    await hook('UserPromptSubmit')
    await hook('StopFailure', { error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" })
  } else if (/\bloginfail\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    await hook('StopFailure', { error: 'authentication_failed', last_assistant_message: 'Invalid API key · Please run /login' })
  } else if (/\bunknown\b/.test(prompt)) {
    await hook('UserPromptSubmit')
    await hook('StopFailure')
  } else if (/\bexit\b/.test(prompt)) {
    process.exit(0)
  }
  // With "pb-sticky" it runs `patchbay sticky` as an agent would, so a picture shows where the note really lands.
  if (/\bpb-sticky\b/.test(prompt)) {
    const cli = require('node:path').join(__dirname, '..', '..', 'resources', 'cli', 'patchbay.cjs')
    spawn(process.execPath, [cli, 'sticky', '--title', 'Plan', '--text', 'Notes from the lead'], { stdio: 'ignore', windowsHide: true })
  }
  // With "paste" in the prompt it reads input as Claude Code does: raw, with bracketed paste on. Otherwise the console
  // reads it a line at a time, echoing it itself and dropping paste markers and line breaks inside a message.
  if (/\bpaste\b/.test(prompt) && process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdout.write('\x1b[?2004h')
  }
  // Left idle otherwise, and it stays open, echoing what's typed, like a program waiting for input.
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => process.stdout.write(d))
  // Every byte typed into it, for a check of exactly what a send delivered.
  if (process.env.FAKE_INPUT_LOG) process.stdin.on('data', (d) => fs.appendFileSync(process.env.FAKE_INPUT_LOG, d))
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
          // With the text, as Claude Code's hook carries it, which confirms a send before any transcript is known.
          void hook('UserPromptSubmit', { prompt: said.replace(/\x1b\[20[01]~/g, '') }).then(() => setTimeout(() => void hook('Stop'), 500))
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
