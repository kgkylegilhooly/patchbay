import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildClaudeLaunch, type ClaudeLaunchContext } from '../../src/main/sessions/claudeLaunch'
import { nativeMessagingSettings } from '../../src/main/sessions/nativeMessaging'
import { parseSettings } from '../../src/main/lifecycle'
import type { ClaudeNode } from '../../src/shared/model'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay messaging '))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const node: () => ClaudeNode = () => ({
  id: 'n1',
  kind: 'claude',
  title: 'Claude',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  parentId: null,
  cwd: dir,
  sessionId: null,
  transcriptPath: null,
  after: []
})

const ctx = (over: Partial<ClaudeLaunchContext> = {}): ClaudeLaunchContext => ({
  sessionDir: join(dir, 'sessions'),
  hookScript: 'C:\\Patchbay\\hook.cjs',
  pluginDir: 'C:\\Patchbay\\skill',
  cliDir: 'C:\\Patchbay\\cli',
  endpointFile: 'C:\\Patchbay\\control.json',
  token: 'tok',
  claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
  baseEnv: { Path: 'C:\\Windows' },
  ...over
})

function writtenSettings(over: Partial<ClaudeLaunchContext> = {}): Record<string, any> {
  const args = buildClaudeLaunch(node(), ctx(over)).args
  return JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))
}

test('by default a Claude node refuses messages from other sessions and cannot list them', () => {
  const settings = writtenSettings()
  expect(settings.crossSessionInbound).toBe('refuse')
  expect(settings.permissions.deny).toEqual(['ListAgents'])
})

test("SendMessage is never denied, since Claude's own subagents and teammates use it too", () => {
  for (const setting of [undefined, 'on']) {
    const settings = writtenSettings({ claudeNativeMessaging: setting })
    expect(settings.permissions.deny ?? []).not.toContain('SendMessage')
  }
})

test("turned on, Patchbay sets neither, leaving Claude's own defaults and the person's settings", () => {
  const settings = writtenSettings({ claudeNativeMessaging: 'on' })
  expect(settings.crossSessionInbound).toBeUndefined()
  expect(settings.permissions.deny).toBeUndefined()
  // Patchbay's own rules stay.
  expect(settings.permissions.allow).toContain('Bash(patchbay whoami)')
})

test('anything but on is off', () => {
  for (const value of [undefined, '', 'off', 'yes', 'true']) expect(nativeMessagingSettings(value).crossSessionInbound).toBe('refuse')
  expect(nativeMessagingSettings(' On ').crossSessionInbound).toBeUndefined()
})

test('the setting is read from settings.json', () => {
  expect(parseSettings(JSON.stringify({ claudeNativeMessaging: 'on' })).claudeNativeMessaging).toBe('on')
  expect(parseSettings('{}').claudeNativeMessaging).toBeUndefined()
})
