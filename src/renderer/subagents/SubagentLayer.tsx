import { useInternalNode, ViewportPortal } from '@xyflow/react'
import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { inActiveProject, type CanvasDoc } from '../../shared/model'
import { elapsed, LINGER_MS, tokenLabel, visibleCards, type SubagentCard } from '../../shared/subagents'
import { cablePath, type Rect } from '../flowMapping'
import { absolutePosition } from '../newNodes'
import { useStore } from '../store'
import { TranscriptViewer } from '../TranscriptViewer'
import { CARD, cardSpots, type Side } from './placement'
import { closeSubagentView, followSubagents, useSubagentUi, viewSubagent } from './subagentUi'
import './subagents.css'

const STATUS_TEXT: Record<SubagentCard['status'], string> = { running: 'Running', done: 'Done', failed: 'Failed' }

/** The current time, every second while anything shown is counting. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** Every other window's rectangle on the canvas, for placing cards clear of them. */
function othersOf(doc: CanvasDoc, parentId: string): Rect[] {
  return doc.nodes
    .filter((n) => n.id !== parentId && n.kind !== 'group' && inActiveProject(doc, n))
    .map((n) => ({ ...absolutePosition(doc, n), width: n.width, height: n.height }))
}

function Card({ card, rect, fading, now }: { card: SubagentCard; rect: Rect; fading: boolean; now: number }): React.JSX.Element {
  const tokens = tokenLabel(card)
  const time = elapsed((card.endedAt ?? now) - card.startedAt)
  const title = `${card.agentType}: ${card.description}`
  return (
    <button
      type="button"
      className={`sa-card sa-${card.status}${fading ? ' sa-fading' : ''} nopan nodrag`}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      data-subagent={card.id}
      data-status={card.status}
      title={`${title}${card.failure ? `\n${card.failure}` : ''}\nClick to read its transcript.`}
      onClick={() => viewSubagent(card.parentId, card.id, title)}
    >
      <span className="sa-top">
        <span className="sa-dot" aria-hidden />
        <span className="sa-type">
          {card.agentType}
          {card.depth > 1 ? ' (nested)' : ''}
        </span>
        <span className="sa-time">{time}</span>
      </span>
      <span className="sa-desc">{card.description}</span>
      <span className="sa-meta">
        {card.status === 'failed' && card.failure ? `Failed: ${card.failure}` : STATUS_TEXT[card.status]}
        {` · ${card.tools} ${card.tools === 1 ? 'tool' : 'tools'}`}
        {tokens && <span title={card.status === 'running' ? 'Estimated: the context size of its latest reply' : 'The context size of its last reply'}> · {tokens}</span>}
      </span>
    </button>
  )
}

/** A cable from the window's side to a card, drawn like an "opened" cable. */
function cableTo(parent: Rect, card: Rect, side: Side): string {
  if (side === 'right') return cablePath(parent.x + parent.width, parent.y + parent.height / 2, card.x, card.y + card.height / 2).path
  if (side === 'left') return cablePath(card.x + card.width, card.y + card.height / 2, parent.x, parent.y + parent.height / 2).path
  return `M ${parent.x + parent.width / 2} ${parent.y + parent.height} L ${card.x + card.width / 2} ${card.y}`
}

const ParentCards = memo(function ParentCards({ parentId, cards, now, doc }: { parentId: string; cards: SubagentCard[]; now: number; doc: CanvasDoc }) {
  const internal = useInternalNode(parentId)
  const node = doc.nodes.find((n) => n.id === parentId)
  const { shown, more } = visibleCards(cards, now)
  const others = useMemo(() => othersOf(doc, parentId), [doc, parentId])
  if (!node || shown.length === 0) return null
  // Live while the window is dragged; the saved place otherwise.
  const at = internal?.internals.positionAbsolute ?? absolutePosition(doc, node)
  const parent: Rect = { x: at.x, y: at.y, width: internal?.measured.width ?? node.width, height: internal?.measured.height ?? node.height }
  const { side, spots } = cardSpots(parent, shown.length + (more ? 1 : 0), others)
  return (
    <div className="sa-group" data-subagents-of={parentId}>
      <svg className="sa-cables" aria-hidden>
        {spots.map((spot, i) => (
          <path key={i} className={`sa-cable${shown[i]?.fading ? ' sa-fading' : ''}`} d={cableTo(parent, spot, side)} />
        ))}
      </svg>
      {shown.map(({ card, fading }, i) => (
        <Card key={card.id} card={card} rect={spots[i]} fading={fading} now={now} />
      ))}
      {more > 0 && (
        <div className="sa-card sa-more nopan" style={{ left: spots[shown.length].x, top: spots[shown.length].y, ...CARD }} title="Only eight cards are shown beside a window.">
          +{more} more
        </div>
      )}
    </div>
  )
})

/** Reads a subagent's transcript, again every two seconds while it's still running. */
function SubagentTranscript(): React.JSX.Element | null {
  const viewing = useSubagentUi((s) => s.viewing)
  const running = useSubagentUi((s) => (viewing ? s.groups[viewing.nodeId]?.cards.find((c) => c.id === viewing.agentId)?.status === 'running' : false))
  const [read, setRead] = useState<{ text: string | null; missing: string | null }>({ text: null, missing: null })
  useEffect(() => {
    setRead({ text: null, missing: null })
    const bridge = window.patchbaySubagents
    if (!viewing || !bridge) return
    let live = true
    const load = (): void =>
      void bridge.transcript(viewing.nodeId, viewing.agentId).then((r) => {
        if (live) setRead(r.ok ? { text: r.text, missing: null } : { text: null, missing: r.reason })
      })
    load()
    const timer = running ? setInterval(load, 2000) : undefined
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [viewing, running])
  if (!viewing) return null
  return createPortal(
    <TranscriptViewer className="sa-viewer" title={viewing.title} label={`Transcript of subagent ${viewing.title}`} text={read.text} missing={read.missing} onClose={closeSubagentView} />,
    document.body
  )
}

/**
 * Live cards for each Claude window's subagents, drawn in the canvas's own coordinates but outside its nodes: they
 * aren't nodes, so they're never saved, undone, listed or sent to. The Eye button on a window hides its cards.
 */
export function SubagentLayer(): React.JSX.Element | null {
  const groups = useSubagentUi((s) => s.groups)
  const hidden = useSubagentUi((s) => s.hidden)
  const doc = useStore((s) => s.doc)
  useEffect(() => followSubagents(), [])
  const shown = Object.entries(groups).filter(([id]) => {
    const node = doc?.nodes.find((n) => n.id === id)
    return !hidden[id] && node?.kind === 'claude' && inActiveProject(doc!, node)
  })
  // Counts only while a card is running or fading out.
  const ticking = shown.some(([, g]) => g.cards.some((c) => c.status === 'running' || (c.endedAt ?? 0) + LINGER_MS > Date.now()))
  const now = useNow(ticking)
  if (!doc) return null
  return (
    <>
      <ViewportPortal>
        {shown.map(([id, g]) => (
          <ParentCards key={id} parentId={id} cards={g.cards} now={now} doc={doc} />
        ))}
      </ViewportPortal>
      <SubagentTranscript />
    </>
  )
}
