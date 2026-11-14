import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WhiteboardNode } from '../shared/model'
import { boardArea, describeBoard, whiteboardSvg } from '../shared/whiteboard'

/** Exports kept on disk. Older ones go, oldest first, so they can't pile up. */
const KEPT = 50
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PNG = 20 * 1024 * 1024

export interface WhiteboardExport {
  /** The picture, for an agent to look at. Null if the window couldn't draw it, in which case the SVG is still there. */
  image: string | null
  svg: string
  width: number
  height: number
  shapes: Record<string, number>
  texts: string[]
}

export interface WhiteboardExporter {
  export(node: WhiteboardNode): Promise<WhiteboardExport>
}

/** Only a real PNG of a sane size is written, whatever the page sends back. */
export function isPng(bytes: unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.length > PNG.length && bytes.length <= MAX_PNG && PNG.every((b, i) => bytes[i] === b)
}

function prune(dir: string): void {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && /^board-.*\.(png|svg)$/.test(f.name))
    .map((f) => ({ name: f.name, at: statSync(join(dir, f.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of files.slice(KEPT * 2)) rmSync(join(dir, old.name), { force: true })
}

/**
 * Saves a board as an SVG built here from the saved shapes, and as a PNG the app window draws from that SVG. Both
 * come from what's saved, so it works whatever's on screen, and with the window hidden.
 */
export function createWhiteboardExporter({ dir, render }: { dir: string; render: (svg: string, width: number, height: number) => Promise<unknown> }): WhiteboardExporter {
  return {
    async export(node) {
      const area = boardArea(node)
      const { svg, width, height } = whiteboardSvg(node.shapes, area.width, area.height)
      mkdirSync(dir, { recursive: true })
      const base = join(dir, `board-${new Date().toISOString().replace(/[:.]/g, '-')}-${node.id.slice(0, 8)}`)
      writeFileSync(`${base}.svg`, svg)
      let image: string | null = null
      const png = await render(svg, width, height).catch(() => null)
      if (isPng(png)) {
        image = `${base}.png`
        writeFileSync(image, png)
      }
      prune(dir)
      return { image, svg: `${base}.svg`, width, height, ...describeBoard(node.shapes) }
    }
  }
}
