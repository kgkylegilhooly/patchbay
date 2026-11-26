import { expect, test } from 'vitest'
import { fixBrief, runFixFor } from '../../src/main/runFix'
import { memoryStore } from '../control/fakes'

// F31: a failed run hands its command, exit code and last output to a new agent, instead of the person copying them.
const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const run = (over: Record<string, unknown> = {}) => ({ ...box, id: 'r', kind: 'run', title: 'npm test', cwd: 'C:\\w', command: 'npm test', ...over }) as never
const failed = { running: false, exitCode: 1, stoppedByYou: false, at: 1 }

test('the brief says what ran, where, how it ended and what it printed last, then asks for a fix and a check', () => {
  const brief = fixBrief({ title: 'npm test', cwd: 'C:\\w', command: 'npm test' }, 1, 'FAIL  test/a.test.ts\nExpected 2, got 3\n')
  expect(brief).toBe(
    [
      'The run "npm test" failed: `npm test` in C:\\w exited with code 1.',
      '',
      'Its last output:',
      '',
      '```',
      'FAIL  test/a.test.ts',
      'Expected 2, got 3',
      '```',
      '',
      'Find out why it failed and fix it. Then run `npm test` again to check.'
    ].join('\n')
  )
})

test('output with its own code fences gets a longer fence; a launch configuration is named, not run', () => {
  const brief = fixBrief({ title: 'Debug API', cwd: 'C:\\w', command: 'launch.json: Debug API', launch: { folder: 'C:\\w', name: 'Debug API' } }, 2, 'see ```x```')
  expect(brief).toContain('````\nsee ```x```\n````')
  expect(brief).toContain('The launch configuration "Debug API" in C:\\w exited with code 2.')
  expect(brief).toContain('Find out why it failed and fix it. Then run it again from its window to check.')
})

test('only the last 80 lines, and at most 8,000 characters of them, go in; colours and blank tails are dropped', () => {
  const output = Array.from({ length: 200 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\r\n') + '\r\n\r\n\r\n'
  const r = runFixFor(memoryStore([run()]), 'r', failed, () => output)
  if (!r.ok) throw new Error(r.reason)
  expect(r.brief).toContain('line 120\nline 121')
  expect(r.brief).not.toContain('line 119\n')
  expect(r.brief).not.toContain('\x1b')
  expect(r.brief).toContain('line 199\n```')
  const long = runFixFor(memoryStore([run()]), 'r', failed, () => 'x'.repeat(20_000))
  if (!long.ok) throw new Error(long.reason)
  expect(long.brief.length).toBeLessThan(8_400)
  expect(long.brief).toContain('…')
})

test('it says why when the window is not a failed run, or printed nothing', () => {
  const store = memoryStore([run(), { ...box, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:\\w' } as never])
  expect(runFixFor(store, 't', failed, () => 'x')).toEqual({ ok: false, reason: 'That window is not a run command.' })
  expect(runFixFor(store, 'r', { ...failed, exitCode: 0 }, () => 'x')).toEqual({ ok: false, reason: "npm test didn't fail." })
  expect(runFixFor(store, 'r', { ...failed, running: true, exitCode: null }, () => 'x')).toEqual({ ok: false, reason: "npm test didn't fail." })
  expect(runFixFor(store, 'r', undefined, () => 'x')).toEqual({ ok: false, reason: "npm test didn't fail." })
  expect(runFixFor(store, 'r', failed, () => '\x1b[0m\r\n')).toMatchObject({ ok: true, cwd: 'C:\\w' })
  const silent = runFixFor(store, 'r', failed, () => '')
  expect(silent.ok && silent.brief).toContain('It printed nothing.')
})
