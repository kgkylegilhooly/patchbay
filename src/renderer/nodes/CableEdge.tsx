import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { memo, useEffect, useMemo, useRef } from 'react'
import { cableDirection, cableMessages } from '../cableMotion'
import { alignCableDots, cableUnderWay } from '../cableActivity'
import { watchCableSight } from '../cableSight'
import './cablePerf.css'
import { relativeTime } from '../sidebarView'
import { cablePath, type FlowEdge } from '../flowMapping'
import { dispatch, patchNode, useStore } from '../store'
import type { NodeMessage } from '../../shared/contract'

const NO_MESSAGES: NodeMessage[] = []

export const CableEdge = memo(function CableEdge({ id, source, target, sourceX, sourceY, targetX, targetY, selected, data, markerEnd }: EdgeProps<FlowEdge>) {
  const { path, midX, sagY } = cablePath(sourceX, sourceY, targetX, targetY)
  const kind = data?.kind
  const oneWay = !!kind && cableDirection(kind) === 'forward'
  const pulse = useStore((s) => s.pulses[id])
  const underWay = useStore((s) => oneWay && cableUnderWay({ status: s.statuses[source], running: s.runs[source]?.running }, { status: s.statuses[target], running: s.runs[target]?.running }))
  const dots = useRef<SVGPathElement>(null)
  useEffect(() => {
    if (underWay) alignCableDots(dots.current)
  }, [underWay])
  // Off screen, its dots stand still. See cableSight.ts.
  useEffect(() => (oneWay ? watchCableSight(dots.current) : undefined), [oneWay])
  // Every message would render every cable. Only a selected link lists them, so only it reads them.
  const messages = useStore((s) => (selected && kind === 'link' ? s.messages : NO_MESSAGES))
  // Only a selected cable shows what was said along it, so only one works it out.
  const said = useMemo(() => (selected && kind === 'link' ? cableMessages(messages, source, target) : []), [selected, kind, messages, source, target])
  const titleOf = (nodeId: string): string => useStore.getState().doc?.nodes.find((n) => n.id === nodeId)?.title ?? 'A closed node'
  const unplug = kind === 'link' ? () => dispatch({ op: 'removeEdge', id }) : kind === 'trigger' ? () => patchNode(source, { targetId: null }) : null
  return (
    <>
      <path className="cable-shadow" d={path} fill="none" />
      <BaseEdge id={id} path={path} interactionWidth={18} markerEnd={markerEnd} />
      {/* The path runs from source to target, so the dots travel the way the cable does. See the keyframes. */}
      {oneWay && <path ref={dots} className={underWay ? 'cable-flow' : 'cable-flow cable-still'} d={path} fill="none" />}
      {/* A message on its way: the cable lights up and a pulse runs down it, from the sender to the receiver. */}
      {pulse && (
        <g key={pulse.at} className="cable-message">
          <path className="cable-lit" d={path} fill="none" />
          <circle className="cable-pulse" r={5}>
            <animateMotion dur="0.85s" repeatCount="3" path={path} keyPoints={pulse.reverse ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
          </circle>
        </g>
      )}
      {selected && unplug && (
        <EdgeLabelRenderer>
          {said.length > 0 && (
            <section
              className="cable-log nodrag nopan nowheel"
              aria-label={`Messages between ${titleOf(source)} and ${titleOf(target)}`}
              style={{ transform: `translate(-50%, calc(-100% - 24px)) translate(${midX}px, ${sagY}px)` }}
            >
              <h3 className="cable-log-head">Recent messages</h3>
              <ol>
                {said.map((m) => (
                  <li key={`${m.at}-${m.from}`}>
                    <div className="cable-log-meta">
                      <strong>{titleOf(m.from)}</strong> to {titleOf(m.to)}, {relativeTime(m.at, Date.now())}
                    </div>
                    <p className="cable-log-text">{m.text}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <button
            className="btn unplug nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${sagY}px)` }}
            onClick={unplug}
          >
            Unplug
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
})
