import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { createAppProblems } from '../../src/main/appProblems'
import { createDocStore } from '../../src/core/persist/docStore'
import { SAVE_RETRY_MS, saveReason, shortError, type AppProblems } from '../../src/shared/appProblems'

function harness(retry: () => Promise<void> = () => Promise.resolve()) {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const pushed: AppProblems[] = []
  const retrySave = vi.fn(retry)
  const state = createAppProblems({
    retrySave,
    push: (p) => pushed.push(p),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { live: boolean }).live = false
    }
  })
  const advance = async (ms: number): Promise<void> => {
    now += ms
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false
        t.fn()
      }
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return { state, pushed, retrySave, advance, live: () => timers.filter((t) => t.live).length }
}

describe('a canvas that cannot be saved', () => {
  it('shows one banner however many saves fail the same way, and keeps when it started', async () => {
    const h = harness(() => Promise.reject(new Error('EPERM: operation not permitted')))
    h.state.saveFailed(new Error('EPERM: operation not permitted'), 'C:\\data')
    h.state.saveFailed(new Error('EPERM: operation not permitted'), 'C:\\data')
    expect(h.pushed).toHaveLength(1)
    expect(h.state.get().save).toEqual({ dir: 'C:\\data', error: 'EPERM: operation not permitted', since: 0 })
    await h.advance(SAVE_RETRY_MS)
    expect(h.retrySave).toHaveBeenCalledTimes(1)
    expect(h.state.get().save?.since).toBe(0)
    expect(h.live()).toBe(1)
  })

  it('tries again on its own, and the banner goes when a try works', async () => {
    let fail = true
    const h = harness(() => (fail ? Promise.reject(new Error('ENOSPC: no space left')) : Promise.resolve()))
    h.state.saveFailed(new Error('ENOSPC: no space left'), 'C:\\data')
    await h.advance(SAVE_RETRY_MS)
    expect(h.state.get().save).not.toBeNull()
    fail = false
    await h.advance(SAVE_RETRY_MS)
    expect(h.state.get().save).toBeNull()
    expect(h.live()).toBe(0)
  })

  it('a save from a change that goes through clears it too, and stops the retries', async () => {
    const h = harness()
    h.state.saveFailed(new Error('EBUSY'), 'C:\\data')
    h.state.saved()
    expect(h.state.get().save).toBeNull()
    expect(h.live()).toBe(0)
    await h.advance(SAVE_RETRY_MS * 3)
    expect(h.retrySave).not.toHaveBeenCalled()
  })

  it('says nothing when saves just keep working', () => {
    const h = harness()
    h.state.saved()
    h.state.saved()
    expect(h.pushed).toEqual([])
  })

  it('says why in plain words, without the paths Node puts in the message', () => {
    const e = Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\a\\canvas.json.tmp' -> 'C:\\a\\canvas.json'"), { code: 'EPERM' })
    expect(saveReason(e)).toBe("the file or folder is read-only, or Patchbay isn't allowed to write there (EPERM)")
    expect(saveReason(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }))).toBe('the disk is full (ENOSPC)')
    expect(saveReason(new Error("EWHAT: something odd, open 'C:\\x'"))).toBe('EWHAT: something odd')
  })

  it('keeps an error to its first line, and short', () => {
    expect(shortError(new Error('EPERM: nope\n    at stack'))).toBe('EPERM: nope')
    expect(shortError('x'.repeat(400))).toHaveLength(158)
  })
})

describe('the background host stopped', () => {
  it('shows Bring them back, which runs once and clears the banner', async () => {
    const h = harness()
    h.state.hostLost()
    expect(h.state.get().hostLost).toMatchObject({ bringing: false, error: null })
    let finish!: () => void
    const bring = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const first = h.state.bringBackHost(bring)
    void h.state.bringBackHost(bring)
    expect(bring).toHaveBeenCalledTimes(1)
    expect(h.state.get().hostLost?.bringing).toBe(true)
    finish()
    await first
    expect(h.state.get().hostLost).toBeNull()
  })

  it('says why when bringing them back fails, and can be tried again', async () => {
    const h = harness()
    h.state.hostLost()
    await h.state.bringBackHost(() => Promise.reject(new Error('spawn failed')))
    expect(h.state.get().hostLost).toMatchObject({ bringing: false, error: 'spawn failed' })
    await h.state.bringBackHost(() => Promise.resolve())
    expect(h.state.get().hostLost).toBeNull()
  })

  it('Not now puts it away', () => {
    const h = harness()
    h.state.hostLost()
    h.state.dismissHostLost()
    expect(h.state.get().hostLost).toBeNull()
  })
})

describe('docStore tells when a save went through', () => {
  it('calls onSaved after a save, and not after one that failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patchbay problems '))
    try {
      const onSaved = vi.fn()
      const store = createDocStore(dir, { onSaved })
      const { doc } = store.load()
      await store.save(doc)
      expect(onSaved).toHaveBeenCalledTimes(1)
      // A folder where the save file should be: the write can't replace it.
      rmSync(join(dir, 'canvas.json'))
      mkdirSync(join(dir, 'canvas.json'))
      writeFileSync(join(dir, 'canvas.json', 'x'), '')
      await expect(store.save(doc)).rejects.toThrow()
      expect(onSaved).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('saves again once a save file made read-only can be written again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patchbay problems '))
    const file = join(dir, 'canvas.json')
    try {
      const store = createDocStore(dir)
      const { doc } = store.load()
      await store.save(doc)
      chmodSync(file, 0o444)
      const changed = { ...doc, projects: doc.projects.map((p) => ({ ...p, name: 'Renamed while read-only' })) }
      if (process.platform === 'win32') await expect(store.save(changed)).rejects.toThrow()
      chmodSync(file, 0o644)
      await store.save(changed)
      expect(readFileSync(file, 'utf8')).toContain('Renamed while read-only')
    } finally {
      chmodSync(file, 0o644)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('review follow-ups', () => {
  it('a host lost again while Bring them back runs keeps its own banner', async () => {
    let now = 1
    const state = createAppProblems({ retrySave: () => Promise.resolve(), push: () => {}, now: () => now })
    state.hostLost()
    let finish!: () => void
    const first = state.bringBackHost(() => new Promise<void>((r) => (finish = r)))
    now = 2
    state.hostLost()
    finish()
    await first
    expect(state.get().hostLost).toMatchObject({ at: 2, bringing: false })
  })

  it('a backup made read-only from outside no longer blocks saving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patchbay problems '))
    const backup = join(dir, 'canvas.json.bak')
    try {
      const store = createDocStore(dir)
      const { doc } = store.load()
      await store.save(doc)
      await store.save(doc)
      chmodSync(backup, 0o444)
      const changed = { ...doc, projects: doc.projects.map((p) => ({ ...p, name: 'After a read-only backup' })) }
      await store.save(changed)
      expect(readFileSync(join(dir, 'canvas.json'), 'utf8')).toContain('After a read-only backup')
    } finally {
      try {
        chmodSync(backup, 0o644)
      } catch {}
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
