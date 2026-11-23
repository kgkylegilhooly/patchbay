import type { MenuItem } from './menus'

/**
 * View > Minimap. Ticked only while a map is on screen. When there's no room for it beside the dock it folds into the
 * dock's Map button; then one row shows and hides it from there, as that button does, rather than ticking a map that
 * isn't drawn, and a second row, under the id the shortcut and the palette use, still turns the minimap off.
 */
export function minimapItems(on: boolean, layout: { foldMap: boolean; mapOpen: boolean }, act: { togglePref: () => void; toggleFolded: () => void }): MenuItem[] {
  if (!(on && layout.foldMap)) return [{ id: 'toggle-minimap', label: 'Minimap', icon: 'map', checked: on, run: act.togglePref }]
  return [
    { id: 'show-folded-map', label: 'Minimap (in the dock for now)', icon: 'map', checked: layout.mapOpen, run: act.toggleFolded },
    { id: 'toggle-minimap', label: 'Turn the minimap off', icon: 'close', run: act.togglePref }
  ]
}
