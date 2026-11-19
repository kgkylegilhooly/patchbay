import { useEffect, useMemo, useRef, useState } from 'react'
import { isProjectOpen, isSessionNode } from '../shared/model'
import { ACTIONS, actionReady } from './actions'
import { Icon, type IconName } from './icons'
import { currentKey } from './keys'
import type { Commands, MenuState } from './menus'
import { placeItem, rankPalette, type PaletteItem } from './palette'
import { useStore } from './store'
import { terminalProfileItems } from './terminalProfilesUi'

interface Entry extends PaletteItem {
  icon: IconName
  kind: 'Action' | 'Session' | 'Project' | 'Note' | 'Whiteboard' | 'Browser' | 'Group'
  shortcut?: string | null
  run: () => void
}

/** A centered search over every action, and every session, note, board, browser and group in open projects. It holds the keyboard while it's open. */
export function CommandPalette({
  commands,
  state,
  recent,
  onRan,
  onClose
}: {
  commands: Commands
  state: MenuState
  recent: string[]
  /** An action or session was chosen, which puts it first next time. */
  onRan: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const overrides = useStore((s) => s.keyOverrides)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const entries = useMemo<Entry[]>(() => {
    const actions = ACTIONS.filter((a) => actionReady(a, state)).map((a): Entry => ({
      id: a.id,
      label: a.label,
      keywords: a.keywords,
      icon: a.icon ?? 'palette',
      kind: 'Action',
      shortcut: currentKey(a, overrides),
      run: () => a.run(commands)
    }))
    const projects = new Map((doc?.projects ?? []).map((p) => [p.id, p]))
    const sessions = (doc?.nodes ?? []).filter(isSessionNode).flatMap((n): Entry[] => {
      const project = n.projectId ? projects.get(n.projectId) : undefined
      if (project && !isProjectOpen(project)) return []
      return [{ id: `session:${n.id}`, label: n.title, detail: project?.name, keywords: [n.cwd], icon: n.kind, kind: 'Session', run: () => commands.revealNode(n.id) }]
    })
    // After sessions, so a session and a note of the same name list the session first.
    const places = (doc?.nodes ?? []).flatMap((n): Entry[] => {
      const item = placeItem(n)
      const project = n.projectId ? projects.get(n.projectId) : undefined
      if (!item || (project && !isProjectOpen(project))) return []
      return [{ id: `node:${n.id}`, ...item, detail: project?.name, run: () => commands.revealNode(n.id) }]
    })
    const closed = (doc?.projects ?? []).filter((p) => !isProjectOpen(p)).map((p): Entry => ({
      id: `reopen:${p.id}`,
      label: `Reopen project: ${p.name}`,
      keywords: ['closed'],
      icon: 'folder-open',
      kind: 'Project',
      run: () => commands.reopenProject(p.id)
    }))
    // A terminal of each profile other than the default, which New terminal opens.
    const profiles = terminalProfileItems((profile) => commands.newTerminal(undefined, undefined, profile)).map((item): Entry => ({ ...item, keywords: ['shell', 'profile'], kind: 'Action' }))
    return [...actions, ...profiles, ...sessions, ...places, ...closed]
  }, [commands, doc, overrides, state])

  const shown = useMemo(() => rankPalette(query, entries, recent), [entries, query, recent])
  const current = Math.min(active, shown.length - 1)

  const choose = (entry: Entry | undefined): void => {
    if (!entry) return
    onRan(entry.id)
    onClose()
    entry.run()
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, shown])

  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          name="palette"
          aria-label="Search actions, sessions, notes and boards"
          aria-controls="palette-list"
          aria-activedescendant={shown[current] ? `palette-${current}` : undefined}
          placeholder="Search actions, sessions, notes and boards"
          autoFocus
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (shown.length) setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(shown[current])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <li className="palette-empty">Nothing matches that.</li>}
          {shown.map((entry, i) => (
            <li
              key={entry.id}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === current}
              data-palette={entry.id}
              className={`palette-item${i === current ? ' palette-item-active' : ''}`}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => choose(entry)}
            >
              <Icon name={entry.icon} size={15} />
              <span className="palette-label">{entry.label}</span>
              {entry.detail && <span className="palette-detail">{entry.detail}</span>}
              {entry.kind !== 'Action' && <span className="palette-kind">{entry.kind}</span>}
              {entry.shortcut && <kbd className="palette-key">{entry.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
