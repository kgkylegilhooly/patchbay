'use strict'
// The `patchbay` command. Agents and shells inside a Patchbay session use it to drive the canvas.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const REQUEST_TIMEOUT_MS = 30000

// How each flag is read: text, list (commas or repeats), int, or path (resolved against this folder).
const VERBS = {
  whoami: {},
  list: {},
  'open-terminal': { cwd: 'path', group: 'text', title: 'text', command: 'text', after: 'list' },
  'open-agent': {
    prompt: 'text',
    'prompt-file': 'path',
    cwd: 'path',
    group: 'text',
    title: 'text',
    after: 'list',
    agent: 'text'
  },
  'spawn-team': { label: 'text', color: 'text', members: 'text', 'members-file': 'path' },
  group: { ids: 'list', label: 'text', color: 'text' },
  arrange: { ids: 'list', layout: 'text', gap: 'int' },
  rename: { node: 'text', title: 'text' },
  sticky: { text: 'text', title: 'text', group: 'text' },
  note: { node: 'text', text: 'text', append: 'text' },
  'open-whiteboard': { title: 'text', group: 'text' },
  whiteboard: { node: 'text' },
  link: { from: 'text', to: 'text' },
  read: { node: 'text', tail: 'int' },
  send: { node: 'text', text: 'text' },
  wait: { nodes: 'list', node: 'text', timeout: 'int', any: 'flag' },
  close: { node: 'text' },
  issues: { state: 'text', limit: 'int', number: 'int' },
  prs: { state: 'text', limit: 'int' },
  'open-browser': { url: 'text', group: 'text', title: 'text' },
  'browser navigate': { node: 'text', url: 'text' },
  'browser back': { node: 'text' },
  'browser forward': { node: 'text' },
  'browser reload': { node: 'text' },
  'browser read': { node: 'text', 'max-chars': 'int' },
  'browser click': { node: 'text', ref: 'text' },
  'browser type': { node: 'text', ref: 'text', text: 'text', clear: 'flag', enter: 'flag' },
  'browser scroll': { node: 'text', by: 'signed', to: 'text', ref: 'text' },
  'browser screenshot': { node: 'text' }
}

const USAGE = `Usage: patchbay <verb> [--flag value]

  guide         prints how to use Patchbay, with every rule
  whoami        who you are on the canvas: your node, who opened you, your links and team
  list
  open-terminal [--cwd DIR] [--group ID] [--title T] [--command CMD]
  open-agent    [--prompt TEXT | --prompt-file FILE] [--cwd DIR] [--group ID] [--title T] [--after ID,ID] [--agent claude|codex]
  spawn-team    --label L (--members JSON | --members-file FILE) [--color C]
                  members: [{"name":"a","agent":"codex","prompt":"...","promptFile":"...","cwd":"...","after":["b"]}]
  group         --ids ID,ID --label L [--color C]
  arrange       --ids ID,ID --layout grid|row|column [--gap N]
  rename        --node ID --title T
  sticky        --text MARKDOWN [--title T] [--group ID]
  note          --node ID (--append MARKDOWN | --text MARKDOWN)   adds to a note, or replaces one you opened
  open-whiteboard [--title T] [--group ID]
  whiteboard    --node ID        saves a whiteboard as a PNG and prints its path
  link          --to ID [--from ID]
  read          --node ID [--tail N]
  send          --node ID --text TEXT
  wait          --nodes ID,ID [--timeout SECONDS] [--any]   until those agents finish their turns (default 90 s, up to 600)
  close         --node ID
  issues        [--state open|closed|all] [--limit N] [--number N]   (read-only)
  prs           [--state open|closed|merged|all] [--limit N]         (read-only)
  open-browser  [--url URL] [--group ID] [--title T]
  browser navigate   --node ID --url URL
  browser back|forward|reload --node ID
  browser read       --node ID [--max-chars N]
  browser click      --node ID --ref REF
  browser type       --node ID --ref REF --text TEXT [--clear] [--enter]
  browser scroll     --node ID (--by PIXELS | --to top|bottom | --ref REF)
  browser screenshot --node ID
`

function fail(message) {
  process.stderr.write(`patchbay: ${message}\n`)
  process.exit(1)
}

/** Git Bash hands over /c/Users/me, which Node would read as a folder on the current drive. */
function toLocalPath(value) {
  const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(value)
  const native = process.platform === 'win32' && msys ? `${msys[1].toUpperCase()}:${msys[2] || '/'}` : value
  return path.resolve(native)
}

const camel = (flag) => flag.replace(/-(\w)/g, (_, c) => c.toUpperCase())

