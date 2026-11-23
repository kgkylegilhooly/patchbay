/**
 * Every read-merge-write of settings.json, one after another. Settings and the terminal profiles each read the file,
 * merge in their change and write it back: two at once would each merge into the same old text, and the second would
 * undo the first.
 */
let queue: Promise<unknown> = Promise.resolve()

export function inSettingsQueue<T>(change: () => Promise<T>): Promise<T> {
  const run = queue.then(change)
  queue = run.catch(() => {})
  return run
}
