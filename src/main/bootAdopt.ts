import type { HostInfo } from '../shared/contract'

/**
 * Boot shows the window as soon as no host answered its first knock, without waiting for the full connect (see
 * backgroundHost's `quick`). Usually that means no host was running. But a host that was there and slow to answer,
 * as after the PC wakes, is found by the connect that goes on, with its sessions: those must be adopted then, as boot
 * would have adopted them. `adopt` adopts whatever is live and not yet adopted, so it's safe to run again.
 */
export async function adoptAfterQuickBoot(
  atBoot: HostInfo,
  connect: () => Promise<HostInfo>,
  adopt: () => string[],
  adopted: (ids: string[]) => void
): Promise<string[]> {
  if (atBoot.mode !== 'starting') return []
  await connect()
  const more = adopt()
  if (more.length) adopted(more)
  return more
}
