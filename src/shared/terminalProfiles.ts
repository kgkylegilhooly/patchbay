/**
 * Terminal profiles: what program a new terminal starts, with which arguments, and what to type at its first prompt.
 * Pure, so the renderer, main and tests share one reading of settings.json. Detection of what's installed is main's.
 */

export interface TerminalProfile {
  id: string
  name: string
  /** The program to start, as a path or a name on PATH. */
  program: string
  /** Passed as they are, one argument each. Nothing re-parses them. */
  args: string[]
  /** Typed once at the shell's first prompt, a line at a time. */
  startupCommand?: string
  /** Where new terminals with this profile open when no folder is chosen. */
  cwd?: string
  /** Found on this PC, not saved: read-only, though it can be duplicated. */
  builtIn?: boolean
}

/** The profiles there are, the default first, and which one that is. */
export interface ProfileList {
  profiles: TerminalProfile[]
  defaultId: string
}

/** What settings.json says about terminals. */
export interface ProfileSettings {
  shell?: string
  terminalProfiles?: TerminalProfile[]
  defaultTerminalProfile?: string
}

export const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
export const GIT_BASH_ARGS = ['--login', '-i']
/** The profile an old `shell` setting becomes. */
export const MIGRATED_ID = 'custom:shell'

export type ShellKind = 'git-bash' | 'bash' | 'powershell' | 'cmd' | 'wsl' | 'other'

function baseName(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).toLowerCase().replace(/\.exe$/, '')
}

/** Which kind of shell a program is, from its file name. WSL's bash.exe in System32 is a Linux bash, not Git's. */
export function shellKind(program: string): ShellKind {
  const name = baseName(program)
  if (name === 'bash') return /[\\/]system32[\\/]/i.test(program) ? 'bash' : 'git-bash'
  if (name === 'powershell' || name === 'pwsh') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'wsl') return 'wsl'
  return 'other'
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** One profile from settings.json, or null if it isn't one. Only known fields are kept. */
export function readProfile(raw: unknown): TerminalProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const program = str(r.program)
  if (!id || !program || id.startsWith('builtin:')) return null
  const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : []
  const profile: TerminalProfile = { id, name: str(r.name) ?? program, program, args }
  const startup = typeof r.startupCommand === 'string' && r.startupCommand.trim() ? r.startupCommand.trim() : undefined
  if (startup) profile.startupCommand = startup
  const cwd = str(r.cwd)
  if (cwd) profile.cwd = cwd
  return profile
}

/** The profile fields of settings.json. An absent list stays absent, which is what lets an old `shell` migrate. */
export function readProfileFields(fields: Record<string, unknown>): Pick<ProfileSettings, 'terminalProfiles' | 'defaultTerminalProfile'> {
  const out: Pick<ProfileSettings, 'terminalProfiles' | 'defaultTerminalProfile'> = {}
  if (Array.isArray(fields.terminalProfiles)) {
    const seen = new Set<string>()
    out.terminalProfiles = fields.terminalProfiles.flatMap((p) => {
      const profile = readProfile(p)
      if (!profile || seen.has(profile.id)) return []
      seen.add(profile.id)
      return [profile]
    })
  }
  const def = str(fields.defaultTerminalProfile)
  if (def) out.defaultTerminalProfile = def
  return out
}

/** What's installed, as main finds it. */
export interface Installed {
  gitBash: boolean
  /** PowerShell 7's path, if installed. */
  pwsh?: string | null
  wsl?: boolean
}

/** The profiles found on this PC. Windows PowerShell and Command Prompt are always there. */
export function builtInProfiles(found: Installed): TerminalProfile[] {
  const list: TerminalProfile[] = []
  if (found.gitBash) list.push({ id: 'builtin:git-bash', name: 'Git Bash', program: GIT_BASH, args: GIT_BASH_ARGS, builtIn: true })
  list.push({ id: 'builtin:powershell', name: 'Windows PowerShell', program: 'powershell.exe', args: [], builtIn: true })
  if (found.pwsh) list.push({ id: 'builtin:pwsh', name: 'PowerShell 7', program: found.pwsh, args: [], builtIn: true })
  list.push({ id: 'builtin:cmd', name: 'Command Prompt', program: 'cmd.exe', args: [], builtIn: true })
  if (found.wsl) list.push({ id: 'builtin:wsl', name: 'WSL', program: 'wsl.exe', args: [], builtIn: true })
  return list
}

/** The saved profiles, with an old `shell` setting standing in as one when there's no list yet. */
export function customProfiles(s: ProfileSettings): TerminalProfile[] {
  if (s.terminalProfiles) return s.terminalProfiles
  const shell = s.shell?.trim()
  if (!shell) return []
  return [{ id: MIGRATED_ID, name: shell.split(/[\\/]/).pop() || shell, program: shell, args: [] }]
}

/**
 * Every profile, the default first. The default is the one settings name; else a migrated `shell`; else Git Bash if
 * it's installed, else Windows PowerShell, which is what a new terminal started before profiles.
 */
export function profileList(s: ProfileSettings, builtIns: TerminalProfile[]): ProfileList {
  const custom = customProfiles(s)
  const all = [...custom, ...builtIns]
  const named = s.defaultTerminalProfile ? all.find((p) => p.id === s.defaultTerminalProfile) : undefined
  const migrated = !s.terminalProfiles && custom[0]?.id === MIGRATED_ID ? custom[0] : undefined
  const fallback = builtIns.find((p) => p.id === 'builtin:git-bash') ?? builtIns.find((p) => p.id === 'builtin:powershell') ?? all[0]
  const chosen = named ?? migrated ?? fallback ?? { id: 'builtin:powershell', name: 'Windows PowerShell', program: 'powershell.exe', args: [], builtIn: true }
  return { profiles: [chosen, ...all.filter((p) => p.id !== chosen.id)], defaultId: chosen.id }
}

