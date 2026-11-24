import { fork } from 'node:child_process'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { readConsoleMembers } from '../../src/main/ports/ports'
import { createSessionHost } from '../../src/main/sessions/host'
import type { SessionHost } from '../../src/shared/contract'
import { usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const hosts: SessionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.kill('n')))
})

// The helper attaches to the session's console to list it, so it's on that console itself; it exits as soon as it has
// answered, and nobody holds its handle after that. Its PID in the list meant a later kill by PID could land on
// whatever process Windows gave that number to next (a Stop's taskkill /T started a process later).
test.skipIf(process.platform !== 'win32')("a session's console list never names the helper that read it", async () => {
  const h = createSessionHost()
  hosts.push(h)
  h.start({ nodeId: 'n', file: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/k', 'echo listed'], cwd: tmpdir(), env: process.env as Record<string, string> })
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('listed'), { timeout: 30_000 })
  const shell = h.pid('n')!
  const helpers: number[] = []
  const recording = ((...args: Parameters<typeof fork>) => {
    const child = fork(...args)
    if (child.pid) helpers.push(child.pid)
    return child
  }) as typeof fork
  const members = await readConsoleMembers(shell, recording)
  expect(helpers).toHaveLength(1)
  // The session's own shell is there, so the list was read.
  expect(members).toContain(shell)
  expect(members).not.toContain(helpers[0])
})
