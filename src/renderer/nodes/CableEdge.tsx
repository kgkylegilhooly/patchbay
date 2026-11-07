import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import { cableDirection } from '../cableMotion'
import { cablePath, type FlowEdge } from '../flowMapping'
import { dispatch, patchNode } from '../store'

export const CableEdge = memo(function CableEdge({ id, source, sourceX, sourceY, targetX, targetY, selected, data, markerEnd }: EdgeProps<FlowEdge>) {
  const { path, midX, sagY } = cablePath(sourceX, sourceY, targetX, targetY)
  const kind = data?.kind
  const oneWay = !!kind && cableDirection(kind) === 'forward'
  const unplug = kind === 'link' ? () => dispatch({ op: 'removeEdge', id }) : kind === 'trigger' ? () => patchNode(source, { targetId: null }) : null
  return (
    <>
      <path className="cable-shadow" d={path} fill="none" />
      <BaseEdge id={id} path={path} interactionWidth={18} markerEnd={markerEnd} />
      {/* The path runs from source to target, so the dots travel the way the cable does. See the keyframes. */}
      {oneWay && <path className="cable-flow" d={path} fill="none" />}
      {selected && unplug && (
        <EdgeLabelRenderer>
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
