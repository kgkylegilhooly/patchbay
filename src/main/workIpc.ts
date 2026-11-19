import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ipcMain, shell } from 'electron'
import { gitEnvFrom } from '../core/git/args'
import { createGitService, GitFailure, systemGit, type GitService } from '../core/git/service'
import { ghFailure, isGithubPage, issueListArgs, issueViewArgs, issueWriteArgs, parseIssues, parsePrs, prListArgs, REPO_SLUG, repoFromRemote, systemGh, type Gh } from '../core/github/gh'
import { createWorktree } from '../core/worktree/service'
import type { CanvasStore } from '../shared/contract'
import type { GithubIssue, GithubPr } from '../shared/git'
import { isSessionNode, type CanvasDoc, type CanvasNode, type ClaudeNode, type GroupNode } from '../shared/model'
import { cleanEnv } from './sessions/env'
import { agentOffNow } from './agentsAllowed'

const key = (p: string): string => resolve(p).toLowerCase()

/** Folders the canvas itself names: project folders, worktree groups and session folders. Nothing else can be opened. */
export function knownFolders(doc: CanvasDoc): Set<string> {
  const out = new Set<string>()
  for (const p of doc.projects) if (p.folder) out.add(key(p.folder))
  for (const n of doc.nodes) {
    if (n.kind === 'group' && n.worktree) out.add(key(n.worktree.path))
    if (isSessionNode(n) && n.cwd) out.add(key(n.cwd))
  }
  return out
}

/** Reads GitHub for a project. Shared by the board and the agents' read-only verbs. */
export function createGithubReader(store: CanvasStore, git: GitService, gh: Gh) {
  async function repoFor(projectId: string | undefined, cwd?: string): Promise<string> {
    const doc = store.get()
    const project = doc.projects.find((p) => p.id === (projectId ?? doc.activeProjectId))
    const override = project?.board?.issues?.repo
    if (override) {
      if (!REPO_SLUG.test(override)) throw new GitFailure(`"${override}" isn't a GitHub repository name. Use owner/name.`)
      return override
    }
    for (const folder of [cwd, project?.folder]) {
      if (!folder) continue
      const root = await git.toplevel(folder)
      const url = root && (await git.originUrl(root))
      const repo = url && repoFromRemote(url)
      if (repo) return repo
    }
    throw new GitFailure("No GitHub repository found: this project's folder has no github.com origin. Set one in the board's issue settings.")
  }
  const run = async (args: string[]): Promise<string> => {
    const r = await gh(args)
    if (r.code !== 0) throw new GitFailure(ghFailure(r))
    return r.stdout
  }
  return {
    repoFor,
    async issues(repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 100): Promise<GithubIssue[]> {
      return parseIssues(await run(issueListArgs(repo, state, limit)))
    },
    async issue(repo: string, n: number): Promise<GithubIssue | undefined> {
      return parseIssues(await run(issueViewArgs(repo, n)))[0]
    },
    async prs(repo: string, state: 'open' | 'closed' | 'merged' | 'all' = 'open', limit = 50): Promise<GithubPr[]> {
      return parsePrs(await run(prListArgs(repo, state, limit)))
    }
  }
}

export type GithubReader = ReturnType<typeof createGithubReader>

