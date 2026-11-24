import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import { createFilesTouched, subagentFolder, type AgentInfo } from '../../src/main/files/service'
import { gitRunner, snapshotTree } from '../../src/main/files/snapshot'
import { addEdit, addTurnChanges, emptyRecord, MAX_TURN_CHANGES, startTurn } from '../../src/main/files/touched'
import { describeFiles } from '../../src/main/files/verbs'
import { cleanEnv } from '../../src/main/sessions/env'
import type { AgentStatus } from '../../src/shared/model'
import { endCheckNote, originTags } from '../../src/renderer/filesView'
import { PATIENT_GIT_MS, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-turnchg-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTemp(d)
})

const git = gitRunner(gitEnvFrom(cleanEnv(process.env, {})), PATIENT_GIT_MS)
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true })

function repo(): string {
  const root = temp()
  writeFileSync(join(root, 'a.ts'), 'one\n')
  writeFileSync(join(root, 'lock.json'), '{}\n')
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'first')
  return root
}

function world(root: string, opts: { sharing?: string[]; file?: string } = {}) {
  const transcript = join(temp(), 'session.jsonl')
  writeFileSync(transcript, '')
  const agents: AgentInfo[] = [{ id: 'a', title: 'Agent a', cwd: root, transcriptPath: transcript }]
  const statuses = new Map<string, AgentStatus>()
  const listeners: Array<(id: string, s: AgentStatus) => void> = []
  const tmp = { tmpDir: temp(), objectDir: join(temp(), 'objects') }
  const file = opts.file ?? join(temp(), 'files-touched.json')
  const make = () =>
    createFilesTouched({
      agents: () => agents,
      status: (id) => statuses.get(id) ?? 'unknown',
      onStatus: (cb) => listeners.push(cb),
      snapshot: (cwd) => snapshotTree(git, cwd, tmp),
      git,
      store: tmp,
      file,
      pollMs: 60_000,
      saveAfterMs: 5,
      sharing: async () => opts.sharing ?? []
    })
  let service = make()
  const set = (s: AgentStatus): void => {
    statuses.set('a', s)
    for (const cb of listeners) cb('a', s)
  }
  let n = 0
  const line = (path: string, tool: string, target: string): void => {
    const at = new Date().toISOString()
    appendFileSync(target, `${JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Write', input: { file_path: path } }] } })}\n`)
    appendFileSync(target, `${JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] } })}\n`)
  }
  const edit = (path: string): void => line(path, `t${n++}`, transcript)
  const subagentEdit = (agentId: string, path: string): void => {
    const dir = subagentFolder(transcript)
    mkdirSync(dir, { recursive: true })
    line(path, `s${n++}`, join(dir, `agent-${agentId}.jsonl`))
  }
  const turn = async (fn: () => void | Promise<void>): Promise<void> => {
    set('working')
    await service.settled()
    await new Promise((r) => setTimeout(r, 5))
    await fn()
    set('idle')
    await service.settled()
  }
  const restart = async (): Promise<void> => {
    await service.flush()
    service.close()
    listeners.length = 0
    service = make()
  }
  return { get service() { return service }, set, edit, subagentEdit, turn, restart, transcript }
}

const rel = (root: string, path: string): string => path.slice(root.length + 1)

