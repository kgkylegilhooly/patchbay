import type { NodeProps } from '@xyflow/react'
import { memo, useEffect, useRef, useState } from 'react'
import type { WhiteboardNode as WhiteboardModel, WhiteboardShape } from '../../shared/model'
import { BOARD_COLORS, BOARD_SIZES, shapeSvg, shapesSvg, textSize, thinPoints, touches, whiteboardSvg } from '../../shared/whiteboard'
import type { FlowNode } from '../flowMapping'
import { Icon, type IconName } from '../icons'
import { closeNodes, patchNode } from '../store'
import { svgToPng } from '../whiteboardImage'
import { EditableTitle, Jacks, Resizer } from './NodeChrome'

type Tool = 'pen' | 'eraser' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text'

const TOOLS: Array<{ tool: Tool; icon: IconName; label: string; key: string }> = [
  { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { tool: 'line', icon: 'line', label: 'Line', key: 'L' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow', key: 'A' },
  { tool: 'rect', icon: 'rect', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
  { tool: 'text', icon: 'text', label: 'Text', key: 'T' }
]
const BY_KEY = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool]))
const COLOR_NAMES = ['Black', 'Red', 'Orange', 'Green', 'Blue', 'Purple']
const SIZE_NAMES = ['Thin', 'Medium', 'Thick']
const ERASER = 8
/** Steps of drawing that Undo can take back, per board, while it's on screen. */
const HISTORY = 100

const r1 = (n: number): number => Math.round(n * 10) / 10

