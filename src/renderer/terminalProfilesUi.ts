import { useEffect, useState } from 'react'
import type { ProfileList, TerminalProfile, TerminalProfileBridge } from '../shared/terminalProfiles'

declare global {
  interface Window {
    patchbayTerminalProfiles?: TerminalProfileBridge
  }
}

/** The settings page's and the new-terminal menus' calls to main. See src/preload/terminalProfiles.ts. */
export const terminalProfileBridge = (): TerminalProfileBridge | undefined => (typeof window === 'undefined' ? undefined : window.patchbayTerminalProfiles)

let current: ProfileList | null = null
const listeners = new Set<(list: ProfileList) => void>()

function set(list: ProfileList): void {
  current = list
  for (const cb of listeners) cb(list)
}

/** Reads the profiles again, as after Settings saves them. */
export function refreshTerminalProfiles(): Promise<ProfileList | null> {
  const b = terminalProfileBridge()
  if (!b) return Promise.resolve(null)
  return b.list().then((list) => (set(list), list)).catch(() => null)
}

export function setTerminalProfiles(list: ProfileList): void {
  set(list)
}

/**
 * The profiles as last read, the default first. Menus are built when they open, so they read this rather than wait;
 * the first read starts at load, long before a menu can open.
 */
export function currentTerminalProfiles(): ProfileList | null {
  return current
}

export function useTerminalProfiles(): ProfileList | null {
  const [list, setList] = useState(current)
  useEffect(() => {
    listeners.add(setList)
    if (current) setList(current)
    // Read again each time a page that shows them opens, so a hand edit of settings.json shows up.
    void refreshTerminalProfiles()
    return () => void listeners.delete(setList)
  }, [])
  return list
}

/** A profile's folder, when it has one, for a new terminal opened with no folder chosen. With no id, the default's. */
export function profileFolder(id: string | undefined): string | undefined {
  return (id ? current?.profiles.find((p) => p.id === id) : current?.profiles[0])?.cwd
}

/**
 * Where a new terminal opens, in the same order as `patchbay open-terminal`: a folder the person chose, then the group's
 * worktree, then the profile's folder, then wherever new sessions open otherwise.
 */
export function terminalFolderFor(o: { chosen?: string; worktree?: string; profileCwd?: string; fallback: string }): string {
  return o.chosen || o.worktree || o.profileCwd || o.fallback
}

/** The profiles other than the default, which plain New terminal already opens. */
export function otherProfiles(): TerminalProfile[] {
  return current ? current.profiles.slice(1) : []
}

/** Menu items for opening a terminal with each profile other than the default. */
export function terminalProfileItems(open: (profileId: string) => void): Array<{ id: string; label: string; icon: 'terminal'; run: () => void }> {
  // Menus are built as they open and can't wait, so this one shows the last list read, and the next one the fresh one.
  void refreshTerminalProfiles()
  return otherProfiles().map((p) => ({ id: `new-terminal-profile:${p.id}`, label: `New terminal: ${p.name}`, icon: 'terminal' as const, run: () => open(p.id) }))
}

void refreshTerminalProfiles()

/** What a new terminal records for a picked profile. Nothing for the default, which main records when it starts. */
export function pickedProfile(id: string | undefined): { id: string; name: string } | undefined {
  if (!id || !current || id === current.defaultId) return undefined
  const p = current.profiles.find((x) => x.id === id)
  return p ? { id: p.id, name: p.name } : undefined
}
