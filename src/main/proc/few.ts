/**
 * Like Promise.all over items.map(fn), but with at most `limit` running at once. Starting a process holds up the
 * thread that starts it, so starting sixteen at once held up the main process for one long stretch; a couple at a time
 * spreads that into short ones, with input and messages handled in between. Results keep the items' order.
 */
export async function mapFew<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return results
}
