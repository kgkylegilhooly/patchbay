import type { NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { FlowNode } from '../flowMapping'
import { NodeChrome } from './NodeChrome'
import { TerminalView } from './TerminalView'

export const RunNode = memo(function RunNode({ id, data, selected }: NodeProps<FlowNode>) {
  return (
    <NodeChrome node={data.node} status={null} selected={selected}>
      <TerminalView nodeId={id} />
    </NodeChrome>
  )
})
