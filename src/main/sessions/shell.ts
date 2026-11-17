import { existsSync } from 'node:fs'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

/**
 * Whether Claude Code will run hook and status line commands through Git Bash, as it does on Windows wherever it finds
 * one: then those commands can be bash. Its own setting first, then the usual install.
 */
export function claudeRunsBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): boolean {
  const own = env.CLAUDE_CODE_GIT_BASH_PATH
  if (own) return exists(own)
  return exists(GIT_BASH)
}

export function pickDefaultShell(settingsShell?: string): { file: string; args: string[] } {
  if (settingsShell) return { file: settingsShell, args: [] }
  if (existsSync(GIT_BASH)) return { file: GIT_BASH, args: ['--login', '-i'] }
  return { file: 'powershell.exe', args: [] }
}
