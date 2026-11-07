export interface RingBuffer {
  append(text: string): void
  read(): string
  /** Whether anything has rolled out, so `read` no longer starts at the beginning. */
  wrapped(): boolean
}

/** The tail of `text` that fits in `maxBytes` of UTF-8, starting on a character boundary. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

/** Holds the newest `capBytes` of UTF-8 text. Chunks stay separate until read, so appending stays cheap. */
export function createRingBuffer(capBytes: number, seed = ''): RingBuffer {
  let chunks: string[] = []
  let sizes: number[] = []
  let total = 0
  let head = 0
  let rolled = false

  const append = (text: string): void => {
    if (!text) return
    const size = Buffer.byteLength(text)
    chunks.push(text)
    sizes.push(size)
    total += size

    while (total - sizes[head] >= capBytes && head < chunks.length - 1) {
      total -= sizes[head]
      chunks[head] = ''
      head++
      rolled = true
    }
    if (total > capBytes) {
      const kept = utf8Tail(chunks[head], capBytes - (total - sizes[head]))
      const keptSize = Buffer.byteLength(kept)
      total += keptSize - sizes[head]
      chunks[head] = kept
      sizes[head] = keptSize
      rolled = true
    }
    if (head > 1024) {
      chunks = chunks.slice(head)
      sizes = sizes.slice(head)
      head = 0
    }
  }

  append(seed)
  return {
    append,
    read: () => chunks.slice(head).join(''),
    wrapped: () => rolled
  }
}
