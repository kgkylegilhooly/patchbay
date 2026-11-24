import { describe, expect, it } from 'vitest'
import { buildInfo, readBuildInfo, UNKNOWN_BUILD, type Git } from '../../src/main/diagnostics/buildInfo'

const NOW = new Date('2026-11-24T10:00:00.000Z')

function git(answers: Record<string, string | null>): Git {
  return (args) => answers[args.join(' ')] ?? null
}

describe('readBuildInfo', () => {
  it('reads the commit, branch and whether tracked files changed', () => {
    const info = readBuildInfo(git({ 'rev-parse --short=10 HEAD': 'e94fa9b1c2\n', 'status --porcelain --untracked-files=no': ' M src/x.ts\n', 'rev-parse --abbrev-ref HEAD': 'main\n' }), NOW)
    expect(info).toEqual({ commit: 'e94fa9b1c2', dirty: true, branch: 'main', date: '2026-11-24T10:00:00.000Z' })
  })

  it('a clean checkout is not marked changed', () => {
    expect(readBuildInfo(git({ 'rev-parse --short=10 HEAD': 'e94fa9b1c2', 'status --porcelain --untracked-files=no': '', 'rev-parse --abbrev-ref HEAD': 'HEAD' }), NOW).dirty).toBe(false)
  })

  it('outside a git checkout, the commit is unknown but the date is still the build time', () => {
    expect(readBuildInfo(git({}), NOW)).toEqual({ ...UNKNOWN_BUILD, date: '2026-11-24T10:00:00.000Z' })
    expect(readBuildInfo(git({ 'rev-parse --short=10 HEAD': 'fatal: not a git repository' }), NOW).commit).toBe('unknown')
  })
})

describe('buildInfo', () => {
  it('is unknown where nothing was baked in, as here under vitest', () => {
    expect(buildInfo()).toEqual(UNKNOWN_BUILD)
  })
})

describe('the build config', () => {
  it("defines __PB_BUILD__ for the main process, with this checkout's commit", async () => {
    const config = (await import('../../electron.vite.config')).default as { main: { define?: Record<string, string> } }
    const define = config.main.define?.__PB_BUILD__
    expect(typeof define).toBe('string')
    const info = JSON.parse(define as string)
    expect(info.commit).toMatch(/^[0-9a-f]{10}$/)
    expect(Number.isFinite(Date.parse(info.date))).toBe(true)
  })
})
