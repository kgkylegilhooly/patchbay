import type { SavedPrompt } from '../shared/savedPrompts'
import type { MenuEntry, MenuItem } from './menus'
import { promptLabel } from './recentPrompts'

/**
 * Prompts ▾ beside a prompt box (F39, F70): this project's saved prompts, other projects' in a submenu, then recent ones.
 * A pick fills the box. Save this prompt keeps what's in the box with the project; Forget a saved prompt drops one.
 */
export function PromptsEntries(o: {
  saved: SavedPrompt[]
  others: Array<{ project: string; prompt: SavedPrompt }>
  recent: string[]
  text: string
  onPick: (text: string) => void
  save: (text: string) => void
  forget: (id: string) => void
}): MenuEntry[] {
  const savedTexts = new Set(o.saved.map((p) => p.text))
  const entries: MenuEntry[] = o.saved.map((p): MenuItem => ({ id: `saved-prompt:${p.id}`, label: p.name, icon: 'pin', run: () => o.onPick(p.text) }))
  if (o.others.length) {
    entries.push({
      id: 'saved-elsewhere',
      label: 'From other projects',
      icon: 'project',
      run: () => {},
      submenu: o.others.map(({ project, prompt }): MenuItem => ({ id: `saved-prompt:${prompt.id}`, label: `${prompt.name} · ${project}`, run: () => o.onPick(prompt.text) }))
    })
  }
  const recent = o.recent.filter((t) => !savedTexts.has(t))
  if (entries.length && recent.length) entries.push('separator')
  entries.push(...recent.map((text, i): MenuItem => ({ id: `recent-prompt:${i}`, label: promptLabel(text), run: () => o.onPick(text) })))
  if (entries.length) entries.push('separator')
  const t = o.text.trim()
  entries.push({ id: 'save-prompt', label: savedTexts.has(t) ? 'Saved in this project' : 'Save this prompt', icon: 'pin', disabled: !t || savedTexts.has(t), run: () => o.save(t) })
  if (o.saved.length) {
    entries.push({
      id: 'forget-prompt',
      label: 'Forget a saved prompt',
      icon: 'trash',
      run: () => {},
      submenu: o.saved.map((p): MenuItem => ({ id: `forget-prompt:${p.id}`, label: p.name, run: () => o.forget(p.id) }))
    })
  }
  return entries
}
