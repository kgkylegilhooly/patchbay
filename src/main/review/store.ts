import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyReviewData, sanitizeReviewData, type ReviewData } from '../../shared/reviewInbox'

export interface ReviewStore {
  get(): ReviewData
  /** Changes the data and writes it to disk before returning. */
  update(change: (d: ReviewData) => ReviewData): ReviewData
}

/**
 * Review comments, review marks and chosen bases, in one JSON file. Written whole to a temporary file and renamed over
 * the old one, so a crash mid-write leaves the last good file. A file that can't be read is moved aside, not lost.
 */
export function createReviewStore(file: string, log: (line: string) => void = console.error): ReviewStore {
  let data = emptyReviewData()
  let raw: string | null = null
  try { raw = readFileSync(file, 'utf8') } catch { /* No file yet: an empty inbox. */ }
  if (raw !== null) {
    try {
      const { data: loaded, dropped } = sanitizeReviewData(JSON.parse(raw))
      data = loaded
      if (dropped) log(`Review inbox: ${dropped} damaged record(s) in ${file} were left out.`)
    } catch (e) {
      const aside = `${file}.bad-${Date.now()}`
      try { renameSync(file, aside) } catch { /* Left where it is; it'll be overwritten on the next save. */ }
      log(`Review inbox: ${file} couldn't be read (${(e as Error).message}); moved aside to ${aside}.`)
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
      write(next)
      data = next
      return data
    }
  }
}
