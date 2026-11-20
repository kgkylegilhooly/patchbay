'use strict'
// A real lead and a real teammate, on Haiku: does a team started from the canvas use what the skill teaches? It spends
// a little plan quota. The lead gets the same prompt as Spawn a team, and a task that asks for one teammate.
//
// Permission prompts are answered here, narrowly: plain `patchbay` commands, a few read-only shell commands, and
// writes inside the work folder are allowed. Anything else is denied, and every answer is listed.
//
// Run: node test/acceptance/team-real.cjs [--dev]   (the packaged build in release/ unless --dev)
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const c = L.checker()
const SHOTS = process.env.PB_SHOTS
const LIMIT_MS = 12 * 60_000

/** The canvas's own lead prompt, from its source, so this tests what the person would really send. */
function leadPrompt(task) {
  // The file's only TypeScript is the one signature, so taking that out leaves plain JavaScript.
  const source = fs.readFileSync(path.join(L.root, 'src', 'renderer', 'teamPrompt.ts'), 'utf8')
  const js = source.replace(/^export /gm, '').replace('teamLeadPrompt(task: string): string', 'teamLeadPrompt(task)')
  if (/:\s*string\b/.test(js.replace(/'[^']*'/g, ''))) throw new Error('teamPrompt.ts has types this script does not take out. Update leadPrompt().')
  return new Function(`${js}\nreturn teamLeadPrompt`)()(task)
}

/** Every shell command and tool an agent ran, from its transcript. */
function toolCalls(file) {
  if (!file || !fs.existsSync(file)) return []
  const calls = []
  // Claude Code can write the same tool call to its transcript more than once, so each is counted by its id.
  const seen = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      for (const part of e.message?.content ?? []) {
        if (part?.type !== 'tool_use' || seen.has(part.id)) continue
        seen.add(part.id)
        // Agents often move into the work folder first. What they then run is the command that counts.
        const command = String(part.input?.command ?? part.input?.file_path ?? '').replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')
        calls.push({ tool: part.name, command })
      }
    } catch {}
  }
  return calls
}

