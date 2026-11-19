import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyReviewData, sanitizeReviewData, type ReviewData } from '../../shared/reviewInbox'

export interface ReviewStore {
  get(): ReviewData
  /** Changes the data and writes it to disk before returning. */
  update(change: (d: ReviewData) => ReviewData): ReviewData
}

/**
 * Review comments, review marks and chosen bases, in one JSON file. Written whole to a temporary file and renamed over
 * the old one, so a crash mid-write leaves the last good file. Nothing is lost by loading:
 * - a file that can't be read, or isn't this version's shape (a newer Patchbay's, say), is moved aside and the inbox
 *   starts empty;
 * - a file with some damaged records is copied aside whole before the good part is ever written back.
 */
export function createReviewStore(file: string, log: (line: string) => void = console.error): ReviewStore {
  let data = emptyReviewData()
  let raw: string | null = null
  try { raw = readFileSync(file, 'utf8') } catch { /* No file yet: an empty inbox. */ }
  const aside = (why: string, move: boolean): void => {
    const copy = `${file}.bad-${Date.now()}`
    try {
      if (move) renameSync(file, copy)
      else copyFileSync(file, copy)
      log(`Review inbox: ${why}; the file as it was is kept as ${copy}.`)
    } catch (e) {
      log(`Review inbox: ${why}, and it couldn't be kept aside (${(e as Error).message}).`)
    }
  }
  if (raw !== null) {
    let parsed: unknown
    let readable = true
    try { parsed = JSON.parse(raw) } catch (e) {
      readable = false
      aside(`${file} couldn't be read (${(e as Error).message})`, true)
    }
    if (readable) {
      const { data: loaded, dropped, incompatible } = sanitizeReviewData(parsed)
      if (incompatible) aside(`${file} isn't review data this version can read`, true)
      else {
        data = loaded
        if (dropped) aside(`${dropped} damaged record(s) in ${file} were left out`, false)
      }
    }
  }
  const write = (d: ReviewData): void => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(d, null, 1), 'utf8')
    renameSync(tmp, file)
  }
  return {
    get: () => data,
    update(change) {
      const next = change(data)
      if (next === data) return data
      write(next)
      data = next
      return data
    }
  }
}