/** A profile by id, or by name ignoring case. */
export function findProfile(list: ProfileList, nameOrId: string): TerminalProfile | undefined {
  const want = nameOrId.trim()
  return list.profiles.find((p) => p.id === want) ?? list.profiles.find((p) => p.name.toLowerCase() === want.toLowerCase())
}

/** Why a name or id matched nothing, listing what would have. */
export function unknownProfile(list: ProfileList, nameOrId: string): string {
  return `No terminal profile is called "${nameOrId}". Available: ${list.profiles.map((p) => `"${p.name}"`).join(', ')}.`
}

/**
 * The profile a terminal node starts with: the one it records, or the default. `missing` is set when the one it
 * records has been deleted, so the node can say why it got the default.
 */
export function profileForNode(list: ProfileList, recorded: unknown): { profile: TerminalProfile; missing?: string } {
  const fallback = list.profiles[0]
  if (typeof recorded !== 'string' || !recorded) return { profile: fallback }
  const found = list.profiles.find((p) => p.id === recorded)
  return found ? { profile: found } : { profile: fallback, missing: recorded }
}

/** Characters cmd.exe treats specially outside quotes. */
const CMD_SPECIAL = /[\s&()^|<>,;=]/
const quotedAlready = (a: string): boolean => a.length >= 2 && a.startsWith('"') && a.endsWith('"')
const cmdQuote = (a: string): string => (a === '' ? '""' : quotedAlready(a) || !CMD_SPECIAL.test(a) ? a : `"${a}"`)

/**
 * A cmd.exe profile's arguments as the command line cmd will read. cmd doesn't split its command line by the argv rules
 * other programs use, and the session host passes cmd's arguments as one line, joined with spaces. So each argument
 * with a space or one of cmd's special characters is quoted here, unless the person quoted it already, and what follows
 * /k or /c is wrapped in one more pair of quotes, which cmd takes off again before running it: `/k ""C:\a b\x.bat" arg"`.
 */
export function cmdArgs(args: string[]): string[] {
  const at = args.findIndex((a) => /^\/[kc]$/i.test(a))
  if (at === -1) return args.map(cmdQuote)
  const head = args.slice(0, at + 1).map(cmdQuote)
  const tail = args.slice(at + 1).map(cmdQuote).join(' ')
  if (!tail) return head
  return [...head, tail.includes('"') ? `"${tail}"` : tail]
}

/** How a launch is shown: the program and its arguments, quoted as they will reach it. */
export function launchLine(program: string, args: string[]): string {
  const quote = (a: string): string => (a === '' ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  if (shellKind(program) === 'cmd') return [quote(program), ...cmdArgs(args)].join(' ')
  return [program, ...args].map(quote).join(' ')
}

/** The startup command's lines, as typed: no blanks, no control characters. */
export function startupLines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim())
    .filter(Boolean)
}

/** Arguments one per line, as the settings page edits them. Blank lines are dropped; spaces inside a line are kept. */
export function argsFromLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '')
}

export function newProfileId(): string {
  return `custom:${Math.random().toString(36).slice(2, 10)}`
}

/** The calls the settings page and the new-terminal menus make. See src/preload/terminalProfiles.ts. */
export interface TerminalProfileBridge {
  list(): Promise<ProfileList>
  save(profiles: TerminalProfile[], defaultId: string): Promise<{ ok: true; list: ProfileList } | { ok: false; reason: string }>
}

/**
 * settings.json's new text with these profiles and this default, keeping every other field. Null when the file can't
 * be read as settings, since saving over it would lose what was being edited by hand. Built-in profiles aren't saved.
 */
export function withProfiles(text: string | null, profiles: unknown[], defaultId: string): string | null {
  let current: Record<string, unknown> = {}
  if (text !== null && text.trim()) {
    try {
      current = JSON.parse(text)
    } catch {
      return null
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
  }
  const { terminalProfiles } = readProfileFields({ terminalProfiles: profiles })
  const next: Record<string, unknown> = { ...current, terminalProfiles: terminalProfiles ?? [] }
  if (defaultId.trim()) next.defaultTerminalProfile = defaultId.trim()
  else delete next.defaultTerminalProfile
  return `${JSON.stringify(next, null, 2)}\n`
}

/** The profile `--profile` names, or undefined when none was given. An unknown one is refused, listing the rest. */
export function profileArg(list: (() => ProfileList) | undefined, given: string | undefined, refuse: (message: string) => never): TerminalProfile | undefined {
  if (given === undefined || !given.trim()) return undefined
  if (!list) return refuse('Terminal profiles are not available here.')
  const profiles = list()
  return findProfile(profiles, given) ?? refuse(unknownProfile(profiles, given))
}

/**
 * settings.json's new text with an old `shell` saved as a profile, once: from then on "Shell for run commands" and the
 * terminal profiles are separate settings, so clearing or changing one leaves the other alone. Null when there's
 * nothing to do, or the file can't be read as settings.
 */
export function migratedSettingsText(text: string | null): string | null {
  if (text === null || !text.trim()) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  if (fields.terminalProfiles !== undefined) return null
  const shell = typeof fields.shell === 'string' ? fields.shell : undefined
  const custom = customProfiles({ shell })
  if (!custom.length) return null
  return withProfiles(text, custom, typeof fields.defaultTerminalProfile === 'string' ? fields.defaultTerminalProfile : MIGRATED_ID)
}
