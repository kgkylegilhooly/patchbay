import { randomUUID } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { adoptAfterQuickBoot } from '../../src/main/bootAdopt'
import { planReconnect } from '../../src/main/lifecycle'
import { createBackgroundHost } from '../../src/main/sessions/backgroundHost'
import type { PtyHost } from '../../src/main/sessions/host'
import { HOST_PROTOCOL } from '../../src/main/sessions/hostProtocol'
import { startHostServer } from '../../src/main/sessions/hostServer'
import type { CanvasDoc } from '../../src/shared/model'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** A host that already runs one session, `old`, from before this app started. */
function heldSessions(): PtyHost {
  const live = new Set(['old'])
  return {
    start: (spec) => void live.add(spec.nodeId),
    write: () => {},
    resize: () => {},
    kill: async () => {},
    pid: () => 4242,
    isRunning: (id) => live.has(id),
    snapshot: () => ({ data: 'what old printed\r\n', seq: 1 }),
    onOutput: () => {},
    onExit: () => {},
    list: () => [...live].map((id) => ({ id, pid: 4242, running: true, exitCode: null, exitedAt: null })),
    forget: () => {},
    pause: () => {},
    resume: () => {}
  }
}

const doc: CanvasDoc = {
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes: [{ kind: 'terminal', id: 'old', title: 'old', x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: '.' }],
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
}

test('a host that missed boot\'s first knock still has its sessions adopted, once the full connect finds it', async () => {
  const pipe = `\\\\.\\pipe\\patchbay-test-${randomUUID()}`
  // Busy when boot knocked: it answers only a moment later, already running `old`. The host boot starts meanwhile
  // can't listen, since this one holds the pipe.
  const app = createBackgroundHost({
    pipe,
    secret: 's',
    spawnHost: () => {
      setTimeout(async () => {
        const server = await startHostServer({ pipe, secret: 's', protocol: HOST_PROTOCOL, version: 't', startedAt: 1, sessions: heldSessions(), onStopRequested: () => {} })
        cleanups.push(() => server.close())
      }, 300)
    },
    createLocal: () => heldSessions(),
    startTimeoutMs: 5000
  })
  cleanups.push(() => app.detach())

  const atBoot = await app.connect({ quick: true })
  const adoptedAtBoot = planReconnect(doc, app.sessions()).adopt
  expect(atBoot.mode).toBe('starting')
  expect(adoptedAtBoot).toEqual([])

  const late: string[][] = []
  const more = await adoptAfterQuickBoot(
    atBoot,
    () => app.connect(),
    () => planReconnect(doc, app.sessions()).adopt.filter((id) => !adoptedAtBoot.includes(id)),
    (ids) => late.push(ids)
  )
  expect(more).toEqual(['old'])
  expect(late).toEqual([['old']])
  expect(app.snapshot('old').data).toContain('what old printed')
})

test('after a boot that waited for its host, there is nothing more to adopt', async () => {
  let called = false
  const more = await adoptAfterQuickBoot({ mode: 'background', running: 1, expectedProtocol: 1 }, async () => ({ mode: 'background', running: 1, expectedProtocol: 1 }), () => ((called = true), ['x']), () => {})
  expect(more).toEqual([])
  expect(called).toBe(false)
})
