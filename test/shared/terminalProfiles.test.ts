import { describe, expect, test } from 'vitest'
import { parseSettings, mergeSettings } from '../../src/main/lifecycle'
import { terminalArgs, terminalLaunch } from '../../src/main/sessions/shell'
import {
  argsFromLines,
  builtInProfiles,
  findProfile,
  GIT_BASH,
  launchLine,
  MIGRATED_ID,
  profileArg,
  profileList,
  readProfileFields,
  shellKind,
  startupLines,
  withProfiles,
  type TerminalProfile
} from '../../src/shared/terminalProfiles'

const withBash = builtInProfiles({ gitBash: true, pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', wsl: true })
const noBash = builtInProfiles({ gitBash: false })
const vs: TerminalProfile = { id: 'custom:vs', name: 'VS prompt', program: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'] }
const proj: TerminalProfile = { id: 'custom:proj', name: 'Project', program: GIT_BASH, args: ['--login', '-i'], startupCommand: 'cd ~/proj && nvm use' }

describe('defaults and migration', () => {
  test('with no settings, a new terminal starts Git Bash --login -i, as before profiles', () => {
    const list = profileList({}, withBash)
    expect(list.defaultId).toBe('builtin:git-bash')
    expect(list.profiles[0]).toMatchObject({ program: GIT_BASH, args: ['--login', '-i'] })
  })

  test('without Git Bash, it starts Windows PowerShell with no arguments', () => {
    const list = profileList({}, noBash)
    expect(list.profiles[0]).toMatchObject({ id: 'builtin:powershell', program: 'powershell.exe', args: [] })
  })

  test('an old shell setting becomes the first custom profile and the default, started the same way', () => {
    const list = profileList({ shell: 'C:\\tools\\nu.exe' }, withBash)
    expect(list.defaultId).toBe(MIGRATED_ID)
    expect(list.profiles[0]).toEqual({ id: MIGRATED_ID, name: 'nu.exe', program: 'C:\\tools\\nu.exe', args: [] })
    expect(terminalLaunch(list, {}, false)).toMatchObject({ file: 'C:\\tools\\nu.exe', args: [], typed: [] })
    // A command still runs the way it did, as the shell's own -c.
    expect(terminalLaunch(list, { command: 'ls' }, false).args).toEqual(['-c', 'ls'])
  })

  test('once profiles are saved, the old shell no longer stands in as one', () => {
    const list = profileList({ shell: 'C:\\tools\\nu.exe', terminalProfiles: [vs] }, withBash)
    expect(list.profiles.map((p) => p.id)).not.toContain(MIGRATED_ID)
    expect(list.defaultId).toBe('builtin:git-bash')
  })

  test('a named default comes first; a default that has been deleted falls back to the automatic one', () => {
    expect(profileList({ terminalProfiles: [vs, proj], defaultTerminalProfile: 'custom:proj' }, withBash).profiles.map((p) => p.id).slice(0, 2)).toEqual(['custom:proj', 'custom:vs'])
    expect(profileList({ terminalProfiles: [vs], defaultTerminalProfile: 'custom:gone' }, withBash).defaultId).toBe('builtin:git-bash')
  })

  test('built-ins are found only when installed, and are read-only', () => {
    expect(withBash.map((p) => p.name)).toEqual(['Git Bash', 'Windows PowerShell', 'PowerShell 7', 'Command Prompt', 'WSL'])
    expect(noBash.map((p) => p.name)).toEqual(['Windows PowerShell', 'Command Prompt'])
    expect(withBash.every((p) => p.builtIn)).toBe(true)
  })
})

describe('reading and saving settings.json', () => {
  test('profiles are read with only known fields; broken ones, duplicates and built-in ids are dropped', () => {
    const read = readProfileFields({
      terminalProfiles: [{ ...vs, extra: 1 }, { id: 'x' }, { ...vs, name: 'again' }, { id: 'builtin:cmd', program: 'cmd.exe' }, { id: 'a', program: 'a.exe', args: ['x', 2, ''] }, 'junk'],
      defaultTerminalProfile: 'custom:vs'
    })
    expect(read).toEqual({ terminalProfiles: [vs, { id: 'a', name: 'a.exe', program: 'a.exe', args: ['x', ''] }], defaultTerminalProfile: 'custom:vs' })
    expect(readProfileFields({})).toEqual({})
  })

  test('parseSettings reads them, and saving other settings leaves them alone', () => {
    const text = JSON.stringify({ shell: 'cmd.exe', terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
    expect(parseSettings(text)).toMatchObject({ shell: 'cmd.exe', terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
    const merged = JSON.parse(mergeSettings(text, { shell: 'pwsh.exe', terminalProfiles: [] })!)
    expect(merged).toMatchObject({ shell: 'pwsh.exe', terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
  })

  test('saving profiles keeps every other field, never stores built-ins, and refuses a broken file', () => {
    const next = JSON.parse(withProfiles(JSON.stringify({ shell: 'cmd.exe', mine: true }), [vs, withBash[0]], 'custom:vs')!)
    expect(next).toEqual({ shell: 'cmd.exe', mine: true, terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
    expect(JSON.parse(withProfiles(JSON.stringify(next), [], '')!)).toEqual({ shell: 'cmd.exe', mine: true, terminalProfiles: [] })
    expect(withProfiles('{ nope', [vs], '')).toBeNull()
  })
})

describe('launch', () => {
  const list = profileList({ terminalProfiles: [vs, proj], defaultTerminalProfile: 'custom:vs' }, withBash)

  test('a profile starts its program with its arguments as an argv list, not re-parsed', () => {
    expect(terminalLaunch(list, {}, false)).toMatchObject({ file: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'], typed: [] })
  })

  test('its startup command is typed at the prompt, on every fresh start', () => {
    expect(terminalLaunch(list, { profile: 'custom:proj' }, false)).toMatchObject({ file: GIT_BASH, args: ['--login', '-i'], typed: ['cd ~/proj && nvm use'] })
    expect(terminalLaunch(list, { profile: 'custom:proj' }, true).typed).toEqual(['cd ~/proj && nvm use'])
  })

  test("a node's command follows the startup command, but not when the app restores the node", () => {
    expect(terminalLaunch(list, { profile: 'custom:proj', command: 'npm test' }, false).typed).toEqual(['cd ~/proj && nvm use', 'npm test'])
    expect(terminalLaunch(list, { profile: 'custom:vs', command: 'msbuild' }, false)).toMatchObject({ args: ['/k', 'C:\\VS\\vcvars64.bat'], typed: ['msbuild'] })
    expect(terminalLaunch(list, { profile: 'custom:proj', command: 'npm run deploy' }, true).typed).toEqual(['cd ~/proj && nvm use'])
  })

  test('a profile that adds nothing runs a command as the shell always has', () => {
    expect(terminalLaunch(list, { profile: 'builtin:git-bash', command: 'npm test' }, false)).toMatchObject({ args: terminalArgs(GIT_BASH, 'npm test'), typed: [] })
    expect(terminalLaunch(list, { profile: 'builtin:pwsh', command: 'dotnet test' }, false).args).toEqual(['-NoExit', '-Command', 'dotnet test'])
    // wsl.exe has no -c, so its command is typed.
    expect(terminalLaunch(list, { profile: 'builtin:wsl', command: 'ls' }, false)).toMatchObject({ args: [], typed: ['ls'] })
  })

  test('a deleted profile falls back to the default, and says which id went', () => {
    expect(terminalLaunch(list, { profile: 'custom:gone' }, false)).toMatchObject({ file: 'cmd.exe', missing: 'custom:gone', profile: { id: 'custom:vs' } })
    expect(terminalLaunch(list, {}, false).missing).toBeUndefined()
  })
})

test('shell kinds, launch lines, and the text fields', () => {
  expect(shellKind(GIT_BASH)).toBe('git-bash')
  expect(shellKind('C:\\Windows\\System32\\bash.exe')).toBe('bash')
  expect(shellKind('pwsh.exe')).toBe('powershell')
  expect(shellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
  expect(launchLine('cmd.exe', ['/k', 'C:\\Program Files\\a.bat', ''])).toBe('cmd.exe /k "C:\\Program Files\\a.bat" ""')
  expect(argsFromLines('/k\n\nC:\\a b.bat\r\n')).toEqual(['/k', 'C:\\a b.bat'])
  expect(startupLines('cd x\n\n  nvm use\x07 \n')).toEqual(['cd x', 'nvm use'])
})

describe('--profile', () => {
  const list = () => profileList({ terminalProfiles: [vs] }, noBash)
  const refuse = (m: string): never => {
    throw new Error(m)
  }

  test('finds a profile by id or by name, ignoring case', () => {
    expect(findProfile(list(), 'custom:vs')?.id).toBe('custom:vs')
    expect(profileArg(list, 'vs PROMPT', refuse)?.id).toBe('custom:vs')
    expect(profileArg(list, undefined, refuse)).toBeUndefined()
  })

  test('refuses an unknown one, listing what there is', () => {
    expect(() => profileArg(list, 'Zsh', refuse)).toThrow('No terminal profile is called "Zsh". Available: "Windows PowerShell", "VS prompt", "Command Prompt".')
  })
})
