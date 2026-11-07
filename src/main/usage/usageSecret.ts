import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

export interface UsageSecret {
  save(header: string, url: string): { ok: true } | { ok: false; problem: string }
  /** `mismatch` is the address it was saved for, when this URL isn't on it. */
  forUrl(url: string): { header?: string; mismatch?: string }
  has(): boolean
  remove(): void
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The sign-in header for a usage source. It's tied to the address it was saved for, so editing the URL later can't
 * carry it to another host, and it's only ever held encrypted. It never leaves main.
 */
export function createUsageSecret({ file, crypto }: { file: string; crypto: Encryptor }): UsageSecret {
  const load = (): { header: string; origin: string } | null => {
    try {
      const saved = JSON.parse(crypto.decryptString(readFileSync(file)))
      return typeof saved?.header === 'string' && typeof saved?.origin === 'string' ? saved : null
    } catch {
      return null
    }
  }
  return {
    save(header, url) {
      const origin = originOf(url)
      if (!origin || origin === 'null') return { ok: false, problem: 'Enter the URL first, so the header can be tied to that address.' }
      if (!/^[A-Za-z0-9-]+:\s*\S/.test(header)) return { ok: false, problem: 'Write it as Name: value, for example Authorization: Bearer and your token.' }
      if (!crypto.isEncryptionAvailable()) return { ok: false, problem: "Windows can't encrypt it right now, so it wasn't saved." }
      writeFileSync(file, crypto.encryptString(JSON.stringify({ header, origin })))
      return { ok: true }
    },
    forUrl(url) {
      const saved = load()
      if (!saved) return {}
      return originOf(url) === saved.origin ? { header: saved.header } : { mismatch: saved.origin }
    },
    has: () => load() !== null,
    remove() {
      rmSync(file, { force: true })
    }
  }
}
