'use strict'
// The `patchbay` command. Agents and shells inside a Patchbay session use it to drive the canvas.
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const REQUEST_TIMEOUT_MS = 30000

// How each flag is read: text, list (commas or repeats), int, or path (resolved against this folder).
const VERBS = {
  'task create': { brief: 'text', criteria: 'repeat', sessions: 'list', cwd: 'path', checks: 'text', 'depends-on': 'list' },
  'task list': { readiness: 'flag' },
  'task show': { task: 'text' },
  'task submit': { task: 'text', summary: 'text' },
  'task verify': { task: 'text', check: 'text' },
  'task state': { task: 'text', state: 'text' },
  whoami: {},
  list: {},
  'open-terminal': { cwd: 'path', group: 'text', title: 'text', command: 'text', profile: 'text', after: 'list' },
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
  arrange: { ids: 'list', layout: 'text', gap: 'int', group: 'text', status: 'flag' },
  rename: { node: 'text', title: 'text' },
  sticky: { text: 'text', title: 'text', group: 'text' },
  note: { node: 'text', text: 'text', append: 'text' },
  'open-whiteboard': { title: 'text', group: 'text' },
  'pin-file': { path: 'path', title: 'text', group: 'text' },
  whiteboard: { node: 'text' },
  draw: { node: 'text', diagram: 'text', 'diagram-file': 'path', replace: 'flag' },
  link: { from: 'text', to: 'text' },
  read: { node: 'text', tail: 'int' },
  files: { node: 'text', turn: 'flag' },
  send: { node: 'text', text: 'text' },
  wait: { nodes: 'list', node: 'text', timeout: 'int', any: 'flag' },
  close: { node: 'text' },
  restart: { node: 'text' },
  issues: { state: 'text', limit: 'int', number: 'int' },
  prs: { state: 'text', limit: 'int' },
  'open-browser': { url: 'text', group: 'text', title: 'text' },
  'open-doc': { path: 'path', title: 'text', group: 'text' },
  recipes: { name: 'text', source: 'text', task: 'text', branch: 'text', repo: 'path', cwd: 'path', 'no-worktree': 'flag', skip: 'list' },
  'run-recipe': { name: 'text', source: 'text', task: 'text', branch: 'text', repo: 'path', cwd: 'path', 'no-worktree': 'flag', skip: 'list', hash: 'text' },
  workflows: { name: 'text', source: 'text', input: 'repeat' },
  'workflow-run': { name: 'text', source: 'text', input: 'repeat', hash: 'text' },
  'job-submit': { output: 'repeat', step: 'text' },
  'browser navigate': { node: 'text', url: 'text' },
  'browser back': { node: 'text' },
  'browser forward': { node: 'text' },
  'browser reload': { node: 'text' },
  'browser read': { node: 'text', 'max-chars': 'int' },
  'browser click': { node: 'text', ref: 'text' },
  'browser type': { node: 'text', ref: 'text', text: 'text', clear: 'flag', enter: 'flag' },
  'browser scroll': { node: 'text', by: 'signed', to: 'text', ref: 'text' },
  'browser screenshot': { node: 'text' },
  'browser console': { node: 'text' },
  'browser network': { node: 'text' },
  'browser viewport': { node: 'text', preset: 'text' },
  'browser verify': { node: 'text', phase: 'text', 'task-id': 'text', outcome: 'text' },
  'browser evidence': { node: 'text' }
}

