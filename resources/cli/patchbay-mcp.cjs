'use strict'
// Patchbay as an MCP server, for agents whose sandbox keeps shell commands from reaching Patchbay, such as Codex.
// The agent starts this itself, outside its sandbox. Its one tool runs the patchbay command with the words given, so
// every verb keeps the same checks and refusals as on the command line. It speaks MCP over stdio: one JSON-RPC message
// per line.
const { execFile } = require('node:child_process')
const path = require('node:path')

const CLI = path.join(__dirname, 'patchbay.cjs')
const PROTOCOL = '2025-06-18'
/** Longer than any one verb waits, such as a browser action's 25 seconds. */
const CALL_TIMEOUT_MS = 60_000

const TOOL = {
  name: 'patchbay',
  title: 'Patchbay canvas',
  description: [
    'Drives the Patchbay canvas this session is on: open Claude Code and Codex agents and terminals, spawn mixed teams,',
    'read another node\'s conversation or output, send it a message, use browser nodes, and organize the canvas.',
    'Pass the words you would type after `patchbay`, one per item, for example ["open-agent", "--agent", "claude",',
    '"--prompt", "Review the parser"] or ["read", "--node", "<id>", "--tail", "5"].',
    'Call it with ["guide"] before the first use: it explains every verb and its rules.',
    '["whoami"] says which node you are, who opened you and who you work with.',
    '["wait", "--nodes", "<id>,<id>"] returns when those agents finish their turns; it waits up to 45 seconds, so call it again if it says timedOut.'
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The verb and its flags, such as ["list"].' }
    },
    required: ['args'],
    additionalProperties: false
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

/** Codex gives up on a tool call after about a minute, so a wait through here is kept shorter, and asked again. */
const MCP_WAIT_S = 45

function runCli(given) {
  const args = given[0] === 'wait' && !given.includes('--timeout') ? [...given, '--timeout', String(MCP_WAIT_S)] : given
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: process.env, timeout: CALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      const failed = !!e
      const text = failed ? (String(stderr).trim() || (e && e.message) || 'patchbay failed.') : String(stdout)
      resolve({ content: [{ type: 'text', text }], isError: failed })
    })
  })
}

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return // A notification, such as notifications/initialized.
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'patchbay', version: '1.0.0' }
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: [TOOL] })
  if (method === 'tools/call') {
    const args = params && params.arguments && params.arguments.args
    if (!params || params.name !== TOOL.name) return error(id, -32602, `Unknown tool: ${params && params.name}`)
    if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
      return reply(id, { content: [{ type: 'text', text: 'args must be a non-empty list of strings, such as ["list"].' }], isError: true })
    }
    return reply(id, await runCli(args))
  }
  return error(id, -32601, `Method not found: ${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      error(null, -32700, 'Parse error')
      continue
    }
    pending++
    handle(message)
      .catch((e) => error(message.id ?? null, -32603, e.message))
      .finally(() => {
        pending--
        if (ended && pending === 0) process.exit(0)
      })
  }
})
// Calls still running when the agent closes the pipe get to answer first.
let pending = 0
let ended = false
process.stdin.on('end', () => {
  ended = true
  if (pending === 0) process.exit(0)
})