describe('changes made during a turn by commands', { timeout: 30_000 }, () => {
  test("a file a command changed is listed as changed during the turn, never as the agent's edit", async () => {
    const root = repo()
    const w = world(root)
    w.set('idle')
    await w.turn(() => {
      // The agent's own edit, and a file a command (npm install, a formatter) rewrote with no edit call.
      writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
      w.edit(join(root, 'a.ts'))
      writeFileSync(join(root, 'lock.json'), '{"x":1}\n')
      writeFileSync(join(root, 'generated.txt'), 'made by a build\n')
    })
    const files = await w.service.files('a')
    const byPath = Object.fromEntries((files?.files ?? []).map((f) => [rel(root, f.path), f]))
    expect(Object.keys(byPath).sort()).toEqual(['a.ts', 'generated.txt', 'lock.json'])
    expect(byPath['a.ts']).toMatchObject({ edits: 1 })
    expect(byPath['a.ts'].changedInTurns).toBeUndefined()
    expect(byPath['lock.json']).toMatchObject({ edits: 0, changedInTurns: [1], firstTurn: 1, lastTurn: 1, confirmed: true })
    expect(byPath['generated.txt']).toMatchObject({ edits: 0, changedInTurns: [1] })
    expect(files?.turns.at(-1)?.endCheck).toMatchObject({ changed: 2 })
    expect(originTags(byPath['lock.json'])[0].text).toBe('changed during turn 1 (by a command or another process)')
    expect(originTags(byPath['a.ts'])).toEqual([])
    // Its diff is the turn's own: from the snapshot at the start.
    const d = await w.service.diff('a', join(root, 'lock.json'), 'turn')
    expect(d.ok && d.text).toMatch(/^\+\{"x":1\}$/m)
    w.service.close()
  })

  test('a later turn that only a command touches marks a file the agent edited before', async () => {
    const root = repo()
    const w = world(root)
    w.set('idle')
    await w.turn(() => {
      writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
      w.edit(join(root, 'a.ts'))
    })
    await w.turn(() => writeFileSync(join(root, 'a.ts'), 'formatted\n'))
    const a = (await w.service.files('a'))?.files.find((f) => rel(root, f.path) === 'a.ts')
    expect(a).toMatchObject({ edits: 1, firstTurn: 1, lastTurn: 2, changedInTurns: [2] })
    expect(originTags(a!)[0].text).toBe('also changed during turn 2 by a command or another process')
    w.service.close()
  })

  test('with another window in the same checkout nothing is counted, and the turn says why', async () => {
    const root = repo()
    const w = world(root, { sharing: ['Terminal 1'] })
    w.set('idle')
    await w.turn(() => writeFileSync(join(root, 'lock.json'), '{"y":2}\n'))
    const files = await w.service.files('a')
    expect(files?.files).toEqual([])
    const check = files?.turns.at(-1)?.endCheck
    expect(check?.changed).toBe(0)
    expect(check?.problem).toMatch(/Terminal 1 also works in this checkout/)
    expect(endCheckNote(files?.turns.at(-1))).toMatch(/can't be told apart/)
    expect(describeFiles(files!, false)).toMatchObject({ turnEndCheck: check?.problem })
    w.service.close()
  })

  test('outside git there is no snapshot, so nothing is counted, and the reason is kept', async () => {
    const folder = temp()
    const w = world(folder)
    w.set('idle')
    await w.turn(() => writeFileSync(join(folder, 'x.txt'), 'x\n'))
    const check = (await w.service.files('a'))?.turns.at(-1)?.endCheck
    expect(check).toMatchObject({ changed: 0, problem: expect.stringMatching(/Not in a git repository/) })
    w.service.close()
  })
})

describe("a Claude session's subagents", { timeout: 30_000 }, () => {
  test("their edits count, labelled as theirs, and aren't counted again after a restart", async () => {
    const root = repo()
    const file = join(temp(), 'files-touched.json')
    const w = world(root, { file })
    w.set('idle')
    await w.turn(async () => {
      writeFileSync(join(root, 'sub.ts'), 'by the subagent\n')
      w.subagentEdit('a1b2c3', join(root, 'sub.ts'))
      writeFileSync(join(root, 'a.ts'), 'both\n')
      w.edit(join(root, 'a.ts'))
      // Edits of one file at the very same moment read as one edit read twice, so these are a moment apart.
      await new Promise((r) => setTimeout(r, 5))
      w.subagentEdit('d4e5', join(root, 'a.ts'))
    })
    const files = await w.service.files('a')
    const byPath = Object.fromEntries((files?.files ?? []).map((f) => [rel(root, f.path), f]))
    expect(byPath['sub.ts']).toMatchObject({ edits: 1, bySubagent: 1 })
    // Explained by the subagent's edit: not a command's change.
    expect(byPath['sub.ts'].changedInTurns).toBeUndefined()
    expect(byPath['a.ts']).toMatchObject({ edits: 2, bySubagent: 1 })
    expect(originTags(byPath['sub.ts'])[0].text).toBe('by a subagent')
    expect(originTags(byPath['a.ts'])[0].text).toBe('1 of 2 edits by subagents')
    expect(describeFiles(files!, false)).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ bySubagents: 1 })]) })

    await w.restart()
    // Each subagent transcript's read offset moved on to its end and was saved, so nothing is read twice.
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { sessions: { subagents?: Record<string, number> }[] }
    const offsets = saved.sessions[0].subagents ?? {}
    expect(Object.keys(offsets).sort()).toEqual(['agent-a1b2c3.jsonl', 'agent-d4e5.jsonl'])
    for (const [name, at] of Object.entries(offsets)) expect(at).toBe(statSync(join(subagentFolder(w.transcript), name)).size)
    w.set('idle')
    const again = await w.service.files('a')
    expect(again?.files.find((f) => rel(root, f.path) === 'a.ts')).toMatchObject({ edits: 2, bySubagent: 1 })
    w.service.close()
  })
})

describe('the record', () => {
  test('one turn takes at most so many command changes, and says how many more there were', () => {
    const rec = emptyRecord('a', 'C:\\r', 0)
    startTurn(rec, 10)
    const paths = Array.from({ length: MAX_TURN_CHANGES + 7 }, (_, i) => `gen/${i}.txt`)
    expect(addTurnChanges(rec, 1, paths, 20, 'C:\\r', 'win32')).toEqual({ taken: MAX_TURN_CHANGES, more: 7 })
    expect(rec.files).toHaveLength(MAX_TURN_CHANGES)
  })

  test("an edit read late for a turn takes back that turn's command label", () => {
    const rec = emptyRecord('a', 'C:\\r', 0)
    startTurn(rec, 10)
    addTurnChanges(rec, 1, ['x.ts'], 30, 'C:\\r', 'win32')
    addEdit(rec, { path: 'C:\\r\\x.ts', at: 20, confirmed: true }, 'win32')
    expect(rec.files[0]).toMatchObject({ edits: 1, firstAt: 20, firstTurn: 1 })
    expect(rec.files[0].changedInTurns).toBeUndefined()
  })
})

