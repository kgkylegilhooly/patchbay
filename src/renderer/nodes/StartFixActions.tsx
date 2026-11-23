import type { NodeError } from '../../shared/contract'
import type { CanvasNode } from '../../shared/model'
import { bridge } from '../bridge'
import { openSettingsAt } from '../settingsAsk'
import { FIX_LABELS, FIX_SECTIONS } from '../status/startFailure'
import { restartNode } from '../store'

/**
 * The way forward from a start that failed, on the node's error strip: Settings at the section that fixes it, or a new
 * folder for one that's gone, which starts the session again there. See docs/plans/r3-start.md.
 */
export function StartFixActions({ node, error }: { node: CanvasNode; error: NodeError }): React.JSX.Element | null {
  const fix = error.fix
  if (!fix) return null
  if (fix === 'folder') {
    return (
      <div className="strip-actions">
        <button
          type="button"
          className="btn nodrag"
          data-start-fix="folder"
          onClick={() =>
            void bridge.pickFolder().then(async (cwd) => {
              if (!cwd) return
              await bridge.dispatch({ op: 'patchNode', id: node.id, patch: { cwd } })
              await restartNode(node.id)
            })
          }
        >
          {FIX_LABELS.folder}
        </button>
      </div>
    )
  }
  return (
    <div className="strip-actions">
      <button type="button" className="btn nodrag" data-start-fix={fix} onClick={() => openSettingsAt(FIX_SECTIONS[fix])}>
        {FIX_LABELS[fix]}
      </button>
    </div>
  )
}
