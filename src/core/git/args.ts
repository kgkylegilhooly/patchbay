import { BRANCH_FORMAT, LOG_FORMAT } from './parse'

/** Every git call goes through these. Paths always follow `--`, so a file named like an option is still a file. */

export const LOG_LIMIT = 300

/** Settings for every call: no colors, no pager, nothing that asks. */
export const GLOBAL = ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'credential.interactive=false']

export const statusArgs = (): string[] => ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']

export function stageArgs(paths: string[] | 'all'): string[] {
  return paths === 'all' ? ['add', '--all'] : ['add', '--', ...paths]
}

/** Before the first commit there's no HEAD to put the index back to, so files are only taken out of it. */
export function unstageArgs(paths: string[] | 'all', hasHead: boolean): string[] {
  if (hasHead) return paths === 'all' ? ['reset', '-q'] : ['reset', '-q', '--', ...paths]
  return paths === 'all' ? ['rm', '--cached', '-r', '-q', '--', '.'] : ['rm', '--cached', '-q', '--', ...paths]
}

/** Tracked files go back to what's staged, or to HEAD. Untracked ones are deleted, so they get their own call. */
export function discardArgs(tracked: string[], untracked: string[]): string[][] {
  const calls: string[][] = []
  if (tracked.length) calls.push(['checkout', '--', ...tracked])
  if (untracked.length) calls.push(['clean', '-f', '-q', '--', ...untracked])
  return calls
}

export function commitArgs(message: string): string[] {
  return ['commit', '-q', '-m', message]
}

export const branchesArgs = (): string[] => ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']

/** A remote branch with no local one becomes a local branch following it. */
export function switchArgs(branch: string, remote: boolean): string[] {
  return remote ? ['switch', '--track', branch] : ['switch', branch]
}

export const createBranchArgs = (branch: string): string[] => ['switch', '-c', branch]

/** Plain names only: anything that could read as an option, or that git would expand, is refused. */
export function plainBranchName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !name.startsWith('-') && !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\/$|\.lock$|^\/|\.$/.test(name) && name !== '@'
}

/** With no upstream yet, the first push sets one, on the only remote or origin. */
export function pushArgs(o: { branch: string | null; upstream: string | null; remote: string | null }): string[] {
  if (o.upstream || !o.branch || !o.remote) return ['push']
  return ['push', '--set-upstream', o.remote, o.branch]
}

export function pullArgs(mode: 'ff-only' | 'merge'): string[] {
  return mode === 'ff-only' ? ['pull', '--ff-only'] : ['pull', '--no-rebase', '--no-edit']
}

export const fetchArgs = (): string[] => ['fetch', '--all', '--prune']

export function logArgs(limit = LOG_LIMIT): string[] {
  return ['log', '--topo-order', `--format=${LOG_FORMAT}`, '-n', String(limit), '--branches', '--remotes', '--tags', 'HEAD', '--']
}

export function diffArgs(path: string, staged: boolean): string[] {
  return ['diff', '--no-ext-diff', '--no-color', ...(staged ? ['--cached'] : []), '--', path]
}

/** The environment for git: nothing inherited may point it elsewhere, and nothing may wait on a person typing. */
export function gitEnvFrom(base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES|ASKPASS)$/i.test(k)) continue
    if (/^SSH_ASKPASS$/i.test(k)) continue
    env[k] = v
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', SSH_ASKPASS_REQUIRE: 'never' }
}
