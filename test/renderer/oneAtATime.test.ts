import { expect, test } from 'vitest'
import { oneAtATime } from '../../src/renderer/oneAtATime'

/** A refresh that ends when told to, noting what it saw when it began. */
function controlled(log: string[], name: string) {
  let end: () => void = () => {}
  const run = () =>
    new Promise<void>((r) => {
      log.push(`start ${name}`)
      end = () => {
        log.push(`end ${name}`)
        r()
      }
    })
  return { run, end: () => end() }
}

test('a refresh asked for while one runs is not dropped: it runs after, and its caller waits for it', async () => {
  const queue = oneAtATime()
  const log: string[] = []
  const focus = controlled(log, 'focus')
  const afterPull = controlled(log, 'after pull')
  const first = queue(focus.run)
  let pulledShown = false
  const second = queue(afterPull.run).then(() => (pulledShown = true))
  expect(log).toEqual(['start focus'])
  focus.end()
  await first
  await Promise.resolve()
  await Promise.resolve()
  expect(log).toEqual(['start focus', 'end focus', 'start after pull'])
  expect(pulledShown).toBe(false)
  afterPull.end()
  await second
  expect(pulledShown).toBe(true)
})

test('several asked for meanwhile run once, as the newest, and all their callers resolve then', async () => {
  const queue = oneAtATime()
  const log: string[] = []
  const a = controlled(log, 'a')
  const b = controlled(log, 'b')
  const c = controlled(log, 'c')
  void queue(a.run)
  const pb = queue(b.run)
  const pc = queue(c.run)
  a.end()
  await new Promise((r) => setTimeout(r, 0))
  expect(log).toEqual(['start a', 'end a', 'start c'])
  c.end()
  await Promise.all([pb, pc])
  expect(log).not.toContain('start b')
})

test('a failed refresh does not stop the next one', async () => {
  const queue = oneAtATime()
  let ran = false
  await queue(() => Promise.reject(new Error('git failed')))
  await queue(async () => {
    ran = true
  })
  expect(ran).toBe(true)
})