function decide(approval, work) {
  const text = approval.detail
  if (approval.tool === 'Bash') {
    // Quoted text is an argument, such as a brief, so it's set aside before the shell's own syntax is checked.
    // A heredoc's body is input too, as when a team's JSON is fed to `patchbay spawn-team --members-file -`, the way the
    // skill teaches. It's only allowed into a patchbay command.
    // Approvals show the command with its whitespace collapsed, so the body runs to the terminator word on one line.
    const heredoc = /(patchbay\s[^;&|<]*?)<<-?\s*['"]?(\w+)['"]?\s[\s\S]*?\s\2(?=\s|$)/g
    const bare = text
      .replace(heredoc, '$1 ARG\n')
      .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'ARG')
      .replace(/\s2?>\s*\/dev\/null/g, '')
      .replace(/&&|\|\||\n/g, ';')
    if (/`|\$\(|>|<|\|/.test(bare)) return 'deny'
    // Moving into the work folder first is what a careful person would let pass: what follows is still checked.
    const safe = (part) => !part || /^patchbay\s/.test(part) || /^(ls|pwd|cat|dir|type|head|wc|echo)\b/.test(part) || /^cd ARG$/.test(part)
    return bare.split(';').every((part) => safe(part.trim())) ? 'allow' : 'deny'
  }
  if (['Write', 'Edit', 'MultiEdit'].includes(approval.tool)) {
    const target = path.resolve(work, text)
    return target.toLowerCase().startsWith(work.toLowerCase() + path.sep) ? 'allow' : 'deny'
  }
  return 'deny'
}

async function main() {
  const exe = process.argv.includes('--dev') ? undefined : L.packagedExe
  const work = L.workDir('team-real')
  const profile = L.newProfile({ permissionMode: 'default', notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, exe })
  const { page } = app
  const answered = []
  let stop = false
  const answering = (async () => {
    while (!stop) {
      const pending = await page.evaluate(() => window.patchbay.getApprovals()).catch(() => [])
      for (const a of pending) {
        const decision = decide(a, work)
        answered.push(`${decision}  ${a.nodeId === 'lead' ? 'lead' : 'member'}  ${a.tool}: ${a.detail.slice(0, 160)}`)
        await page.evaluate((id, d) => window.patchbay.answerApproval(id, d), a.requestId, decision).catch(() => {})
      }
      await L.sleep(400)
    }
  })()
  try {
    const task = [
      'Create two files in this folder.',
      'GREETING.md: one line that greets a new contributor. Write this one yourself.',
      'FAREWELL.md: one line that thanks a departing contributor. Give this one to a single team member.',
      'Keep it quick: this is a small task.'
    ].join('\n')
    await L.openNode(page, L.claude('lead', work, 20, 20, { title: 'Team lead', prompt: leadPrompt(task) }))
    const started = Date.now()
    let calmSince = null
    // Teammates are noted while they're on the canvas, since closing one takes its cables, and with them who opened it.
    const seenMembers = new Set()
    for (;;) {
      await L.sleep(3000)
      const doc = await L.doc(page)
      const members = doc.nodes.filter((n) => n.kind === 'claude' && n.id !== 'lead')
      for (const m of members) seenMembers.add(m.id)
      const leadStatus = await L.statusOf(page, 'lead')
      const settled = leadStatus === 'idle' || leadStatus === 'exited'
      calmSince = settled ? (calmSince ?? Date.now()) : null
      // Done once the lead has stayed idle a while after its team is gone, or for a long while in any case.
      if (calmSince && Date.now() - calmSince > (members.length ? 90_000 : 20_000)) break
      if (Date.now() - started > LIMIT_MS) {
        console.log('NOTE  stopped at the time limit')
        break
      }
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'team-real.png') })

    const doc = await L.doc(page)
    const lead = doc.nodes.find((n) => n.id === 'lead')
    const leadCalls = toolCalls(lead?.transcriptPath)
    const commands = leadCalls.filter((t) => t.tool === 'Bash').map((t) => t.command)
    const messages = await page.evaluate(() => window.patchbay.getMessages())
    const opened = doc.edges.filter((e) => e.from === 'lead' && e.kind === 'opened').map((e) => e.to)
    const closedMembers = doc.closed.map((x) => x.title)
    // The agents the lead opened, whether still on the canvas or closed. A team's group is opened by the lead too, but isn't one.
    // Closed conversations keeps a conversation under an id of its own, so a closed teammate is known by its messages.
    const agents = new Set([...doc.nodes.filter((n) => n.kind === 'claude').map((n) => n.id), ...messages.flatMap((m) => [m.from, m.to]), ...opened.filter((id) => !doc.nodes.some((n) => n.id === id && n.kind === 'group'))])
    const memberIds = [...new Set([...seenMembers, ...opened, ...messages.flatMap((m) => [m.from, m.to])])].filter((id) => id !== 'lead' && (agents.has(id) || seenMembers.has(id)))
    const groups = opened.filter((id) => !agents.has(id))

    console.log('\n--- lead commands ---')
    for (const cmd of commands) console.log(`  ${cmd.replace(/\s+/g, ' ').slice(0, 220)}`)
    console.log('--- messages between nodes ---')
    for (const m of messages) console.log(`  ${m.from} -> ${m.to}: ${m.text.replace(/\s+/g, ' ').slice(0, 220)}`)
    console.log('--- permission answers ---')
    for (const a of answered) console.log(`  ${a}`)
    console.log('--- lead\'s last words ---')
    console.log(L.transcriptText(lead?.transcriptPath).split('\n').filter((l) => l.startsWith('assistant: ')).slice(-2).join('\n').slice(0, 1500))
    console.log('')

    c.check('The lead knows where it is: it ran whoami or got the canvas context', commands.some((x) => /^patchbay whoami/.test(x)) || (lead?.transcriptPath && fs.readFileSync(lead.transcriptPath, 'utf8').includes('on the Patchbay canvas')))
    const startCmd = commands.filter((x) => /^patchbay (open-agent|spawn-team)/.test(x)).pop() ?? ''
    // A lead following the skill may put the brief in a file and name it with promptFile or --prompt-file.
    const files = (text) => [...text.matchAll(/"promptFile":\s*"([^"]+)"|--(?:prompt|members)-file\s+"?([^"\s]+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\\\/g, '\\'))
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
    // A members file can itself name prompt files, so those are read too.
    const outer = files(startCmd).map(read)
    const brief = [startCmd, ...outer, ...outer.flatMap(files).map(read)].join('\n')
    c.check('The lead started one teammate', /^patchbay (open-agent|spawn-team)/.test(brief), brief.slice(0, 300))
    c.check('Its brief names the files the teammate owns and how to report back', /FAREWELL\.md/.test(brief) && /report|send/i.test(brief), brief.slice(0, 600))
    c.check('The lead waited with patchbay wait', commands.some((x) => /^patchbay wait/.test(x)))
    c.check('It didn\'t poll patchbay list over and over', commands.filter((x) => /^patchbay list/.test(x)).length <= 2, commands.filter((x) => /^patchbay list/.test(x)).length)
    c.check('The teammate reported back to the lead with patchbay send', messages.some((m) => m.to === 'lead' && memberIds.includes(m.from)))
    // A closed teammate's conversation is still listed under Closed conversations, with its transcript.
    const member = doc.nodes.find((n) => memberIds.includes(n.id)) ?? doc.closed.find((x) => x.title !== 'Team lead') ?? null
    const memberText = member?.transcriptPath && fs.existsSync(member.transcriptPath) ? fs.readFileSync(member.transcriptPath, 'utf8') : ''
    c.check('The teammate was told where it is when its session started', memberText.includes('on the Patchbay canvas'), member ? member.transcriptPath : 'no teammate found')
    const memberCommands = toolCalls(member?.transcriptPath).filter((t) => t.tool === 'Bash').map((t) => t.command)
    console.log('--- teammate commands ---')
    for (const cmd of memberCommands) console.log(`  ${cmd.replace(/\s+/g, ' ').slice(0, 220)}`)
    c.check('Both files were written', fs.existsSync(path.join(work, 'GREETING.md')) && fs.existsSync(path.join(work, 'FAREWELL.md')))
    c.check('The lead closed its teammate at the end', memberIds.length > 0 && !memberIds.some((id) => doc.nodes.some((n) => n.id === id)), { open: memberIds.filter((id) => doc.nodes.some((n) => n.id === id)), closed: closedMembers })
    c.check('No empty team group was left behind', !groups.some((id) => doc.nodes.some((n) => n.id === id)), groups)
    c.check('Every patchbay command the agents asked to run was allowed', answered.every((a) => a.startsWith('allow') || !/Bash: patchbay\s/.test(a)), answered.filter((a) => !a.startsWith('allow')))
    c.check('No team JSON was refused', !commands.some((x, i) => /^patchbay spawn-team/.test(x) && commands.slice(i + 1).some((y) => /^patchbay spawn-team/.test(y))), commands.filter((x) => /^patchbay spawn-team/.test(x)).length)
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    stop = true
    await answering.catch(() => {})
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
