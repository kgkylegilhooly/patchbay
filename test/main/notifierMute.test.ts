import { expect, test, vi } from 'vitest'
import { createNotifier } from '../../src/main/notifier'

// F26: one chatty window can be muted without muting the rest.
test("a muted window gets no notification, chime or flash, but still counts as unseen; the others are as before", () => {
  const show = vi.fn()
  const alert = vi.fn()
  const muted = new Set(['noisy'])
  const notifier = createNotifier({ show, alert, windowFocused: () => false, titleOf: (id) => id, reveal: () => {}, muted: (id) => muted.has(id) })

  notifier.notify('noisy', 'needs-you')
  notifier.notify('noisy', 'idle')
  notifier.runFailed('noisy')
  expect(show).not.toHaveBeenCalled()
  expect(alert).not.toHaveBeenCalled()
  // The taskbar badge and the tray still know it wants a look.
  expect(notifier.unseen()).toEqual(['noisy'])

  notifier.notify('quiet', 'needs-you')
  expect(alert).toHaveBeenCalledTimes(1)
  expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'quiet', body: 'Needs you.' }))

  // Unmuted, it speaks up again.
  muted.delete('noisy')
  notifier.notify('noisy', 'idle')
  expect(show).toHaveBeenCalledWith(expect.objectContaining({ title: 'noisy', body: 'Finished its turn.' }))
})