const USAGE = `Usage: patchbay <verb> [--flag value]

  task create   --brief TEXT --criteria TEXT [--criteria TEXT ...] [--sessions ID,ID] [--cwd DIR] [--checks JSON] [--depends-on ID,ID]
  task list     [--readiness]   with --readiness, each task's attempts and whether it's ready now
  task show     --task ID
  task submit   --task ID --summary TEXT
  task verify   --task ID --check NAME   runs a check declared at create, in cmd, outside your sandbox; task show reads its result
  task state    --task ID --state planned|running|blocked|cancelled

  guide         prints how to use Patchbay, with every rule
  whoami        who you are on the canvas: your node, who opened you, your links and team
  list
  open-terminal [--cwd DIR] [--group ID] [--title T] [--command CMD] [--profile NAME|ID]
  open-agent    [--prompt TEXT | --prompt-file FILE|-] [--cwd DIR] [--group ID] [--title T] [--after ID,ID] [--agent claude|codex]
  spawn-team    --label L (--members JSON | --members-file FILE|-) [--color C]
                  members: [{"name":"a","agent":"codex","prompt":"...","promptFile":"...","cwd":"...","after":["b"]}]
  group         --ids ID,ID --label L [--color C]
  arrange       --ids ID,ID --layout grid|row|column [--gap N]
  arrange       --layout tidy [--ids ID,ID | --group ID] [--status]   keeps related nodes together, needs-you first with --status
  rename        --node ID --title T
  sticky        --text MARKDOWN [--title T] [--group ID]
  note          --node ID (--append MARKDOWN | --text MARKDOWN)   adds to a note, or replaces one you opened
  open-whiteboard [--title T] [--group ID]
  pin-file      --path FILE [--title T] [--group ID]   puts a file's icon on the canvas for the person (a reference; nothing is copied)
  whiteboard    --node ID        saves a whiteboard as a PNG and prints its path
  draw          --node ID (--diagram JSON | --diagram-file FILE|-) [--replace]   draws boxes and arrows on a whiteboard
  link          --to ID [--from ID]   joins you or a node you opened to another you opened
  read          --node ID [--tail N]
  files         [--node ID] [--turn]   files an agent edited (itself by default), newest first; --turn: the latest turn only
  send          --node ID --text TEXT
  wait          --nodes ID,ID [--timeout SECONDS] [--any]   until those agents finish their turns (default 90 s, up to 600; keep it under 120 in Claude Code)
  close         --node ID
  restart       --node ID        brings back an agent you opened that has exited, resuming its conversation
  issues        [--state open|closed|all] [--limit N] [--number N]   (read-only)
  prs           [--state open|closed|merged|all] [--limit N]         (read-only)
  open-browser  [--url URL] [--group ID] [--title T]
  open-doc      --path FILE [--title T] [--group ID]   shows a Markdown file (a plan, a report) to the person in a reader; they comment and send the comments to you
  recipes       [--name N [--source S] [--task T] [--branch B] [--no-worktree] [--cwd DIR]]   lists recipes, or previews one; runs nothing
  run-recipe    --name N [--source built-in|personal|repository] [--task T] [--branch B] [--repo DIR] [--no-worktree] [--cwd DIR] [--skip KEY,KEY] [--hash H]
  workflows     [--name N [--source S] [--input KEY=VALUE]...]   lists workflows and recent runs, or previews one; runs nothing
  workflow-run  --name N [--input KEY=VALUE]... [--hash H]   starts a personal workflow the person has started before, unchanged
  job-submit    --output KEY=VALUE|KEY=@FILE ... [--step KEY]   submits your result for the workflow step you are running
  browser navigate   --node ID --url URL
  browser back|forward|reload --node ID
  browser read       --node ID [--max-chars N]
  browser click      --node ID --ref REF
  browser type       --node ID --ref REF --text TEXT [--clear] [--enter]
  browser scroll     --node ID (--by PIXELS | --to top|bottom | --ref REF)
  browser screenshot --node ID
  browser console|network|evidence --node ID
  browser viewport   --node ID --preset desktop|mobile|node
  browser verify     --node ID --phase start|step|finish [--task-id ID] [--outcome passed|failed|unknown]
`

/** The usage lines for one verb, or for every `browser` verb, with a pointer to the full guide. */
function usageOf(verb) {
  const lines = USAGE.split('\n')
  const picked = []
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i].trim().split(/\s+/)
    const name = words[0] === 'browser' || words[0] === 'task' ? `${words[0]} ${words[1]}` : words[0]
    const match = verb === 'browser' || verb === 'task' ? words[0] === verb : name === verb || (words[0] === 'browser' && words[1].split('|').includes(verb.slice(8)))
    if (!match) continue
    picked.push(lines[i])
    // A verb's own detail is indented further on the lines below it.
    while (lines[i + 1] && /^ {6,}/.test(lines[i + 1]) && !/^ {2}\S/.test(lines[i + 1])) picked.push(lines[++i])
  }
  return `Usage: patchbay ${verb} [--flag value]\n\n${picked.join('\n')}\n\nRun patchbay guide for how to use it, with every rule.\n`
}

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

/** File flags that take - for what's piped in, and the flag that text is passed as instead. */
const FROM_STDIN = { promptFile: 'prompt', diagramFile: 'diagram', membersFile: 'members' }

function readStdin(flag) {
  if (process.stdin.isTTY) fail(`--${flag} - reads what's piped in, and nothing is. Pipe the text in, as with a heredoc, or name a file.`)
  let text
  try {
    text = fs.readFileSync(0, 'utf8')
  } catch (e) {
    // Windows reports a closed or absent stdin as EOF in some shells and an error in others.
    if (e.code !== 'EOF') fail(`Could not read what was piped in to --${flag}: ${e.message}`)
    text = ''
  }
  if (!text.trim()) fail(`--${flag} - got nothing on its input. Pipe the text in, as with a heredoc, or name a file.`)
  return text
}

