import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { removeTemp } from '../support/realProcess'

// The acceptance runs' and screenshot.js's own helpers, as they launch the app.
const require = createRequire(import.meta.url)
const { appEnv } = require('./lib.cjs') as { appEnv: (o: { profile: string; env?: Record<string, string>; realHome?: boolean; base?: NodeJS.ProcessEnv }) => NodeJS.ProcessEnv }

let profile: string
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'patchbay isolation '))
})
afterEach(() => removeTemp(profile))

const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: homedir(), HOME: homedir(), CLAUDE_CONFIG_DIR: 'C:\\real\\.claude', CODEX_HOME: 'C:\\real\\.codex', CLAUDE_CODE_ENTRYPOINT: 'cli' }
const inside = (p: string | undefined) => !!p && resolve(p).toLowerCase().startsWith(resolve(profile).toLowerCase())

test("the app gets a home of its own in the throwaway profile, so it never reads the person's ~/.claude, ~/.codex or ~/.ssh", () => {
  const env = appEnv({ profile, base })
  for (const key of ['USERPROFILE', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PATCHBAY_SSH_CONFIG', 'PATCHBAY_HOST_RUNTIME_DIR']) expect(inside(env[key]), key).toBe(true)
  // A parent agent's own variables are never passed on.
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  // What the app's own Node sees as home.
  const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, encoding: 'utf8' })
  expect(inside(seen)).toBe(true)
  // Git in that home still has a name to commit under, a made-up one.
  expect(readFileSync(join(env.HOME!, '.gitconfig'), 'utf8')).toMatch(/example\.invalid/)
  // Git Bash's prompt names nobody real.
  expect(readFileSync(join(env.HOME!, '.config', 'git', 'git-prompt.sh'), 'utf8')).toMatch(/^PS1='.*you@patchbay/)
})

test("nothing inherited points git or gh back at the person's own settings or sign-ins", () => {
  const inherited = {
    ...base,
    XDG_CONFIG_HOME: 'C:\\real\\xdg',
    GIT_CONFIG_GLOBAL: 'C:\\real\\.gitconfig',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.email',
    GIT_CONFIG_VALUE_0: 'real@person',
    GIT_AUTHOR_NAME: 'Real Person',
    GIT_COMMITTER_EMAIL: 'real@person',
    GH_TOKEN: 'real-token',
    GITHUB_TOKEN: 'real-token',
    GH_CONFIG_DIR: 'C:\\real\\gh'
  }
  const env = appEnv({ profile, base: inherited })
  for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    expect(env[key], key).toBeUndefined()
  }
  // gh reads its sign-in from %APPDATA%\GitHub CLI otherwise.
  expect(inside(env.GH_CONFIG_DIR)).toBe(true)
  // A real-agent run keeps them all.
  expect(appEnv({ profile, base: inherited, realHome: true }).GH_TOKEN).toBe('real-token')
})

test('agent accounts and Codex limits come from made-up numbers, so no picture shows real ones', () => {
  const env = appEnv({ profile, base })
  const file = env.PATCHBAY_AGENT_USAGE!
  expect(inside(file) && existsSync(file)).toBe(true)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  expect(saved.claudeAccount.email).toMatch(/example\.invalid$/)
  expect(saved.codex.windows.length).toBeGreaterThan(0)
})

test("a run's own variables win, and a run that needs real sign-ins keeps the real home", () => {
  expect(appEnv({ profile, base, env: { CODEX_HOME: 'C:\\copy' } }).CODEX_HOME).toBe('C:\\copy')
  const real = appEnv({ profile, base, realHome: true })
  expect(real.USERPROFILE).toBe(homedir())
  expect(real.PATCHBAY_AGENT_USAGE).toBeUndefined()
})
