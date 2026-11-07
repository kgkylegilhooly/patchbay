import type { CanvasNode } from '../../shared/model'

export type Layout = 'grid' | 'row' | 'column'

/** Positions are in the same coordinates as the nodes given, starting at their top-left corner. */
export function arrangeNodes(nodes: CanvasNode[], layout: Layout, gap = 40): { id: string; x: number; y: number }[] {
  if (nodes.length === 0) return []
  const originX = Math.min(...nodes.map((n) => n.x))
  const originY = Math.min(...nodes.map((n) => n.y))
  const columns = layout === 'row' ? nodes.length : layout === 'column' ? 1 : Math.ceil(Math.sqrt(nodes.length))

  const columnWidths: number[] = []
  const rowHeights: number[] = []
  nodes.forEach((n, i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, n.width)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, n.height)
  })

  const offsets = (sizes: number[]): number[] => {
    let at = 0
    return sizes.map((size) => {
      const start = at
      at += size + gap
      return start
    })
  }
  const xs = offsets(columnWidths)
  const ys = offsets(rowHeights)

  return nodes.map((n, i) => ({
    id: n.id,
    x: originX + xs[i % columns],
    y: originY + ys[Math.floor(i / columns)]
  }))
}
