import { existsSync } from 'node:fs'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

export function pickDefaultShell(settingsShell?: string): { file: string; args: string[] } {
  if (settingsShell) return { file: settingsShell, args: [] }
  if (existsSync(GIT_BASH)) return { file: GIT_BASH, args: ['--login', '-i'] }
  return { file: 'powershell.exe', args: [] }
}