export function workServices(): { git: GitService; gh: Gh } {
  const env = gitEnvFrom(cleanEnv(process.env, {}))
  return { git: createGitService(systemGit(env)), gh: systemGh(cleanEnv(process.env, {}), process.env.PATCHBAY_GH || 'gh') }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Serves `pb:work:*`, the git panel's and the board's channels. See src/preload/work.ts. */
export function registerWorkIpc(s: { store: CanvasStore; startNode: (id: string) => Promise<void>; git: GitService; gh: Gh; reader: GithubReader }): void {
  const { store, git, gh, reader } = s
  /** Only repositories found from the canvas's own folders can be acted on. */
  const approved = new Set<string>()
  const handle = (name: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(`pb:work:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  const guarded = <A extends unknown[], R>(fn: (root: string, ...a: A) => Promise<R>) =>
    async (root: string, ...a: A): Promise<R | { ok: false; error: string }> => {
      if (typeof root !== 'string' || !approved.has(key(root))) return { ok: false, error: 'Choose a repository from the list first.' }
      try {
        return await fn(resolve(root), ...a)
      } catch (e) {
        return { ok: false, error: message(e) }
      }
    }

  handle('gitRepos', async (folders: { path: string; label: string }[]) => {
    const known = knownFolders(store.get())
    const list = Array.isArray(folders) ? folders.filter((f) => typeof f?.path === 'string' && known.has(key(f.path))).slice(0, 40) : []
    const roots = await Promise.all(list.map(async (f) => ({ root: await git.toplevel(f.path), label: String(f.label).slice(0, 120) })))
    const seen = new Set<string>()
    const out: { root: string; label: string }[] = []
    for (const r of roots) {
      if (!r.root || seen.has(key(r.root))) continue
      seen.add(key(r.root))
      approved.add(key(r.root))
      out.push({ root: r.root, label: r.label })
    }
    return out
  })
  handle('gitStatus', guarded(async (root) => ({ ok: true as const, status: await git.status(root) })))
  handle('gitDiff', guarded(async (root, path: string, staged: boolean) => ({ ok: true as const, diff: await git.diff(root, String(path), !!staged) })))
  const paths = (p: unknown): string[] | 'all' => (p === 'all' ? 'all' : Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [])
  handle('gitStage', guarded((root, p: unknown) => git.stage(root, paths(p))))
  handle('gitUnstage', guarded((root, p: unknown) => git.unstage(root, paths(p))))
  handle('gitDiscard', guarded((root, p: unknown) => git.discard(root, paths(p) === 'all' ? [] : (paths(p) as string[]))))
  handle('gitCommit', guarded((root, m: unknown) => git.commit(root, String(m ?? ''))))
  handle('gitBranches', guarded(async (root) => ({ ok: true as const, branches: await git.branches(root) })))
  handle('gitSwitch', guarded((root, b: unknown) => git.switchTo(root, String(b))))
  handle('gitCreateBranch', guarded((root, b: unknown) => git.createBranch(root, String(b))))
  handle('gitPush', guarded((root) => git.push(root)))
  handle('gitPull', guarded((root, mode: unknown) => git.pull(root, mode === 'merge' ? 'merge' : 'ff-only')))
  handle('gitFetch', guarded((root) => git.fetch(root)))
  handle('gitLog', guarded(async (root) => ({ ok: true as const, ...(await git.log(root)) })))

  handle('githubRepo', async (projectId: string) => {
    try {
      return { ok: true, repo: await reader.repoFor(projectId) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })
  handle('githubIssues', async (projectId: string) => {
    try {
      const repo = await reader.repoFor(projectId)
      return { ok: true, repo, issues: await reader.issues(repo) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })
  // The only route that writes to GitHub. The renderer calls it from the owner's click, after a confirm.
  handle('githubIssueAction', async (projectId: string, n: number, action: { kind: string; body?: string }) => {
    try {
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'No such issue.' }
      const repo = await reader.repoFor(projectId)
      const act = action?.kind === 'close' ? { kind: 'close' as const } : action?.kind === 'reopen' ? { kind: 'reopen' as const } : action?.kind === 'comment' && action.body?.trim() ? { kind: 'comment' as const, body: action.body.slice(0, 60000) } : null
      if (!act) return { ok: false, error: 'Nothing to do.' }
      const r = await gh(issueWriteArgs(repo, n, act))
      return r.code === 0 ? { ok: true, output: `${r.stdout}${r.stderr}`.trim() } : { ok: false, error: ghFailure(r) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })
  handle('openGithubPage', async (url: string) => {
    if (typeof url !== 'string' || !isGithubPage(url)) return false
    await shell.openExternal(url)
    return true
  })

  handle('startIssueAgent', async (a: { projectId: string; number: number; prompt: string; title: string; worktreeBranch?: string }) => {
    // Settings > Agents: an issue's agent is Claude Code. Refused before any worktree, group or node is made.
    const off = agentOffNow('claude')
    if (off) return { ok: false, error: off }
    try {
      const doc = store.get()
      const project = doc.projects.find((p) => p.id === a?.projectId)
      if (!project) return { ok: false, error: 'That project is gone.' }
      if (typeof a.prompt !== 'string' || !a.prompt.trim() || a.prompt.length > 28000) return { ok: false, error: 'The prompt is empty or too long.' }
      const top = doc.nodes.filter((n) => n.projectId === project.id && !n.parentId)
      const x = top.length ? Math.max(...top.map((n) => n.x + n.width)) + 40 : 0
      const y = top.length ? Math.min(...top.map((n) => n.y)) : 0
      const id = randomUUID()
      const title = String(a.title || `Issue #${a.number}`).slice(0, 80)
      let parentId: string | null = null
      let cwd = project.folder || homedir()
      if (a.worktreeBranch) {
        const repo = project.folder && (await git.toplevel(project.folder))
        if (!repo) return { ok: false, error: "The project's folder isn't in a git repository, so no worktree can be made." }
        const worktree = await createWorktree({ repo, branch: a.worktreeBranch })
        const group: GroupNode = { id: randomUUID(), kind: 'group', title: `#${a.number} ${a.worktreeBranch}`, x, y, width: 668, height: 508, parentId: null, projectId: project.id, worktree }
        store.dispatch({ op: 'addNode', node: group })
        parentId = group.id
        cwd = worktree.path
      }
      const node: ClaudeNode = {
        id, kind: 'claude', title, cwd, prompt: a.prompt, sessionId: null, transcriptPath: null, after: [],
        x: parentId ? 24 : x, y: parentId ? 64 : y, width: 620, height: 420, parentId, projectId: project.id
      }
      store.dispatch({ op: 'addNode', node: node as CanvasNode })
      await s.startNode(id)
      return { ok: true, nodeId: id }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })
}