export const WhiteboardNode = memo(function WhiteboardNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as WhiteboardModel
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(BOARD_COLORS[0])
  const [size, setSize] = useState(BOARD_SIZES[1])
  const [live, setLive] = useState<WhiteboardShape | null>(null)
  const [erasing, setErasing] = useState<WhiteboardShape[] | null>(null)
  const [pending, setPending] = useState<WhiteboardShape[] | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [typing, setTyping] = useState<{ x: number; y: number; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const history = useRef<{ past: WhiteboardShape[][]; future: WhiteboardShape[][] }>({ past: [], future: [] })
  const [, setStep] = useState(0)
  const surface = useRef<HTMLDivElement>(null)
  const points = useRef<number[]>([])

  // What was committed shows straight away, until the saved board comes back with it.
  useEffect(() => setPending(null), [node.shapes])
  const shapes = erasing ?? pending ?? node.shapes

  const commit = (next: WhiteboardShape[], record = true, before = shapes): void => {
    if (record) {
      history.current.past = [...history.current.past, before].slice(-HISTORY)
      history.current.future = []
    }
    setPending(next)
    setStep((n) => n + 1)
    patchNode(node.id, { shapes: next })
  }

  const undo = (): void => {
    const h = history.current
    const prev = h.past.at(-1)
    if (!prev) return
    h.past = h.past.slice(0, -1)
    h.future = [...h.future, shapes]
    commit(prev, false)
  }

  const redo = (): void => {
    const h = history.current
    const next = h.future.at(-1)
    if (!next) return
    h.future = h.future.slice(0, -1)
    h.past = [...h.past, shapes]
    commit(next, false)
  }

  /** A pointer's place on the board. The canvas zoom scales the board, so it's undone here. */
  const at = (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    const el = surface.current!
    const box = el.getBoundingClientRect()
    const scale = box.width / el.offsetWidth || 1
    return { x: r1((e.clientX - box.left) / scale), y: r1((e.clientY - box.top) / scale) }
  }

  const finishText = (): void => {
    if (typing && typing.text.trim()) commit([...shapes, { type: 'text', color, size, x: typing.x, y: typing.y, text: typing.text.slice(0, 500) }])
    setTyping(null)
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // Clicking away from text being typed puts it on the board, through the text box's blur.
    if (typing) return
    // So Ctrl+Z reaches the board, without the ring that's there for keyboard users.
    e.currentTarget.focus({ focusVisible: false } as FocusOptions)
    const p = at(e)
    if (tool === 'text') {
      e.preventDefault()
      return setTyping({ ...p, text: '' })
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (tool === 'eraser') {
      setErasing(shapes.filter((s) => !touches(s, p.x, p.y, ERASER)))
    } else if (tool === 'pen') {
      points.current = [p.x, p.y]
      setLive({ type: 'pen', color, size, points: [p.x, p.y] })
    } else {
      setLive({ type: tool, color, size, x1: p.x, y1: p.y, x2: p.x, y2: p.y })
    }
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = at(e)
    setCursor(p)
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    if (erasing) {
      const left = erasing.filter((s) => !touches(s, p.x, p.y, ERASER))
      if (left.length !== erasing.length) setErasing(left)
    } else if (live?.type === 'pen') {
      for (const c of e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) {
        const q = at(c)
        points.current.push(q.x, q.y)
      }
      setLive({ ...live, points: [...points.current] })
    } else if (live && 'x2' in live) {
      let { x, y } = p
      // Shift keeps a line to 45 degree steps, and a box or ellipse even.
      if (e.shiftKey) {
        const dx = x - live.x1
        const dy = y - live.y1
        if (live.type === 'rect' || live.type === 'ellipse') {
          const d = Math.max(Math.abs(dx), Math.abs(dy))
          x = live.x1 + Math.sign(dx || 1) * d
          y = live.y1 + Math.sign(dy || 1) * d
        } else {
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          const d = Math.hypot(dx, dy)
          x = r1(live.x1 + d * Math.cos(a))
          y = r1(live.y1 + d * Math.sin(a))
        }
      }
      setLive({ ...live, x2: x, y2: y })
    }
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (erasing) {
      const before = pending ?? node.shapes
      setErasing(null)
      if (erasing.length !== before.length) commit(erasing, true, before)
      return
    }
    if (!live) return
    setLive(null)
    if (live.type === 'pen') return commit([...shapes, { ...live, points: thinPoints(points.current) }])
    if ('x2' in live && Math.hypot(live.x2 - live.x1, live.y2 - live.y1) > 3) commit([...shapes, live])
  }

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (typing) return
    const key = e.key.toLowerCase()
    if (e.ctrlKey && !e.altKey && (key === 'y' || (key === 'z' && e.shiftKey))) redo()
    else if (e.ctrlKey && !e.altKey && key === 'z') undo()
    else if (!e.ctrlKey && !e.altKey && !e.shiftKey && BY_KEY[key]) setTool(BY_KEY[key])
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const copyImage = async (): Promise<void> => {
    try {
      const out = whiteboardSvg(shapes, surface.current?.offsetWidth ?? node.width, surface.current?.offsetHeight ?? node.height)
      const png = await svgToPng(out.svg, out.width, out.height, 2)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      setCopied('Copied')
    } catch {
      setCopied('Could not copy')
    }
    setTimeout(() => setCopied(null), 1500)
  }

  const { past, future } = history.current
  return (
    <div className={`wb${selected ? ' wb-selected' : ''}`}>
      <Resizer node={node} min={{ w: 460, h: 300 }} />
      <Jacks />
      <header className="wb-head pb-drag">
        <Icon name="whiteboard" size={16} />
        <EditableTitle node={node} />
        <span className="wb-spacer" />
        {copied && (
          <span className="wb-flash" role="status">
            {copied}
          </span>
        )}
        <button type="button" className="icon-btn nodrag" aria-label="Copy as image" title="Copy as image" disabled={!shapes.length} onClick={() => void copyImage()}>
          <Icon name="image" size={15} />
        </button>
        <button type="button" className="icon-btn nodrag" aria-label="Delete whiteboard" title="Delete whiteboard" onClick={() => closeNodes([node.id])}>
          <Icon name="trash" size={15} />
        </button>
      </header>
      <div className="wb-tools nodrag" role="toolbar" aria-label="Drawing tools">
        <span className="wb-group" role="radiogroup" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              role="radio"
              aria-checked={tool === t.tool}
              className={`wb-tool${tool === t.tool ? ' wb-on' : ''}`}
              aria-label={t.label}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool(t.tool)}
            >
              <Icon name={t.icon} size={16} />
            </button>
          ))}
        </span>
        <span className="wb-group" role="radiogroup" aria-label="Color">
          {BOARD_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              className={`wb-color${color === c ? ' wb-on' : ''}`}
              aria-label={COLOR_NAMES[i]}
              title={COLOR_NAMES[i]}
              onClick={() => setColor(c)}
            >
              <span style={{ background: c }} />
            </button>
          ))}
        </span>
        <span className="wb-group" role="radiogroup" aria-label="Size">
          {BOARD_SIZES.map((s, i) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={size === s}
              className={`wb-size${size === s ? ' wb-on' : ''}`}
              aria-label={SIZE_NAMES[i]}
              title={SIZE_NAMES[i]}
              onClick={() => setSize(s)}
            >
              <span style={{ width: s + 3, height: s + 3 }} />
            </button>
          ))}
        </span>
        <span className="wb-spacer" />
        <span className="wb-group">
          <button type="button" className="wb-tool" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
            <Icon name="undo" size={16} />
          </button>
          <button type="button" className="wb-tool" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo}>
            <Icon name="redo" size={16} />
          </button>
          <button type="button" className="wb-tool wb-clear" title="Clear the board. Undo brings it back." disabled={!shapes.length} onClick={() => commit([])}>
            Clear
          </button>
        </span>
      </div>
      <div
        ref={surface}
        className={`wb-surface nodrag nopan nowheel nokey wb-${tool}`}
        data-own-keys
        tabIndex={0}
        aria-label={`${node.title}, a whiteboard. Draw with the pointer.`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={onKey}
      >
        <svg className="wb-svg" aria-hidden="true">
          <g dangerouslySetInnerHTML={{ __html: shapesSvg(shapes) }} />
          {live && <g dangerouslySetInnerHTML={{ __html: shapeSvg(live) }} />}
          {tool === 'eraser' && cursor && <circle className="wb-eraser" cx={cursor.x} cy={cursor.y} r={ERASER} />}
        </svg>
        {!shapes.length && !live && !typing && <p className="wb-hint">Draw here. Link an agent to this board and it can export it as a picture.</p>}
        {typing && (
          <textarea
            className="wb-type"
            aria-label="Text to add to the board"
            autoFocus
            rows={1}
            value={typing.text}
            style={{ left: typing.x, top: typing.y, color, fontSize: textSize(size) }}
            onChange={(e) => setTyping({ ...typing, text: e.target.value })}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={finishText}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setTyping(null)
              else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                finishText()
              }
            }}
          />
        )}
      </div>
    </div>
  )
})