function parseFlags(verb, words) {
  const spec = VERBS[verb]
  const args = {}
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (!word.startsWith('--')) fail(`Unexpected "${word}". Flags look like --name value.`)
    const eq = word.indexOf('=')
    const flag = eq === -1 ? word.slice(2) : word.slice(2, eq)
    const kind = Object.hasOwn(spec, flag) ? spec[flag] : undefined
    if (!kind) fail(`${verb} has no --${flag} flag.\n\n${USAGE}`)
    // A flag takes no value. Signed takes a whole number that may be negative.
    if (kind === 'flag') {
      if (eq !== -1) fail(`--${flag} takes no value.`)
      args[camel(flag)] = true
      continue
    }
    let value
    if (eq !== -1) value = word.slice(eq + 1)
    else {
      if (i + 1 >= words.length) fail(`--${flag} needs a value.`)
      value = words[++i] // Taken whole, so a value may itself begin with dashes.
    }
    const key = camel(flag)
    if (kind === 'text') args[key] = value
    if (kind === 'path') args[key] = toLocalPath(value)
    if (kind === 'list') args[key] = [...(args[key] || []), ...value.split(',').filter(Boolean)]
    if (kind === 'int') {
      if (!/^\d+$/.test(value)) fail(`--${flag} needs a whole number, not "${value}".`)
      args[key] = Number(value)
    }
    if (kind === 'signed') {
      if (!/^-?\d+$/.test(value)) fail(`--${flag} needs a whole number, not "${value}".`)
      args[key] = Number(value)
    }
  }
  return args
}

function teamMembers(args) {
  const { members, membersFile, ...rest } = args
  if ((members === undefined) === (membersFile === undefined)) fail('Give one of --members and --members-file.')
  let text = members
  if (membersFile !== undefined) {
    try {
      text = fs.readFileSync(membersFile, 'utf8')
    } catch (e) {
      fail(`Could not read ${membersFile}: ${e.message}`)
    }
  }
  let list
  try {
    list = JSON.parse(text)
  } catch (e) {
    fail(`The team members aren't valid JSON: ${e.message}`)
  }
  if (!Array.isArray(list)) fail('The team members must be a JSON list.')
  const resolved = list.map((m) => {
    if (typeof m !== 'object' || m === null) return m
    const out = { ...m }
    if (typeof out.promptFile === 'string') out.promptFile = toLocalPath(out.promptFile)
    if (typeof out.cwd === 'string') out.cwd = toLocalPath(out.cwd)
    return out
  })
  return { ...rest, members: resolved }
}

const APP_CLOSED = "Can't reach Patchbay, because the app is closed. This session keeps running, and this command will work once Patchbay is open again."

function endpointPort(file) {
  let endpoint
  try {
    // Read on every call: a restarted app listens on a new port.
    endpoint = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fail(APP_CLOSED)
  }
  if (typeof endpoint.pid === 'number') {
    try {
      process.kill(endpoint.pid, 0)
    } catch (e) {
      // A crashed app leaves its file behind.
      if (e.code === 'ESRCH') return fail(APP_CLOSED)
    }
  }
  return endpoint.port
}

function call(verb, args) {
  const { PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_NODE_ID: nodeId, PATCHBAY_TOKEN: token } = process.env
  if (!file || !nodeId || !token) fail('This only works inside a Patchbay session.')
  const body = JSON.stringify({ verb, args })
  const req = http.request(
    {
      host: '127.0.0.1',
      port: endpointPort(file),
      path: '/rpc',
      method: 'POST',
      // A wait holds the line open with nothing said until it's done, so the limit follows the wait's own.
      timeout: verb === 'wait' ? ((args.timeout ?? 90) + 15) * 1000 : REQUEST_TIMEOUT_MS,
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
      res.on('error', (e) => fail(`Can't reach Patchbay: ${e.message}`))
      res.on('end', () => finish(verb, res.statusCode, Buffer.concat(chunks).toString('utf8')))
    }
  )
  req.on('timeout', () => req.destroy(new Error('it took too long to answer')))
  req.on('error', (e) => fail(`Can't reach Patchbay: ${e.message}`))
  req.end(body)
}

function finish(verb, status, text) {
  if (status === 401) fail('Patchbay rejected this session\'s token.')
  if (status === 413) fail('That request is too large. Put long text in a file.')
  let reply
  try {
    reply = JSON.parse(text)
  } catch {
    fail(`Patchbay sent an unreadable reply (HTTP ${status}).`)
  }
  if (status !== 200) fail(reply.error || `Patchbay answered HTTP ${status}.`)
  const { result } = reply
  if ((verb === 'read' || verb === 'whoami') && typeof result?.text === 'string') process.stdout.write(result.text)
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function main() {
  const [first, ...rest] = process.argv.slice(2)
  // `browser read` is one verb of two words. On the wire it's browser-read.
  const verb = first === 'browser' ? `browser ${rest[0] ?? ''}` : first
  const words = first === 'browser' ? rest.slice(1) : rest
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(USAGE)
    return
  }
  // The full guide, for agents that can't load Patchbay's skill themselves, such as Codex.
  if (verb === 'guide') {
    const skill = require('node:path').join(__dirname, '..', 'skill', 'skills', 'patchbay', 'SKILL.md')
    process.stdout.write(require('node:fs').readFileSync(skill, 'utf8').replace(/^---[\s\S]*?---\s*/, ''))
    return
  }
  if (!Object.hasOwn(VERBS, verb)) fail(`Unknown verb "${verb}".\n\n${USAGE}`)
  const args = parseFlags(verb, words)
  call(verb.replace(' ', '-'), verb === 'spawn-team' ? teamMembers(args) : args)
}

main()
