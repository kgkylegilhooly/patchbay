/**
 * A host name or `user@host`, as typed after `ssh`. Nothing that ssh could read as an option (a leading `-`), and
 * nothing a shell would treat specially, although ssh is started without one.
 */
const HOST = /^(?:[A-Za-z0-9_][A-Za-z0-9_.%+-]*@)?[A-Za-z0-9_[][A-Za-z0-9_.:%[\]-]*$/

export function isSshHost(text: string): boolean {
  return text.length <= 255 && HOST.test(text)
}

export function sshHostProblem(text: string): string | null {
  if (!text.trim()) return 'Type a host.'
  return isSshHost(text) ? null : 'That isn’t a host name. Use a name from your ssh config, a host, or user@host.'
}

/**
 * The hosts named in an ssh config file, each once, in the order written. Patterns (`*`, `?`) and negations (`!`)
 * aren't places to connect to, so they're left out. `Include` isn't followed.
 */
export function sshHosts(text: string): string[] {
  const hosts: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = /^host(?:\s*=\s*|\s+)(.+)$/i.exec(line)
    if (!m) continue
    for (const word of m[1].split(/\s+/)) {
      const name = word.replace(/^"(.*)"$/, '$1')
      if (/[*?!]/.test(name) || !isSshHost(name) || hosts.includes(name)) continue
      hosts.push(name)
    }
  }
  return hosts
}
