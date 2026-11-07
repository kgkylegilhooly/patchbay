import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The ssh program: Windows' own OpenSSH client first, then any ssh.exe on PATH, such as Git's. Null if there's none.
 */
export function findSsh(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const system = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  if (exists(system)) return system
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'ssh.exe')
    if (exists(candidate)) return candidate
  }
  return null
}

/** `--` ends ssh's options, so the host is always read as a host. */
export function sshArgs(host: string): string[] {
  return ['--', host]
}
