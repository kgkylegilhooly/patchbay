import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { gitEnvFrom, NO_FSMONITOR } from '../core/git/args'
import { LIMITS, systemGit, type Git } from '../core/git/service'
import { readMessagesTail } from '../core/transcript/read'
import { lastReplyOf } from './lastReply'
import { cleanEnv } from './sessions/env'
import { pickOrStub } from './testPickers'
import type { CanvasStore } from '../shared/contract'
import { agentOf, type AgentStatus, type CanvasNode, type ClaudeNode } from '../shared/model'
import type { SessionFiles } from '../shared/filesTouched'
import { checkDocPath, systemFolders } from './reader/policy'
import { asMarkdownPath, handoffFileName } from './search/saveHandoff'

/**
 * F66, a group's report: after a team run, writing up what each member did meant opening each one. One Markdown file
 * holds each agent's last reply and the files it edited, then the commits only on the group's branch.
 */

/** A reply this long is cut: the report is for reading through, and the conversation is still there. */
const MAX_REPLY = 4000
const MAX_FILES = 50

/** The agents inside a group, at any depth, in canvas order. */
export function membersOf(nodes: CanvasNode[], groupId: string): ClaudeNode[] {
  const inside = new Set([groupId])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
  }
  return nodes.filter((n): n is ClaudeNode => n.kind === 'claude' && n.id !== groupId && inside.has(n.id))
}

export interface ReportMember {
  title: string
  cwd: string
  agent: string
  status: string
  reply: string | null
  /** Relative to its folder where they're inside it. */
  files: string[]
  uncommitted: string[]
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

export function groupReportMarkdown(g: { title: string; worktree?: { path: string; branch: string } | null }, members: ReportMember[], commits: string[] | null, now: Date): string {
  const where = g.worktree ? `, on branch \`${g.worktree.branch}\` in \`${g.worktree.path}\`` : ''
  const parts = [`# Report: ${g.title}`, '', `Saved from Patchbay on ${stamp(now)}. ${members.length} agent${members.length === 1 ? '' : 's'}${where}.`, '']
  for (const m of members) {
    parts.push(`## ${m.title}`, '', `${m.agent} in \`${m.cwd}\` · ${m.status}`, '')
    if (m.reply) {
      const reply = m.reply.length > MAX_REPLY ? `${m.reply.slice(0, MAX_REPLY)}…` : m.reply
      parts.push('### Last reply', '', reply.trim(), '')
    } else parts.push('No reply yet.', '')
    if (m.files.length) {
      const open = new Set(m.uncommitted)
      parts.push(`### Files it edited (${m.files.length})`, '', ...m.files.slice(0, MAX_FILES).map((f) => `- \`${f}\`${open.has(f) ? ' (uncommitted)' : ''}`))
      if (m.files.length > MAX_FILES) parts.push(`- and ${m.files.length - MAX_FILES} more`)
      parts.push('')
    } else parts.push('No files edited.', '')
  }
  if (g.worktree && commits?.length) parts.push(`## Commits only on \`${g.worktree.branch}\` (${commits.length})`, '', ...commits.map((c) => `- ${c}`), '')
  return parts.join('\n')
}

const STATUS: Record<string, string> = { idle: 'Idle', working: 'Working', 'needs-you': 'Waiting on you', exited: 'Exited', queued: 'Waiting to start', unknown: 'No status yet' }

/** A path as the report shows it: relative to the agent's folder when it's inside it, with forward slashes. */
function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).split('\\').join('/')
}

export type SaveReportResult = { ok: true; path: string; members: number } | { ok: false; reason: string; cancelled?: true }

export interface GroupReportDeps {
  store: CanvasStore
  home: string
  status: (id: string) => AgentStatus | undefined
  files: { files(id: string): Promise<SessionFiles | null>; uncommitted(id: string): Promise<string[]> }
  /** The agent's latest answer, or null. */
  readReply(transcriptPath: string): Promise<string | null>
  /** One line per commit only on the worktree's branch (on no other branch or remote), or null when that can't be read. */
  commits(worktreePath: string): Promise<string[] | null>
  pickFile(defaultPath: string): Promise<string | null>
  writeFile(path: string, text: string, exclusive: boolean): Promise<void>
  now?: () => Date
  system?: string[]
}

