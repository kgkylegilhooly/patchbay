import type { NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { FlowNode } from '../flowMapping'
import { NodeChrome } from './NodeChrome'
import { TerminalView } from './TerminalView'

export const TerminalNode = memo(function TerminalNode({ id, data, selected }: NodeProps<FlowNode>) {
  return (
    <NodeChrome node={data.node} status={data.status} selected={selected}>
      <TerminalView nodeId={id} />
    </NodeChrome>
  )
})
