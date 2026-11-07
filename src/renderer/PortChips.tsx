import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PortInfo } from '../shared/contract'
import { bridge } from './bridge'
import { ContextMenu } from './Menu'
import type { MenuEntry, Point } from './menus'
import { useStore } from './store'

const NONE: PortInfo[] = []

/** The two places a port can open. */
export function portMenu(open: { inNode: () => void; inSystem: () => void }): MenuEntry[] {
  return [
    { id: 'port-browser-node', label: 'Open in a browser node', icon: 'browser', run: open.inNode },
    { id: 'port-system-browser', label: 'Open in your system browser', icon: 'arrow-right', run: open.inSystem }
  ]
}

/** Click to choose where to open it. Stops the click here, so it doesn't also select what it sits on. */
export function PortChips({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const ports = useStore((s) => s.ports[nodeId] ?? NONE)
  const [menu, setMenu] = useState<{ at: Point; port: number } | null>(null)
  if (ports.length === 0) return null
  const ask = (e: React.SyntheticEvent<HTMLElement>, port: number): void => {
    e.stopPropagation()
    const box = e.currentTarget.getBoundingClientRect()
    setMenu({ at: { x: box.left, y: box.bottom + 4 }, port })
  }
  return (
    <span className="port-chips">
      {ports.map(({ port, name }) => (
        <span
          key={port}
          role="link"
          tabIndex={0}
          className="port-chip nodrag"
          data-port={port}
          title={`Open http://localhost:${port}${name ? ` (${name})` : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          aria-haspopup="menu"
          onClick={(e) => ask(e, port)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask(e, port)
          }}
        >
          :{port}
        </span>
      ))}
      {/* Drawn outside the node, because a zoomed canvas would scale and clip a menu drawn inside it. */}
      {menu &&
        createPortal(
          <ContextMenu
            at={menu.at}
            label={`Port ${menu.port}`}
            onClose={() => setMenu(null)}
            entries={portMenu({
              inNode: () => void bridge.openPortInBrowser(nodeId, menu.port),
              inSystem: () => void bridge.openPort(nodeId, menu.port)
            })}
          />,
          document.body
        )}
    </span>
  )
}
