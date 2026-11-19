import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import { createFilesTouched, type AgentInfo } from '../../src/main/files/service'
import { diffFile, gitRunner, insideRoot, snapshotTree } from '../../src/main/files/snapshot'
import { withFilesVerbs } from '../../src/main/files/verbs'
import { cleanEnv } from '../../src/main/sessions/env'
import type { CanvasStore } from '../../src/shared/contract'
import type { FilesSummary } from '../../src/shared/filesTouched'
import type { AgentStatus, CanvasDoc, ClaudeNode } from '../../src/shared/model'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-files-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const git = gitRunner(gitEnvFrom(cleanEnv(process.env, {})))
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true })

function repo(): string {
  const root = temp()
  writeFileSync(join(root, 'a.ts'), 'one\n')
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'first')
  return root
}

describe('snapshots', () => {
  test('a snapshot holds untracked files and leaves the real index and status alone', async () => {
    const root = repo()
    const tmp = temp()
    writeFileSync(join(root, 'new.ts'), 'brand new\n')
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
    const before = sh(root, 'status', '--porcelain')
    const snap = await snapshotTree(git, root, tmp)
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(sh(root, 'status', '--porcelain')).toBe(before)
    expect(sh(root, 'ls-tree', '--name-only', snap.tree).split('\n')).toContain('new.ts')
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\n')
    const later = await snapshotTree(git, join(root), tmp)
    if (!later.ok) throw new Error(later.problem)
    const d = await diffFile(git, root, snap.tree, later.tree, 'a.ts')
    expect(d.ok && d.text).toMatch(/^\+three$/m)
    expect(d.ok && d.text).not.toMatch(/^\+two$/m)
  })

  test('a folder outside git has no snapshot, and says why', async () => {
    const snap = await snapshotTree(git, temp(), temp())
    expect(snap).toMatchObject({ ok: false, root: null })
  })

  test('only paths inside the checkout can be diffed', () => {
    expect(insideRoot('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
    expect(insideRoot('C:\\repo', 'C:\\other\\a.ts')).toBeNull()
    expect(insideRoot('C:\\repo', 'D:\\repo\\a.ts')).toBeNull()
  })
})

/** A canvas of agents whose statuses the test sets, with a transcript each. */
function world(root: string, ids: string[]) {
  const transcripts = Object.fromEntries(ids.map((id) => [id, join(temp(), `${id}.jsonl`)]))
  for (const t of Object.values(transcripts)) writeFileSync(t, '')
  let agents: AgentInfo[] = ids.map((id) => ({ id, title: `Agent ${id}`, cwd: root, transcriptPath: transcripts[id] }))
  const statuses = new Map<string, AgentStatus>()
  const listeners: Array<(id: string, s: AgentStatus) => void> = []
  const pushed: FilesSummary[] = []
  const file = join(temp(), 'files-touched.json')
  const tmp = temp()
  const make = () =>
    createFilesTouched({
      agents: () => agents,
      status: (id) => statuses.get(id) ?? 'unknown',
      onStatus: (cb) => listeners.push(cb),
      snapshot: (cwd) => snapshotTree(git, cwd, tmp),
      git,
      file,
      push: (s) => pushed.push(s),
      pollMs: 60_000,
      saveAfterMs: 5
    })
  const service = make()
  const set = (id: string, s: AgentStatus): void => {
    statuses.set(id, s)
    for (const cb of listeners) cb(id, s)
  }
  let n = 0
  const edit = (id: string, path: string, outcome: 'ok' | 'error' | 'none' = 'ok'): void => {
    const tool = `t${n++}`
    const at = new Date().toISOString()
    appendFileSync(transcripts[id], `${JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Edit', input: { file_path: path } }] } })}\n`)
    if (outcome !== 'none') appendFileSync(transcripts[id], `${JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'done', ...(outcome === 'error' ? { is_error: true } : {}) }] } })}\n`)
  }
  return { service, make, set, edit, pushed, file, transcripts, setAgents: (a: AgentInfo[]) => (agents = a), agents: () => agents }
}

const turn = async (w: ReturnType<typeof world>, id: string, fn: () => void): Promise<void> => {
  w.set(id, 'working')
  await w.service.settled()
  // Edits come after the turn starts.
  await new Promise((r) => setTimeout(r, 5))
  fn()
  w.set(id, 'idle')
  await w.service.settled()
}

describe('the service', () => {
  test('a turn takes a snapshot, its edits are read from the transcript, and its diff shows only that turn', async () => {
    const root = repo()
    const w = world(root, ['a'])
    w.set('a', 'idle')
    await turn(w, 'a', () => {
      writeFileSync(join(root, 'a.ts'), 'one\nfirst turn\n')
      w.edit('a', join(root, 'a.ts'))
    })
    await turn(w, 'a', () => {
      writeFileSync(join(root, 'a.ts'), 'one\nfirst turn\nsecond turn\n')
      writeFileSync(join(root, 'b.ts'), 'new\n')
      w.edit('a', join(root, 'a.ts'))
      w.edit('a', join(root, 'b.ts'), 'none')
      w.edit('a', join(root, 'c.ts'), 'error')
    })
    const files = await w.service.files('a')
    expect(files?.turns.map((t) => t.turn)).toEqual([1, 2])
    expect(files?.turns.every((t) => t.tree)).toBe(true)
    expect(files?.files.map((f) => [f.path.slice(root.length + 1), f.firstTurn, f.lastTurn, f.confirmed]).sort()).toEqual([
      ['a.ts', 1, 2, true],
      ['b.ts', 2, 2, false]
    ])
    const thisTurn = await w.service.diff('a', join(root, 'a.ts'), 'turn')
    expect(thisTurn.ok && thisTurn.text).toMatch(/^\+second turn$/m)
    expect(thisTurn.ok && thisTurn.text).not.toMatch(/^\+first turn$/m)
    const session = await w.service.diff('a', join(root, 'a.ts'), 'session')
    expect(session.ok && session.text).toMatch(/^\+first turn$/m)
    // A new, untracked file shows in full.
    const added = await w.service.diff('a', join(root, 'b.ts'), 'turn')
    expect(added.ok && added.text).toMatch(/^\+new$/m)
    // Only files it edited.
    expect(await w.service.diff('a', join(root, 'c.ts'), 'turn')).toMatchObject({ ok: false })
    w.service.close()
  })

  test('two live agents editing one file are flagged, until one exits', async () => {
    const root = repo()
    const w = world(root, ['a', 'b'])
    w.set('a', 'idle')
    w.set('b', 'idle')
    await turn(w, 'a', () => w.edit('a', join(root, 'a.ts')))
    await turn(w, 'b', () => w.edit('b', join(root, 'A.ts'.toLowerCase())))
    expect(w.service.summary()).toEqual({ a: { count: 1, overlap: 1 }, b: { count: 1, overlap: 1 } })
    expect(w.pushed.at(-1)).toEqual({ a: { count: 1, overlap: 1 }, b: { count: 1, overlap: 1 } })
    expect((await w.service.files('a'))?.overlaps[join(root, 'a.ts')]).toEqual([{ nodeId: 'b', title: 'Agent b' }])
    w.set('b', 'exited')
    expect(w.pushed.at(-1)).toEqual({ a: { count: 1, overlap: 0 }, b: { count: 1, overlap: 0 } })
    w.service.close()
  })

  test('a session found already working starts no turn; one seen idle first does', async () => {
    const root = repo()
    const w = world(root, ['a'])
    w.set('a', 'working')
    await w.service.settled()
    expect((await w.service.files('a'))?.turns ?? []).toEqual([])
    w.set('a', 'idle')
    w.set('a', 'working')
    w.set('a', 'needs-you')
    w.set('a', 'working')
    await w.service.settled()
    expect((await w.service.files('a'))?.turns.map((t) => t.turn)).toEqual([1])
    w.service.close()
  })

  test('records and the read offset are saved, so a restart reads on from where it was', async () => {
    const root = repo()
    const w = world(root, ['a'])
    w.set('a', 'idle')
    await turn(w, 'a', () => w.edit('a', join(root, 'a.ts')))
    await w.service.flush()
    w.service.close()
    const saved = JSON.parse(readFileSync(w.file, 'utf8'))
    expect(saved.sessions[0].offset).toBe(readFileSync(w.transcripts.a).length)
    const again = w.make()
    expect((await again.files('a'))?.files).toHaveLength(1)
    expect((await again.files('a'))?.files[0].edits).toBe(1)
    expect(again.byTranscript(w.transcripts.a)?.nodeId).toBe('a')
    again.close()
  })

  test('a transcript that changes (a new conversation in the node) is read from its start', async () => {
    const root = repo()
    const w = world(root, ['a'])
    w.set('a', 'idle')
    await turn(w, 'a', () => w.edit('a', join(root, 'a.ts')))
    const fresh = join(temp(), 'next.jsonl')
    writeFileSync(fresh, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: join(root, 'z.ts') } }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })}\n`)
    w.setAgents(w.agents().map((a) => ({ ...a, transcriptPath: fresh })))
    expect((await w.service.files('a'))?.files.map((f) => f.path.slice(root.length + 1)).sort()).toEqual(['a.ts', 'z.ts'])
    w.service.close()
  })
})

describe('patchbay files', () => {
  const node = (id: string, extra: Partial<ClaudeNode> = {}): ClaudeNode => ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:\\r', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', ...extra })
  const doc = {
    nodes: [node('me'), node('mine', { openedBy: 'me' }), node('linked'), node('other'), { id: 'term', kind: 'terminal', title: 't', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:\\r', projectId: 'p1', openedBy: 'me' }],
    edges: [{ id: 'e', from: 'linked', to: 'me', kind: 'link' }]
  } as unknown as CanvasDoc
  const store = { get: () => doc } as unknown as CanvasStore
  const asked: string[] = []
  const service = {
    files: async (id: string) => (asked.push(id), { nodeId: id, cwd: 'C:\\r', truncated: false, overlaps: { 'C:\\r\\b.ts': [{ nodeId: 'other', title: 'Other' }] }, turns: [{ turn: 2, at: 0, root: 'C:\\r', tree: 't', head: null }], files: [{ path: 'C:\\r\\b.ts', firstAt: 1, lastAt: 2, firstTurn: 2, lastTurn: 2, edits: 1, confirmed: false }, { path: 'C:\\r\\a.ts', firstAt: 0, lastAt: 1, firstTurn: 1, lastTurn: 1, edits: 1, confirmed: true }] })
  } as never
  const passed: string[] = []
  const verbs = withFilesVerbs(async (_c, verb) => (passed.push(verb), {}), { store, service })

  test('reads itself, a node it opened, or one linked to it; refuses others', async () => {
    await verbs('me', 'files', {})
    await verbs('me', 'files', { node: 'mine' })
    await verbs('me', 'files', { node: 'linked' })
    expect(asked).toEqual(['me', 'mine', 'linked'])
    await expect(verbs('me', 'files', { node: 'other' })).rejects.toThrow(/isn't linked to you/)
    await expect(verbs('me', 'files', { node: 'term' })).rejects.toThrow(/not an agent/)
    await expect(verbs('me', 'files', { node: 'gone' })).rejects.toThrow(/no node/)
  })

  test('lists newest first, marks unconfirmed and shared files, and --turn keeps the latest turn', async () => {
    const all = (await verbs('me', 'files', {})) as { files: Array<{ path: string; unconfirmed?: string; alsoEditedBy?: string[] }>; turn: number }
    expect(all.turn).toBe(2)
    expect(all.files.map((f) => f.path)).toEqual(['C:\\r\\b.ts', 'C:\\r\\a.ts'])
    expect(all.files[0].unconfirmed).toBeTruthy()
    expect(all.files[0].alsoEditedBy).toEqual(['Other (other)'])
    const turn = (await verbs('me', 'files', { turn: true })) as { files: Array<{ path: string }> }
    expect(turn.files.map((f) => f.path)).toEqual(['C:\\r\\b.ts'])
  })

  test('other verbs pass through', async () => {
    await verbs('me', 'list', {})
    expect(passed).toEqual(['list'])
  })
})

