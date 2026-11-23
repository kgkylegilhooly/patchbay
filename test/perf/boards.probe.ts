/**
 * Polish round 2, item 3: what keeping whiteboards in canvas.json costs a save, and what splitting them into files of
 * their own would save. Measures the real docStore against canvases with boards of realistic and large sizes, and the
 * same writes as a split would do them (the canvas without shapes; one board's shapes alone). See docs/plans/r2-perf.md.
 *
 *   npx vitest run --config test/perf/vitest.probe.config.ts test/perf/boards.probe.ts
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { test } from 'vitest'
import { createDocStore } from '../../src/core/persist/docStore'
import { docJson } from '../../src/core/persist/docJson'
import { writeAtomic } from '../../src/core/persist/atomicFile'
import type { CanvasDoc, WhiteboardNode, WhiteboardShape } from '../../src/shared/model'

/** The longest the event loop was held, and the wall time, while `work` ran. */
async function timed(work: () => Promise<unknown>): Promise<{ blockMs: number; wallMs: number }> {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t = performance.now()
  await work()
  const wallMs = performance.now() - t
  h.disable()
  return { blockMs: +(h.max / 1e6).toFixed(1), wallMs: +wallMs.toFixed(1) }
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function board(id: string, strokes: number, points: number): WhiteboardNode {
  const shapes: WhiteboardShape[] = Array.from({ length: strokes }, (_, k) => ({ type: 'pen', color: '#e2b04a', size: 3, points: Array.from({ length: points * 2 }, (_, j) => Math.round(((j * 37 + k * 11) % 9000) * 1.37 * 100) / 100) }))
  return { id, kind: 'whiteboard', title: id, x: 0, y: 0, width: 800, height: 600, parentId: null, projectId: 'p1', shapes }
}

function canvas(boards: WhiteboardNode[]): CanvasDoc {
  const nodes: CanvasDoc['nodes'] = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, kind: 'terminal', title: `t${i}`, cwd: 'C:/x', x: i * 10, y: 0, width: 480, height: 300, parentId: null, projectId: `p${i % 10}` }))
  return { version: 3, projects: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, folder: 'C:/x', viewport: { x: 0, y: 0, zoom: 1 } })), activeProjectId: 'p1', viewport: { x: 0, y: 0, zoom: 1 }, edges: [], closed: [], nodes: [...nodes, ...boards] } as CanvasDoc
}

const withoutShapes = (doc: CanvasDoc): CanvasDoc => ({ ...doc, nodes: doc.nodes.map((n) => (n.kind === 'whiteboard' ? { ...n, shapes: [] } : n)) })

async function scene(name: string, boards: WhiteboardNode[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pb-boards-probe-'))
  let doc = canvas(boards)
  writeFileSync(join(dir, 'canvas.json'), JSON.stringify(doc))
  const store = createDocStore(dir, { onSaveError: () => {} })
  store.load()
  const size = statSync(join(dir, 'canvas.json')).size
  const rows: Record<string, { blockMs: number[]; wallMs: number[] }> = {}
  const note = (k: string, r: { blockMs: number; wallMs: number }): void => {
    rows[k] ??= { blockMs: [], wallMs: [] }
    rows[k].blockMs.push(r.blockMs)
    rows[k].wallMs.push(r.wallMs)
  }
  const big = boards[0]
  for (let i = 0; i < 5; i++) {
    // A view change: no board changed.
    doc = { ...doc, viewport: { x: i, y: 0, zoom: 1 } }
    note('save, no board changed (now)', await timed(() => store.save(doc)))
    // A stroke on the biggest board.
    const edited = { ...big, shapes: [...big.shapes.slice(0, -1), { ...big.shapes.at(-1)!, size: 3 + (i % 2) }] }
    doc = { ...doc, nodes: doc.nodes.map((n) => (n.id === big.id ? edited : n)) }
    note('save, one stroke on the biggest board (now)', await timed(() => store.save(doc)))
    // The same two as a split would write them: the canvas without shapes; that board's shapes alone.
    note('split: canvas without shapes', await timed(() => writeAtomic(join(dir, 'split-canvas.json'), docJson(withoutShapes(doc)))))
    note('split: one board file', await timed(() => writeAtomic(join(dir, 'split-board.json'), JSON.stringify(edited.shapes))))
  }
  console.log(`\n${name}: canvas.json ${(size / 1048576).toFixed(1)} MB, biggest board ${(JSON.stringify(big.shapes).length / 1048576).toFixed(1)} MB`)
  for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(48)} main thread held ${String(median(v.blockMs)).padStart(6)} ms   whole write ${String(median(v.wallMs)).padStart(6)} ms`)
  rmSync(dir, { recursive: true, force: true })
}

test('board saves: now and split', async () => {
  // Ordinary: three boards of 200 strokes of 150 points.
  await scene('3 ordinary boards', [board('w0', 200, 150), board('w1', 200, 150), board('w2', 200, 150)])
  // Heavy: one board drawn on for a long time, and three ordinary ones.
  await scene('1 heavy + 3 ordinary boards', [board('w0', 1500, 600), board('w1', 200, 150), board('w2', 200, 150), board('w3', 200, 150)])
  // Editing an ordinary board while a heavy one sits in the canvas.
  await scene('editing an ordinary board beside a heavy one', [board('w1', 200, 150), board('w0', 1500, 600), board('w2', 200, 150)])
}, 300_000)
