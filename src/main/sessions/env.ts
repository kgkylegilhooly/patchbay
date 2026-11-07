const INHERIT_NOT = /^(CLAUDE_CODE_|PATCHBAY_)|^(CLAUDECODE|ELECTRON_RUN_AS_NODE)$/i

/** The envNotPassed setting, read at each use so a saved change applies to the next session. */
let notPassedSetting: () => string | undefined = () => undefined

export function setEnvNotPassed(read: () => string | undefined): void {
  notPassedSetting = read
}

/**
 * The name prefixes in an envNotPassed setting, upper-cased: separated by spaces or commas, letters, digits and `_`
 * only. Anything else in the list is skipped.
 */
export function notPassedPrefixes(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,;]+/)
    .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))
    .map((p) => p.toUpperCase())
}

/**
 * The environment for a child session: the parent's, minus anything identifying a parent session or named in the
 * envNotPassed setting, plus `extra`. Names compare case-insensitively because Windows treats them that way, so an
 * extra PATH replaces an inherited Path rather than sitting beside it.
 */
export function cleanEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, notPassed: string[] = notPassedPrefixes(notPassedSetting())): Record<string, string> {
  const overridden = new Set(Object.keys(extra).map((k) => k.toUpperCase()))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase()
    if (value === undefined || INHERIT_NOT.test(key) || overridden.has(upper) || notPassed.some((p) => upper.startsWith(p))) continue
    env[key] = value
  }
  return { ...env, ...extra }
}
