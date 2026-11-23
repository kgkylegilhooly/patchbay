/**
 * Settings > About's "Check for updates by itself" switch. With no update feed there is nothing to check, so the switch
 * is off and can't be turned on, and says why, rather than showing on while doing nothing. The stored choice is kept
 * for when a feed is set.
 */
export function updateCheckRow(feed: string | undefined, updateCheck: string | undefined): { checked: boolean; disabled: boolean; help: string } {
  if (!feed?.trim()) return { checked: false, disabled: true, help: 'Set an update feed above first. With none, there is nothing to check.' }
  return { checked: updateCheck !== 'off', disabled: false, help: 'Shortly after Patchbay starts, then every 6 hours. A new version downloads, and waits for you to restart.' }
}