export function createGroupReportSaver(d: GroupReportDeps) {
  const system = d.system ?? systemFolders()
  return async function saveGroupReport(groupId: string): Promise<SaveReportResult> {
    const doc = d.store.get()
    const g = doc.nodes.find((n) => n.id === groupId)
    if (g?.kind !== 'group') return { ok: false, reason: 'That is not a group.' }
    const agents = membersOf(doc.nodes, groupId)
    if (!agents.length) return { ok: false, reason: `${g.title} has no agents to report on.` }
    const members = await Promise.all(
      agents.map(async (a): Promise<ReportMember> => {
        const [reply, touched, open] = await Promise.all([
          a.transcriptPath ? d.readReply(a.transcriptPath).catch(() => null) : Promise.resolve(null),
          d.files.files(a.id).catch(() => null),
          d.files.uncommitted(a.id).catch(() => [] as string[])
        ])
        return {
          title: a.title,
          cwd: a.cwd,
          agent: agentOf(a) === 'codex' ? 'Codex' : 'Claude Code',
          status: STATUS[d.status(a.id) ?? 'unknown'] ?? 'No status yet',
          reply,
          files: (touched?.files ?? []).map((f) => shown(f.path, a.cwd)),
          uncommitted: open.map((f) => shown(isAbsolute(f) ? f : resolve(a.cwd, f), a.cwd))
        }
      })
    )
    const commits = g.worktree ? await d.commits(g.worktree.path).catch(() => null) : null
    const folder = g.worktree?.path || agents[0].cwd || d.home
    const picked = await d.pickFile(join(folder, handoffFileName(`${g.title} report`)))
    if (!picked) return { ok: false, cancelled: true, reason: 'Not saved.' }
    const check = checkDocPath(asMarkdownPath(picked), system)
    if (!check.ok) return { ok: false, reason: check.reason }
    // The dialog asked before replacing the name it gave. A name changed here wasn't asked about, so it never replaces.
    const changed = check.path.toLowerCase() !== resolve(picked).toLowerCase()
    try {
      await d.writeFile(check.path, groupReportMarkdown(g, members, commits, (d.now ?? (() => new Date()))()), changed)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return { ok: false, reason: code === 'EEXIST' ? 'That file already exists. Save again and pick another name.' : `The report couldn't be saved: ${(e as Error).message}` }
    }
    return { ok: true, path: check.path, members: members.length }
  }
}

/**
 * One line per commit on the checked-out branch and no other, local or remote: the team's own work, whether or not
 * there's a remote. Null when git can't say.
 */
export async function branchOnlyCommits(git: Git, path: string): Promise<string[] | null> {
  const head = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], LIMITS.read)
  if (head.code !== 0) return null
  // An --exclude for --branches is the bare branch name: one starting "refs/heads/" excludes nothing (git-log docs).
  const r = await git(path, ['log', '--format=%h %s', '-n', '30', 'HEAD', '--not', `--exclude=${head.stdout.trim()}`, '--branches', '--remotes'], LIMITS.read)
  return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : null
}

/** pb:report:save, for the app's own window only. */
export function serveGroupReport(
  d: { store: CanvasStore; status: (id: string) => AgentStatus | undefined; files: GroupReportDeps['files'] },
  isAppUi: (e: IpcMainInvokeEvent) => boolean
): void {
  // An agent may have written this repository's config, so no program it names runs (GX1).
  const git = systemGit(gitEnvFrom(cleanEnv(process.env, {})), NO_FSMONITOR)
  const save = createGroupReportSaver({
    store: d.store,
    home: homedir(),
    status: d.status,
    files: d.files,
    readReply: async (path) => lastReplyOf(await readMessagesTail(path, 30)),
    commits: (path) => branchOnlyCommits(git, path),
    writeFile: (p, text, exclusive) => writeFile(p, text.endsWith('\n') ? text : `${text}\n`, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' }),
    // Off-screen test and screenshot runs answer with PATCHBAY_TEST_SAVE_AS instead of opening the dialog (testPickers.ts).
    pickFile: (defaultPath) =>
      pickOrStub('save', async () => {
        const options: Electron.SaveDialogOptions = { title: 'Save the report', defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] }
        const win = BrowserWindow.getFocusedWindow()
        const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        return r.canceled || !r.filePath ? null : r.filePath
      })
  })
  ipcMain.handle('pb:report:save', (e, groupId: unknown) => (isAppUi(e) && typeof groupId === 'string' ? save(groupId) : { ok: false, reason: 'Not allowed.' }))
}
