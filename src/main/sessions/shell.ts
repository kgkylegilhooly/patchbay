import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { builtInProfiles, GIT_BASH, GIT_BASH_ARGS, profileForNode, profileList, shellKind, startupLines, type ProfileList, type ProfileSettings, type TerminalProfile } from '../../shared/terminalProfiles'

/**
 * Whether Claude Code will run hook and status line commands through Git Bash, as it does on Windows wherever it finds
 * one: then those commands can be bash. Its own setting first, then the usual install.
 */
export function claudeRunsBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): boolean {
  const own = env.CLAUDE_CODE_GIT_BASH_PATH
  if (own) return exists(own)
  return exists(GIT_BASH)
}

/** The shell run nodes use: the `shell` setting, else Git Bash, else PowerShell. Terminals use profiles instead. */
export function pickDefaultShell(settingsShell?: string): { file: string; args: string[] } {
  if (settingsShell) return { file: settingsShell, args: [] }
  if (existsSync(GIT_BASH)) return { file: GIT_BASH, args: [...GIT_BASH_ARGS] }
  return { file: 'powershell.exe', args: [] }
}

/** The shells installed on this PC that terminal profiles are offered for. */
export function detectBuiltInProfiles(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): TerminalProfile[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const system = join(env.SystemRoot ?? 'C:\\Windows', 'System32')
  const pwsh = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  return builtInProfiles({ gitBash: exists(GIT_BASH), pwsh: exists(pwsh) ? pwsh : null, wsl: exists(join(system, 'wsl.exe')) })
}

/** Every terminal profile, the default first. */
export function terminalProfiles(settings: ProfileSettings, builtIns: TerminalProfile[] = detectBuiltInProfiles()): ProfileList {
  return profileList(settings, builtIns)
}

/** Runs the command, then leaves the shell open for more, as PowerShell's -NoExit and cmd's /k do. */
export function terminalArgs(shell: string, command: string): string[] {
  const kind = shellKind(shell)
  // bash -c ends with its command, so a terminal that ran `npm test` closed, with nothing to run it again in.
  if (kind === 'git-bash' || kind === 'bash') return ['--login', '-i', '-c', `${command}\nexec bash --login -i`]
  if (kind === 'powershell') return ['-NoExit', '-Command', command]
  if (kind === 'cmd') return ['/k', command]
  return ['-c', command]
}

export interface TerminalLaunch {
  file: string
  args: string[]
  /** Lines to type at the shell's first prompt, in order. */
  typed: string[]
  profile: TerminalProfile
  /** The id the node recorded, when that profile has since been deleted. */
  missing?: string
}

const sameArgs = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * A profile that adds nothing to its shell: no startup command, and no arguments but the usual ones. A node's command
 * then runs as it always has, as the shell's own -c, -Command or /k.
 */
function plain(p: TerminalProfile): boolean {
  if (p.startupCommand) return false
  const kind = shellKind(p.program)
  if (kind === 'wsl') return false
  return p.args.length === 0 || (kind === 'git-bash' && sameArgs(p.args, GIT_BASH_ARGS))
}

/**
 * What a terminal node starts. The profile's arguments go as they are; its startup command, then the node's own
 * command, are typed at the first prompt. The node's command isn't run again when the app restores the node.
 */
export function terminalLaunch(list: ProfileList, node: { profile?: unknown; command?: string }, restored: boolean): TerminalLaunch {
  const { profile, missing } = profileForNode(list, node.profile)
  const command = !restored && node.command ? node.command : undefined
  const base = { profile, ...(missing ? { missing } : {}) }
  if (command && plain(profile)) return { ...base, file: profile.program, args: terminalArgs(profile.program, command), typed: [] }
  return { ...base, file: profile.program, args: [...profile.args], typed: [...startupLines(profile.startupCommand), ...(command ? startupLines(command) : [])] }
}
