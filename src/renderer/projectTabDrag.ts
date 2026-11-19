/** Where a dragged project tab would land: just before another tab, or after the last (null). */
export interface TabDrop {
  before: string | null
}

/**
 * From the pointer's x and the middle of each open tab, left to right. A drop that would leave the tab where it is
 * gives null, so no marker is drawn and nothing is moved.
 */
export function dropTarget(tabs: Array<{ id: string; mid: number }>, dragId: string, x: number): TabDrop | null {
  const index = tabs.findIndex((t) => x < t.mid)
  const before = index === -1 ? null : tabs[index].id
  const from = tabs.findIndex((t) => t.id === dragId)
  if (from === -1) return { before }
  const after = tabs[from + 1]?.id ?? null
  if (before === dragId || before === after) return null
  return { before }
}
