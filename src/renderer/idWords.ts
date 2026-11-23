/** A generated id, such as a UUID: meaningless to read, so shown only in a tooltip. */
export function isOpaqueId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/** How a browser check names the task it was for: the task's brief, else its id when that reads as a name. */
export function evidenceTaskLabel(taskId: string | undefined, brief: string | undefined): string | null {
  if (!taskId) return null
  if (brief) return `For the task "${brief}"`
  return isOpaqueId(taskId) ? 'For a task' : `For the task ${taskId}`
}
