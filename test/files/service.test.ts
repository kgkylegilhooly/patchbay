import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import { createFilesTouched, diffLabel, type AgentInfo } from '../../src/main/files/service'
import { diffFile, gitRunner, insideRoot, objectEnv, pruneObjects, snapshotTree, UNTRACKED_MAX_BYTES } from '../../src/main/files/snapshot'
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
    const tmp = { tmpDir: temp(), objectDir: join(temp(), 'objects') }
    writeFileSync(join(root, 'new.ts'), 'brand new\n')
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
    const before = sh(root, 'status', '--porcelain')
    const snap = await snapshotTree(git, root, tmp)
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(sh(root, 'status', '--porcelain')).toBe(before)
    expect(await git(root, ['ls-tree', '--name-only', snap.tree], { env: objectEnv(tmp, snap.objects) }).then((r) => r.stdout.split('\n'))).toContain('new.ts')
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\n')
    const later = await snapshotTree(git, join(root), tmp)
    if (!later.ok) throw new Error(later.problem)
    const d = await diffFile(git, root, snap.tree, later.tree, 'a.ts', objectEnv(tmp, later.objects))
    expect(d.ok && d.text).toMatch(/^\+three$/m)
    expect(d.ok && d.text).not.toMatch(/^\+two$/m)
  })

  test('a folder outside git has no snapshot, and says why', async () => {
    const snap = await snapshotTree(git, temp(), { tmpDir: temp(), objectDir: temp() })
    expect(snap).toMatchObject({ ok: false, root: null })
  })

  test("a snapshot's objects go to Patchbay's own folder, never the repository's", async () => {
    const root = repo()
    const store = { tmpDir: temp(), objectDir: join(temp(), 'objects') }
    const loose = (dir: string): number => readdirSync(dir).filter((d) => /^[0-9a-f]{2}$/.test(d)).reduce((n, d) => n + readdirSync(join(dir, d)).length, 0)
    const repoBefore = loose(join(root, '.git', 'objects'))
    writeFileSync(join(root, 'a.ts'), 'changed\n')
    writeFileSync(join(root, 'untracked.ts'), 'new file\n')
    const snap = await snapshotTree(git, root, store)
    expect(snap.ok).toBe(true)
    expect(loose(join(root, '.git', 'objects'))).toBe(repoBefore)
    expect(loose(store.objectDir)).toBeGreaterThan(0)
    // Without Patchbay's folder, the repository can't see the snapshot at all.
    if (snap.ok) expect((await git(root, ['cat-file', '-t', snap.tree], {})).code).not.toBe(0)
  })

  test('untracked files over the size limit are left out, and counted', async () => {
    const root = repo()
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(UNTRACKED_MAX_BYTES + 1))
    writeFileSync(join(root, 'small.ts'), 'x\n')
    const store = { tmpDir: temp(), objectDir: join(temp(), 'objects') }
    const snap = await snapshotTree(git, root, store)
    if (!snap.ok) throw new Error(snap.problem)
    expect(snap.skipped).toBe(1)
    const names = (await git(root, ['ls-tree', '--name-only', snap.tree], { env: objectEnv(store, snap.objects) })).stdout.split('\n')
    expect(names).toContain('small.ts')
    expect(names).not.toContain('big.bin')
  })

  test('the object folder loses old objects, then the oldest until it is small enough', async () => {
    const dir = temp()
    const now = Date.now()
    const put = (name: string, ageDays: number, size: number): void => {
      mkdirSync(join(dir, name.slice(0, 2)), { recursive: true })
      const file = join(dir, name.slice(0, 2), name.slice(2))
      writeFileSync(file, Buffer.alloc(size))
      const t = (now - ageDays * 86400_000) / 1000
      utimesSync(file, t, t)
    }
    put('aa01', 20, 10)
    put('bb02', 5, 100)
    put('cc03', 1, 100)
    expect(await pruneObjects(dir, 10 * 86400_000, 150, now)).toBe(2)
    expect(readdirSync(dir)).toEqual(['cc'])
  })

  test("a diff's label warns when the snapshot finished after the turn's first edit, or left files out", () => {
    const mark = { turn: 3, at: 0, root: null, tree: 't', head: null, doneAt: 500, firstEditAt: 400, skipped: 2 }
    expect(diffLabel(mark, 'turn', true)).toMatch(/^since turn 3 started\. The snapshot finished after that turn's first edit.*\. 2 untracked files were too big/)
    expect(diffLabel({ ...mark, firstEditAt: 600, skipped: 0 }, 'turn', true)).toBe('since turn 3 started')
    expect(diffLabel({ ...mark, firstEditAt: undefined, skipped: 0 }, 'session', false)).toBe('since turn 3 started, the oldest snapshot still kept')
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
  const tmp = { tmpDir: temp(), objectDir: join(temp(), 'objects') }
  const make = () =>
    createFilesTouched({
      agents: () => agents,
      status: (id) => statuses.get(id) ?? 'unknown',
      onStatus: (cb) => listeners.push(cb),
      snapshot: (cwd) => snapshotTree(git, cwd, tmp),
      git,
      store: tmp,
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

  test('long transcripts seen for the first time are read in pieces, one at a time, and nothing is missed', async () => {
    const root = repo()
    const w = world(root, ['a', 'b'])
    const filler = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] } })}
`.repeat(1200)
    for (const id of ['a', 'b']) {
      appendFileSync(w.transcripts[id], filler)
      w.edit(id, join(root, `${id}.ts`))
      appendFileSync(w.transcripts[id], filler)
    }
    expect(readFileSync(w.transcripts.a).length).toBeGreaterThan(4 * 1024 * 1024)
    const [fa, fb] = await Promise.all([w.service.files('a'), w.service.files('b')])
    expect(fa?.files.map((f) => f.path)).toEqual([join(root, 'a.ts')])
    expect(fb?.files.map((f) => f.path)).toEqual([join(root, 'b.ts')])
    w.service.close()
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
    files: async (id: string) => (asked.push(id), { nodeId: id, cwd: 'C:\\r', truncated: false, overlaps: { 'C:\\r\\b.ts': [{ nodeId: 'linked', title: 'Linked' }] }, turns: [{ turn: 2, at: 0, root: 'C:\\r', tree: 't', head: null }], files: [{ path: 'C:\\r\\b.ts', firstAt: 1, lastAt: 2, firstTurn: 2, lastTurn: 2, edits: 1, confirmed: false }, { path: 'C:\\r\\a.ts', firstAt: 0, lastAt: 1, firstTurn: 1, lastTurn: 1, edits: 1, confirmed: true }] })
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

  test('another agent that edited the same file is named only if the caller may read it', async () => {
    const shown = (await verbs('mine', 'files', {})) as { files: Array<{ alsoEditedBy?: string[] }> }
    expect(shown.files[0].alsoEditedBy).toEqual(["1 other agent you aren't linked to"])
  })

  test('lists newest first, marks unconfirmed and shared files, and --turn keeps the latest turn', async () => {
    const all = (await verbs('me', 'files', {})) as { files: Array<{ path: string; unconfirmed?: string; alsoEditedBy?: string[] }>; turn: number }
    expect(all.turn).toBe(2)
    expect(all.files.map((f) => f.path)).toEqual(['C:\\r\\b.ts', 'C:\\r\\a.ts'])
    expect(all.files[0].unconfirmed).toBeTruthy()
    expect(all.files[0].alsoEditedBy).toEqual(['Linked (linked)'])
    const turn = (await verbs('me', 'files', { turn: true })) as { files: Array<{ path: string }> }
    expect(turn.files.map((f) => f.path)).toEqual(['C:\\r\\b.ts'])
  })

  test('other verbs pass through', async () => {
    await verbs('me', 'list', {})
    expect(passed).toEqual(['list'])
  })
})

