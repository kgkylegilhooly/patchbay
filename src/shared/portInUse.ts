import type { PortInfo } from './contract'

/** F68: what a window that failed on a taken port says, and who holds it. See src/main/portInUse.ts. */
export interface PortInUse {
  /** The port the error named, or null when it didn't say. */
  port: number | null
}

/** The strip's sentence: the window serving the port by name, or another program. */
export function portStripText(port: number | null, holder: string | null): string {
  if (port === null) return 'The address is already in use: another program holds the port this needs.'
  return holder ? `Port ${port} is in use by ${holder}.` : `Port ${port} is in use by another program, not a window here.`
}

/** The window, other than this one, that serves the port, or null. */
export function holderOf(ports: Record<string, PortInfo[]>, port: number | null, self: string): string | null {
  if (port === null) return null
  return Object.entries(ports).find(([id, list]) => id !== self && list.some((p) => p.port === port))?.[0] ?? null
}
