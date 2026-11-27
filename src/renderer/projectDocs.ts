import type { MenuItem } from './menus'

/**
 * A project's agent instructions (F74): CLAUDE.md shapes every Claude Code agent started in its folder, and AGENTS.md
 * every Codex one, but reaching them meant a file manager. The project tab's menu opens either in a Reader.
 */
export const PROJECT_DOCS = ['CLAUDE.md', 'AGENTS.md'] as const
export type ProjectDoc = (typeof PROJECT_DOCS)[number]

/** The file in the project's folder, written the Windows way whatever slash the folder ends in. */
export function projectDocPath(folder: string, name: ProjectDoc): string {
  return `${folder.replace(/[\\/]+$/, '')}\\${name}`
}

export interface ProjectDocDeps {
  activeProjectId: string
  switchProject(id: string): Promise<void>
  open(path: string): Promise<{ ok: true } | { ok: false; reason: string; missing?: boolean }>
  say(text: string | null, ok?: boolean): void
}

/** Shows the project, if it isn't the one on screen, so the Reader opens on its canvas; then opens the file there. */
export async function openProjectDoc(project: { id: string; name: string; folder: string }, name: ProjectDoc, d: ProjectDocDeps): Promise<void> {
  if (!project.folder) return d.say(`${project.name} has no folder of its own, so it has no ${name}. Choose folder… sets one.`)
  if (d.activeProjectId !== project.id) await d.switchProject(project.id)
  const path = projectDocPath(project.folder, name)
  const r = await d.open(path)
  if (r.ok) return d.say(null)
  d.say(r.missing ? `There's no ${name} in ${project.folder}.` : r.reason)
}

/** The project tab's menu items. A project without a folder starts its sessions in the home folder, so none. */
export function projectDocEntries(project: { folder: string }, open: (name: ProjectDoc) => void): MenuItem[] {
  if (!project.folder) return []
  return PROJECT_DOCS.map((name): MenuItem => ({ id: `open-${name.toLowerCase().replace('.', '-')}`, label: `Open ${name}`, icon: 'note', run: () => open(name) }))
}
