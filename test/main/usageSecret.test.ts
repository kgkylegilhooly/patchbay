import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createUsageSecret } from '../../src/main/usage/usageSecret'

let dir: string
const HEADER = 'Authorization: Bearer top-secret-value'
const scramble = (s: string): Buffer => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a) as Buffer
const crypto = { isEncryptionAvailable: () => true, encryptString: scramble, decryptString: (b: Buffer) => scramble(b.toString('latin1')).toString('latin1') }
const make = (over = {}) => createUsageSecret({ file: join(dir, 'usage-secret.bin'), crypto: { ...crypto, ...over } })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay secret '))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('the header comes back for the address it was saved for, and survives a restart', () => {
  expect(make().save(HEADER, 'https://org.example/usage')).toEqual({ ok: true })
  expect(make().forUrl('https://org.example/other')).toEqual({ header: HEADER })
})

test('the file does not hold the header in the clear', () => {
  make().save(HEADER, 'https://org.example/usage')
  expect(readFileSync(join(dir, 'usage-secret.bin'), 'latin1')).not.toContain('top-secret-value')
})

test('a different host, scheme or port does not get it', () => {
  make().save(HEADER, 'https://org.example/usage')
  for (const url of ['https://evil.example/usage', 'http://org.example/usage', 'https://org.example:8443/usage']) {
    expect(make().forUrl(url)).toEqual({ mismatch: 'https://org.example' })
  }
})

test('nothing saved means no header and no complaint', () => {
  expect(make().forUrl('https://org.example/')).toEqual({})
  expect(make().has()).toBe(false)
})

test('saving is refused when Windows encryption is unavailable, rather than storing it plainly', () => {
  const r = make({ isEncryptionAvailable: () => false }).save(HEADER, 'https://org.example/')
  expect(r.ok).toBe(false)
  expect(existsSync(join(dir, 'usage-secret.bin'))).toBe(false)
})

test('saving needs a usable address and a Name: value header, and never repeats the header', () => {
  expect(make().save(HEADER, 'not a url').ok).toBe(false)
  const bad = make().save('top-secret-value', 'https://org.example/')
  expect(bad.ok).toBe(false)
  expect(JSON.stringify(bad)).not.toContain('top-secret-value')
})

test('remove forgets it', () => {
  const s = make()
  s.save(HEADER, 'https://org.example/')
  expect(s.has()).toBe(true)
  s.remove()
  expect(s.has()).toBe(false)
  expect(s.forUrl('https://org.example/')).toEqual({})
})

test('a file that cannot be decrypted counts as nothing saved', () => {
  make().save(HEADER, 'https://org.example/')
  const broken = make({
    decryptString: () => {
      throw new Error('no')
    }
  })
  expect(broken.forUrl('https://org.example/')).toEqual({})
})
