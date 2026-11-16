'use strict'
// Claude Code runs this for each hook event. It forwards the event to Patchbay's control server.
// Whatever goes wrong, it exits 0 quickly and quietly, so it can never block or disturb Claude.
// The one wait allowed is for a person to answer a permission request. At the start of a session it also prints
// where the agent is on the canvas, for the agent to read.
//
// Sessions outlive the app, so this often runs with no app to talk to. An event that can't be delivered goes in a
// journal for the app to read when it reconnects. A permission request gets no answer, which leaves Claude's own
// terminal prompt to decide.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const LIMIT_MS = 1500
/** A bigger input is withheld, which leaves that request to the terminal prompt. */
const MAX_TOOL_INPUT_CHARS = 256 * 1024
/** Rolled over past this. Only the latest events decide a status, so the older part is dispensable. */
const MAX_JOURNAL_BYTES = 256 * 1024

/** The fields Patchbay uses. Tool responses can be huge and could push the event past the server's limit. */
const FORWARDED = ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'notification_type', 'reason', 'source']

function done() {
  process.exit(0)
}

/** The event being sent, until the app has taken it. */
let undelivered = null

function journal(fields) {
  const { PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_NODE_ID: nodeId } = process.env
  // Tool input is only for the approval buttons, which this request no longer has.
  const { tool_name: _name, tool_input: _input, ...kept } = fields
  const dir = path.join(path.dirname(file), 'missed')
  const target = path.join(dir, `${encodeURIComponent(nodeId)}.jsonl`)
  fs.mkdirSync(dir, { recursive: true })
  if ((fs.statSync(target, { throwIfNoEntry: false })?.size ?? 0) > MAX_JOURNAL_BYTES) fs.renameSync(target, `${target}.old`)
  fs.appendFileSync(target, `${JSON.stringify(kept)}\n`)
}

function giveUp() {
  try {
    if (undelivered) journal(undelivered)
  } catch {
    // Then the app will show this session's status as unknown, which is still true.
  }
  done()
}

const limit = setTimeout(giveUp, LIMIT_MS)

/** The port of the app that's running now, or null without waiting if there isn't one. */
function livePort(file) {
  let endpoint
  try {
    endpoint = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof endpoint.port !== 'number') return null
  if (typeof endpoint.pid === 'number') {
    try {
      process.kill(endpoint.pid, 0)
    } catch (e) {
      // A crashed app leaves its file behind. Connecting to its old port could take seconds to fail.
      if (e.code === 'ESRCH') return null
    }
  }
  return endpoint.port
}

function pick(raw) {
  const event = JSON.parse(raw)
  const out = {}
  for (const key of FORWARDED) if (event[key] !== undefined) out[key] = event[key]
  if (!out.hook_event_name) out.hook_event_name = process.argv[2]
  if (out.hook_event_name === 'PermissionRequest') {
    out.tool_name = event.tool_name
    const input = JSON.stringify(event.tool_input)
    if (input && input.length <= MAX_TOOL_INPUT_CHARS) out.tool_input = event.tool_input
  }
  return out
}

const DENIED = "The person declined this tool call at Patchbay's permission prompt. It's their answer to this call, not a Patchbay rule against the feature it uses."

function printDecision(text) {
  const { decision } = JSON.parse(text)
  if (decision !== 'allow' && decision !== 'deny') return done()
  const answer = { behavior: decision }
  // Agents read a bare "denied" as Patchbay ruling out what the call does, such as opening a browser, and give up on
  // it for good. It's the person's answer to this one call.
  if (decision === 'deny') answer.message = DENIED
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer } }
  process.stdout.write(JSON.stringify(output), done)
}

/** Where the agent is on the canvas, given to it as context when its session starts. */
function printContext(text) {
  const { context } = JSON.parse(text)
  if (typeof context !== 'string' || !context) return done()
  const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.slice(0, 4000) } }
  process.stdout.write(JSON.stringify(output), done)
}

function send(raw) {
  const { PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_NODE_ID: nodeId, PATCHBAY_TOKEN: token } = process.env
  if (!file || !nodeId || !token) return done()
  const fields = pick(raw)
  undelivered = fields
  // Read on every call: a restarted app listens on a new port, and sessions must still find it.
  const port = livePort(file)
  if (port === null) return giveUp()
  const held = fields.hook_event_name === 'PermissionRequest'
  const body = JSON.stringify(fields)
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-patchbay-node': nodeId,
        authorization: `Bearer ${token}`
      }
    },
    (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        undelivered = null
        if (held) printDecision(Buffer.concat(chunks).toString('utf8'))
        else if (fields.hook_event_name === 'SessionStart') printContext(Buffer.concat(chunks).toString('utf8'))
        else done()
      })
      res.on('error', giveUp)
    }
  )
  // This includes the app closing while a permission request is held, which leaves the terminal prompt in charge.
  req.on('error', giveUp)
  // Reaching the server stays under the limit. Only the wait for an answer may outlast it.
  if (held) req.on('socket', (socket) => socket.once('connect', () => clearTimeout(limit)))
  req.end(body)
}

process.on('uncaughtException', done)
process.on('unhandledRejection', done)

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('error', done)
process.stdin.on('end', () => send(Buffer.concat(chunks).toString('utf8')))
