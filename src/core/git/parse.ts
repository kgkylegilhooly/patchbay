import type { BranchInfo, ChangeEntry, CommitRow, GraphSegment, RepoStatus } from '../../shared/git'

/**
 * Reads `git status --porcelain=v2 --branch -z`. With -z, paths are never quoted, and a rename's old path follows as
 * its own field.
 */
export function parseStatusV2(text: string): RepoStatus {
  const status: RepoStatus = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [] }
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (!f) continue
    if (f.startsWith('# ')) {
      const [, key, ...rest] = f.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = f[0]
    if (kind === '?') {
      status.unstaged.push({ path: f.slice(2), letter: '?', area: 'untracked' })
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path, and 2 adds a score before the path.
      const parts = splitN(f, kind === '1' ? 8 : 9)
      const xy = parts[1]
      const path = parts[parts.length - 1]
      const origPath = kind === '2' ? fields[++i] : undefined
      const entry = (letter: string, area: ChangeEntry['area']): ChangeEntry => ({ path, letter, area, ...(origPath ? { origPath } : {}) })
      if (xy[0] !== '.') status.staged.push(entry(xy[0], 'staged'))
      if (xy[1] !== '.') status.unstaged.push(entry(xy[1], 'unstaged'))
    } else if (kind === 'u') {
      const parts = splitN(f, 10)
      status.conflicts.push({ path: parts[parts.length - 1], letter: 'U', area: 'conflict' })
    }
  }
  return status
}

/** Splits off the first n space-separated fields, keeping the rest whole, since a path may hold spaces. */
function splitN(line: string, n: number): string[] {
  const out: string[] = []
  let rest = line
  for (let k = 0; k < n; k++) {
    const at = rest.indexOf(' ')
    if (at === -1) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)
  return out
}

/** The format given to for-each-ref, which parseBranches reads. Fields end with NUL, one ref per line. */
export const BRANCH_FORMAT = '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)'

export function parseBranches(text: string): BranchInfo[] {
  const out: BranchInfo[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [ref, name, head, upstream, track, oid] = line.split('\0')
    if (!ref || ref.endsWith('/HEAD')) continue
    const remote = ref.startsWith('refs/remotes/')
    if (!remote && !ref.startsWith('refs/heads/')) continue
    const ahead = /ahead (\d+)/.exec(track ?? '')
    const behind = /behind (\d+)/.exec(track ?? '')
    out.push({
      name,
      remote,
      current: head === '*',
      upstream: upstream || null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      gone: (track ?? '').includes('gone'),
      oid: oid ?? ''
    })
  }
  return out
}

/** The format given to git log, which parseLog reads: unit separators between fields, record separators after each. */
export const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e'

export interface RawCommit {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  time: number
  subject: string
}

export function parseLog(text: string): RawCommit[] {
  const out: RawCommit[] = []
  for (const record of text.split('\x1e')) {
    const r = record.replace(/^\s+/, '')
    if (!r) continue
    const [hash, parents, refs, author, time, ...subject] = r.split('\x1f')
    if (!/^[0-9a-f]{7,64}$/.test(hash)) continue
    out.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      refs: refs ? refs.split(', ').map((s) => s.trim()).filter(Boolean) : [],
      author: author ?? '',
      time: Number(time) * 1000 || 0,
      subject: subject.join('\x1f')
    })
  }
  return out
}

/**
 * Lays commits out in lanes, newest first, in the order given (which should be topological). Each lane holds the
 * commit it's waiting to reach. A row's segments run in row units: y 0 is the top edge, 0.5 the commit, 1 the bottom.
 * Lanes never move sideways while passing through, so a segment is either straight down or a single diagonal.
 */
export function layoutGraph(commits: RawCommit[]): CommitRow[] {
  const lanes: (string | null)[] = []
  const rows: CommitRow[] = []
  const known = new Set(commits.map((c) => c.hash))
  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    if (col === -1) {
      col = lanes.indexOf(null)
      if (col === -1) col = lanes.push(null) - 1
    }
    const top = [...lanes]
    const segments: GraphSegment[] = []
    for (let i = 0; i < top.length; i++) {
      const h = top[i]
      if (h === null) continue
      if (h === c.hash) segments.push({ x1: i, y1: 0, x2: col, y2: 0.5, lane: i })
      else segments.push({ x1: i, y1: 0, x2: i, y2: 1, lane: i })
    }
    // Every other lane that was waiting for this commit ends here.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null
    // Parents that aren't in the list would leave lanes open forever, so only those shown get a lane.
    const parents = c.parents.filter((p) => known.has(p))
    parents.forEach((p, n) => {
      // The first parent carries on in this commit's lane, even if another lane already waits for it: the two then
      // meet at that parent, which keeps a branch's own line straight.
      let target = n === 0 && lanes[col] === null ? col : lanes.indexOf(p)
      if (target === col || target === -1) {
        if (target === -1) {
          target = lanes.indexOf(null)
          if (target === -1) target = lanes.push(null) - 1
        }
        lanes[target] = p
      }
      segments.push({ x1: col, y1: 0.5, x2: target, y2: 1, lane: target })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({
      hash: c.hash,
      short: c.hash.slice(0, 7),
      parents: c.parents,
      refs: c.refs,
      author: c.author,
      time: c.time,
      subject: c.subject,
      col,
      width: Math.max(top.length, lanes.length, col + 1),
      merge: c.parents.length > 1,
      segments
    })
  }
  return rows
}