function parseFlags(verb, words) {
  const spec = VERBS[verb]
  const args = {}
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (!word.startsWith('--')) {
      // Usually a quote mark inside a long text, such as the one in "don't", that ended the shell's quoting early.
      const cut = i > 0 && /\s/.test(words[i - 1] ?? '') ? ` A quote mark inside your text may have ended it early. Pipe long text in instead, as in ${verb === 'spawn-team' ? '--members-file' : verb === 'draw' ? '--diagram-file' : '--prompt-file'} - <<'EOF', or use a file.` : ''
      fail(`Unexpected "${word}". Flags look like --name value.${cut}`)
    }
    const eq = word.indexOf('=')
    const flag = eq === -1 ? word.slice(2) : word.slice(2, eq)
    // Agents try `patchbay <verb> --help` before using a verb, so it's an answer, not a mistake.
    if (flag === 'help') {
      process.stdout.write(usageOf(verb))
      process.exit(0)
    }
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
    // A file of - is what's piped in, as from a heredoc, so a long brief or a diagram needs no file and no quoting.
    if (kind === 'path' && value === '-' && Object.hasOwn(FROM_STDIN, key)) {
      args[FROM_STDIN[key]] = readStdin(flag)
      continue
    }
    if (kind === 'path') args[key] = toLocalPath(value)
    if (kind === 'list') args[key] = [...(args[key] || []), ...value.split(',').filter(Boolean)]
    // Each use is one whole item, commas and all, as an acceptance criterion such as "Handles 1,000 rows".
    if (kind === 'repeat') args[key] = [...(args[key] || []), value]
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

/** A path field that came out holding a tab, newline or other control character was read wrong, as from C:\temp. */
const garbledPath = (list) =>
  Array.isArray(list) && list.some((m) => m && ['cwd', 'promptFile'].some((k) => typeof m[k] === 'string' && /[\x00-\x1f]/.test(m[k])))

/**
 * Team JSON as meant, even when its Windows paths arrive with single backslashes. Git Bash hands a quoted argument to
 * Windows programs with each \\ halved, so even correct JSON such as "C:\\Code" arrives as "C:\Code", which isn't
 * valid. Text that is valid JSON is read as it is. Otherwise backslashes that can't start an escape are doubled; and if
 * a path still comes out with a control character in it, as \t in C:\temp would, every backslash is taken literally.
 */
function readTeamJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    const attempts = [text.replace(/\\(?!["\\/nrt]|u[0-9a-fA-F]{4})/g, '\\\\'), text.replace(/\\(?!")/g, '\\\\')]
    for (const attempt of attempts) {
      try {
        const list = JSON.parse(attempt)
        if (!garbledPath(list)) return list
      } catch {}
    }
    fail(`The team members aren't valid JSON: ${e.message}. Write Windows paths with forward slashes, as in C:/Code/app, or put the team in a file and use --members-file.`)
  }
}

/** `--output key=value` as text, and `--output key=@file` as a file, resolved against this folder. */
function jobOutputs(args) {
  const { output = [], ...rest } = args
  const outputs = output.map((item) => {
    const eq = item.indexOf('=')
    if (eq < 1) fail(`--output ${item}: write it as key=value, or key=@file for a file.`)
    const key = item.slice(0, eq)
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key)) fail(`--output ${key}: a field name starts with a letter and has only letters, digits, - and _.`)
    const value = item.slice(eq + 1)
    return value.startsWith('@') && value.length > 1 ? { key, file: toLocalPath(value.slice(1)) } : { key, text: value }
  })
  return { ...rest, outputs }
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
  const list = readTeamJson(text)
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
  const verb = first === 'browser' || first === 'task' ? `${first} ${rest[0] ?? ''}` : first
  const words = first === 'browser' || first === 'task' ? rest.slice(1) : rest
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if ((first === 'browser' || first === 'task') && ['', '--help', '-h', 'help'].includes(rest[0] ?? '')) {
    process.stdout.write(usageOf(first))
    return
  }
  if (words[0] === '-h') {
    process.stdout.write(usageOf(verb))
    return
  }
  // The full guide, for agents that can't load Patchbay's skill themselves, such as Codex.
  // The skill's main file, then the reference files beside it, since an agent reading this can't open those itself.
  if (verb === 'guide') {
    const dir = path.join(__dirname, '..', 'skill', 'skills', 'patchbay')
    const extra = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'SKILL.md').sort()
    const parts = [fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''), ...extra.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))]
    process.stdout.write(parts.join('\n\n'))
    return
  }
  if (!Object.hasOwn(VERBS, verb)) fail(`Unknown verb "${verb}".\n\n${USAGE}`)
  const args = parseFlags(verb, words)
  call(verb.replace(' ', '-'), verb === 'spawn-team' ? teamMembers(args) : verb === 'job-submit' ? jobOutputs(args) : args)
}

main()
