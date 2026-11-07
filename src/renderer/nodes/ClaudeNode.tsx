import type { NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { ClaudeNode as ClaudeNodeModel } from '../../shared/model'
import type { FlowNode } from '../flowMapping'
import { useStore } from '../store'
import { ChatView } from './ChatView'
import { NodeChrome } from './NodeChrome'
import { TerminalView } from './TerminalView'

export const ClaudeNode = memo(function ClaudeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const chat = useStore((s) => !!s.chatView[id])
  return (
    <NodeChrome node={data.node} status={data.status} selected={selected}>
      {/* The terminal stays attached while the chat shows, so switching back is instant and nothing is replayed. */}
      <div className={chat ? 'view-hidden' : 'view-fill'}>
        <TerminalView nodeId={id} />
      </div>
      {chat && <ChatView node={data.node as ClaudeNodeModel} />}
    </NodeChrome>
  )
})
