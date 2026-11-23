import type { CanvasDoc } from '../../shared/model'

/**
 * Items whose JSON is at least this long keep it, by object. A big whiteboard was turned into text again with every
 * move of the view, though its node hadn't changed. Small items aren't worth the memory.
 */
const CACHE_FROM_CHARS = 16 * 1024

/** The doc's arrays whose items are kept whole by the reducer when they don't change. */
const ITEM_ARRAYS = new Set(['nodes', 'projects'])

const cache = new WeakMap<object, string>()

function itemJson(item: unknown): string {
  if (typeof item !== 'object' || item === null) return JSON.stringify(item) ?? 'null'
  const known = cache.get(item)
  if (known !== undefined) return known
  const text = JSON.stringify(item) ?? 'null'
  if (text.length >= CACHE_FROM_CHARS) cache.set(item, text)
  return text
}

/**
 * Exactly JSON.stringify(doc), reusing the text of big nodes and projects that are the same objects as last time.
 * The doc is never changed in place (see src/core/canvas/reduce.ts), so the same object always has the same text.
 */
export function docJson(doc: CanvasDoc): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue
    const text = ITEM_ARRAYS.has(key) && Array.isArray(value) ? `[${value.map(itemJson).join(',')}]` : JSON.stringify(value)
    if (text === undefined) continue
    parts.push(`${JSON.stringify(key)}:${text}`)
  }
  return `{${parts.join(',')}}`
}
