import { memo, useEffect, useRef, useState } from 'react'
import { MenuPanel } from './Menu'
import { editMenu, fileMenu, settingsMenu, viewMenu, type Commands, type MenuEntry, type MenuState } from './menus'
import { ProjectTabs } from './ProjectTabs'
import { UsagePill } from './UsagePill'

const NAMES = ['File', 'Edit', 'View', 'Settings'] as const
type Name = (typeof NAMES)[number]

const BUILD: Record<Name, (c: Commands, s: MenuState) => MenuEntry[]> = {
  File: fileMenu,
  Edit: editMenu,
  View: viewMenu,
  Settings: settingsMenu
}

/** The app's title bar: the window's own buttons are drawn over its right end. */
function TopBarView({ commands, state }: { commands: Commands; state: () => MenuState }): React.JSX.Element {
  const [open, setOpen] = useState<Name | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    const onBlur = (): void => setOpen(null)
    window.addEventListener('mousedown', onPress, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onPress, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const step = (direction: -1 | 1): void => {
    setOpen((name) => (name ? NAMES[(NAMES.indexOf(name) + direction + NAMES.length) % NAMES.length] : name))
  }

  return (
    <header className="bar">
      <span className="wordmark">
        Patchbay
        {/* A copy run from source, with its own canvas, so it's never mistaken for the installed one. */}
        {window.patchbay.devCopy && (
          <span className="wordmark-dev" title="Run from source, with its own canvas, settings and sessions, apart from the installed Patchbay">
            dev
          </span>
        )}
      </span>
      <nav className="menubar" ref={ref} aria-label="Application menu">
        {NAMES.map((name) => (
          <div className="menubar-slot" key={name}>
            <button
              type="button"
              className={`menubar-item${open === name ? ' menubar-item-open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={open === name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen(open === name ? null : name)}
              onMouseEnter={() => open && setOpen(name)}
            >
              {name}
            </button>
            {open === name && (
              <MenuPanel key={name} entries={BUILD[name](commands, state())} label={name} onClose={() => setOpen(null)} onStep={step} />
            )}
          </div>
        ))}
      </nav>
      <ProjectTabs commands={commands} />
      <UsagePill />
    </header>
  )
}

/** Drawn again only when what it's given changes, so moving things on the canvas leaves it alone. */
export const TopBar = memo(TopBarView)
