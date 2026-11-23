import { closeNodes, useStore } from '../store'
import { confirmThen } from '../shell/confirmStore'
import { closeQuestion } from './nodeLabel'

/** The palette's Close this window: a busy agent is asked about first, in the one confirmation dialog. */
export function closeWindowAsking(id: string): void {
  const message = closeQuestion(useStore.getState().statuses[id])
  if (!message) return closeNodes([id])
  void confirmThen({ title: 'Close window?', message, verb: 'Close window', cancelLabel: 'Keep', attrs: { 'data-confirm': 'close' } }, () => closeNodes([id]))
}
