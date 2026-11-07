import type { NodeProps } from '@xyflow/react'
import { memo, useMemo, useState } from 'react'
import type { StickyNode as StickyModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { closeNodes, patchNode } from '../store'
import { renderMarkdown } from '../stickyRender'
import { Jacks, Resizer } from './NodeChrome'

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as StickyModel
  const [draft, setDraft] = useState<string | null>(null)
  const html = useMemo(() => renderMarkdown(node.text), [node.text])

  const save = (): void => {
    if (draft !== null && draft !== node.text) patchNode(node.id, { text: draft })
    setDraft(null)
  }

  return (
    <div className={`tape${selected ? ' tape-selected' : ''}`}>
      <Resizer node={node} min={{ w: 160, h: 90 }} />
      <Jacks />
      <button className="icon-btn tape-close nodrag" aria-label="Delete note" title="Delete note" onClick={() => closeNodes([node.id])}>
        ×
      </button>
      {draft !== null ? (
        <textarea
          className="tape-edit nodrag nowheel"
          aria-label="Note text, written in markdown"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft(null)
          }}
        />
      ) : node.text ? (
        <div
          className="tape-text nowheel"
          onDoubleClick={() => setDraft(node.text)}
          // Links must never navigate the app window. Web links go out through main, which checks them.
          onClick={(e) => {
            const link = (e.target as HTMLElement).closest('a')
            if (!link) return
            e.preventDefault()
            const href = link.getAttribute('href')
            if (href) void bridge.openTerminalLink(node.id, href)
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="tape-text tape-empty" onDoubleClick={() => setDraft('')}>
          Double-click to write a note
        </div>
      )}
    </div>
  )
})
