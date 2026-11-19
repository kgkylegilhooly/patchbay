import { open } from 'node:fs/promises'
import { subagentTranscriptText } from '../../core/subagents/parse'

/** Readings of subagent transcripts, kept so one open in the viewer costs only what was added since. */
const read = new Map<string, { offset: number; text: string }>()
const READ_CACHE = 8
const BIGGEST = 16 * 1024 * 1024

export async function readSubagentTranscript(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    let cached = read.get(path)
    if (!cached || cached.offset > size) cached = { offset: Math.max(0, size - BIGGEST), text: '' }
    if (size > cached.offset) {
      const buffer = Buffer.alloc(size - cached.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cached.offset)
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
      const added = subagentTranscriptText(buffer.subarray(0, end).toString('utf8'))
      cached = { offset: cached.offset + end, text: added ? (cached.text ? `${cached.text}\n${added}` : added) : cached.text }
    }
    read.delete(path)
    read.set(path, cached)
    if (read.size > READ_CACHE) read.delete(read.keys().next().value as string)
    return cached.text
  } finally {
    await handle.close()
  }
}
