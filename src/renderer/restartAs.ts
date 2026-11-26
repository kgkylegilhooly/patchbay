import { create } from 'zustand'
import { modelNameOf, startModeOf, type StartMode } from '../shared/startMode'

/**
 * F69: Restart as… on a Claude window: another permission mode or model for an agent already open. The node keeps the
 * choice (F61), and the restart resumes its conversation, as Restart does.
 */
export const useRestartAs = create<{ nodeId: string | null }>(() => ({ nodeId: null }))
export const openRestartAs = (nodeId: string): void => useRestartAs.setState({ nodeId })
export const closeRestartAs = (): void => useRestartAs.setState({ nodeId: null })

/** What the node keeps: only a fixed mode and a one-word model. Blank, or anything else, goes back to Settings. */
export function restartAsPatch(mode: StartMode | '', model: string): { startMode: StartMode | undefined; model: string | undefined } {
  return { startMode: startModeOf(mode), model: modelNameOf(model) }
}
