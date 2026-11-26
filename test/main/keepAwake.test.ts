import { describe, expect, it } from 'vitest'
import { createKeepAwake } from '../../src/main/keepAwake'
import type { AgentStatus } from '../../src/shared/model'

function setup(enabled = true) {
  const calls: string[] = []
  let next = 1
  let on = enabled
  const keep = createKeepAwake({
    start: () => {
      calls.push('start')
      return next++
    },
    stop: (id) => calls.push(`stop ${id}`),
    enabled: () => on
  })
  return { keep, calls, setEnabled: (v: boolean) => (on = v) }
}

const s = (o: Record<string, AgentStatus>) => o

describe('keep-awake', () => {
  it('holds the PC awake while any agent is working, and lets go when none is', () => {
    const { keep, calls } = setup()
    keep.update(s({ a: 'idle' }))
    expect(calls).toEqual([])
    keep.update(s({ a: 'working', b: 'idle' }))
    keep.update(s({ a: 'working', b: 'working' }))
    expect(calls).toEqual(['start'])
    expect(keep.active()).toBe(true)
    keep.update(s({ a: 'idle', b: 'exited' }))
    expect(calls).toEqual(['start', 'stop 1'])
    expect(keep.active()).toBe(false)
  })

  // The owner asked for it: the PC stays up while anything isn't idle, an agent waiting on them included.
  it('treats starting and waiting on the owner as busy too; idle, ended, unknown and queued are not', () => {
    const { keep, calls } = setup()
    keep.update(s({ a: 'starting' }))
    expect(calls).toEqual(['start'])
    keep.update(s({ a: 'needs-you' }))
    expect(calls).toEqual(['start'])
    keep.update(s({ a: 'exited', b: 'unknown', c: 'queued', d: 'idle' }))
    expect(calls).toEqual(['start', 'stop 1'])
  })

  it('holds the PC awake while a run window is still running, though every agent is idle', () => {
    const { keep, calls } = setup()
    keep.update(s({ a: 'idle' }), true)
    expect(calls).toEqual(['start'])
    keep.update(s({ a: 'idle' }), false)
    expect(calls).toEqual(['start', 'stop 1'])
  })

  it('does nothing when turned off, and lets go at once if turned off while held', () => {
    const { keep, calls, setEnabled } = setup(false)
    keep.update(s({ a: 'working' }))
    expect(calls).toEqual([])
    setEnabled(true)
    keep.update(s({ a: 'working' }))
    expect(calls).toEqual(['start'])
    setEnabled(false)
    keep.update(s({ a: 'working' }))
    expect(calls).toEqual(['start', 'stop 1'])
  })

  it('lets go on dispose', () => {
    const { keep, calls } = setup()
    keep.update(s({ a: 'working' }))
    keep.dispose()
    keep.dispose()
    expect(calls).toEqual(['start', 'stop 1'])
  })
})