describe('what counts as edited', () => {
  test("a file only a command changed isn't counted as edited in the chip, nor warns another agent", async () => {
    const { findOverlaps, summarize } = await import('../../src/main/files/touched')
    const { chipLabel } = await import('../../src/renderer/filesView')
    const a = emptyRecord('a', 'C:/r', 0)
    startTurn(a, 10)
    addEdit(a, { path: 'C:/r/own.ts', at: 20, confirmed: true }, 'win32')
    addTurnChanges(a, 1, ['shared.ts', 'package-lock.json'], 30, 'C:/r', 'win32')
    const b = emptyRecord('b', 'C:/r', 0)
    addEdit(b, { path: 'C:/r/shared.ts', at: 40, confirmed: true }, 'win32')
    const live = (id: string): string | null => `Agent ${id}`
    const overlaps = findOverlaps([a, b], live, 'win32')
    expect(overlaps.size).toBe(0)
    const summary = summarize([a, b], overlaps)
    expect(summary.a).toEqual({ count: 1, overlap: 0, changed: 2 })
    expect(summary.b).toEqual({ count: 1, overlap: 0 })
    expect(chipLabel(1, 0, 2)).toMatchObject({ text: '1 file +2 by commands' })
    expect(chipLabel(1, 0, 2).title).toMatch(/^This session edited 1 file\. 2 more changed during its turns by a command/)
  })
})

describe('what changed while a session was away (F13)', { timeout: 60_000 }, () => {
  test('the end of a turn is kept, even in a checkout another window shares', async () => {
    const root = repo()
    const w = world(root, { sharing: ['Agent b'] })
    w.set('idle')
    await w.turn(() => writeFileSync(join(root, 'a.ts'), 'one\ntwo\n'))
    const mark = (await w.service.files('a'))?.turns.at(-1)
    expect(mark?.endCheck?.problem).toMatch(/Agent b also works in this checkout/)
    expect(mark?.endTree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(mark?.endHead).toMatch(/^[0-9a-f]{40,64}$/)
    w.service.close()
  })

  test('after a restart, it lists the files and commits since the last turn ended, and nothing when nothing changed', async () => {
    const root = repo()
    const w = world(root)
    w.set('idle')
    await w.turn(() => writeFileSync(join(root, 'a.ts'), 'one\ntwo\n'))
    await w.restart()
    expect(await w.service.awayChanges('a')).toBeNull()

    // Someone else, while it was away: an uncommitted change, a new file, and a commit.
    writeFileSync(join(root, 'lock.json'), '{"x":1}\n')
    writeFileSync(join(root, 'notes.md'), 'new\n')
    sh(root, 'add', 'a.ts')
    sh(root, 'commit', '-q', '-m', 'Keep the second line')
    const away = await w.service.awayChanges('a')
    expect(away).toMatchObject({ files: ['lock.json', 'notes.md'], moreFiles: 0, moreCommits: 0, shared: [] })
    expect(away?.commits).toEqual([expect.stringMatching(/^[0-9a-f]{7,} Keep the second line$/)])
    w.service.close()
  })

  test('a session with no kept end, as one recorded before this, gets nothing', async () => {
    const root = repo()
    const w = world(root)
    expect(await w.service.awayChanges('a')).toBeNull()
    w.service.close()
  })
})

describe('the message Tell it sends', () => {
  test('lists commits and files, caps both with a count, and says when another window shared the checkout', async () => {
    const { awayMessage } = await import('../../src/shared/filesTouched')
    const text = awayMessage({ files: ['a.ts', 'b.ts'], moreFiles: 5, commits: ['abc1234 Fix it'], moreCommits: 2, since: 0, shared: ['Agent b'] }, () => '10:00')
    expect(text).toBe(
      [
        'While you were away (since your last turn ended, 10:00), your checkout changed:',
        'New commits (3):',
        '- abc1234 Fix it',
        '- and 2 more',
        'Files that differ (7):',
        '- a.ts',
        '- b.ts',
        '- and 5 more',
        'Agent b also worked in this checkout, so some of these may be theirs.',
        'Check these before you rely on what you knew of these files.'
      ].join('\n')
    )
    expect(awayMessage({ files: ['a.ts'], moreFiles: 0, commits: [], moreCommits: 0, since: 0, shared: [] }, () => 'x')).not.toMatch(/commits|also worked/)
  })
})
