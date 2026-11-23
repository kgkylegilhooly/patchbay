import type { MenuItem } from './menus'

/**
 * View > Minimap. Ticked only while a map is on screen: when there's no room for it beside the dock, it folds into the
 * dock's Map button, and then the item shows and hides it from there, as that button does, rather than ticking a map
 * that isn't drawn.
 */
export function minimapItem(on: boolean, layout: { foldMap: boolean; mapOpen: boolean }, act: { togglePref: () => void; toggleFolded: () => void }): MenuItem {
  const folded = on && layout.foldMap
  return {
    id: 'toggle-minimap',
    label: folded ? 'Minimap (in the dock for now)' : 'Minimap',
    icon: 'map',
    checked: folded ? layout.mapOpen : on,
    run: folded ? act.toggleFolded : act.togglePref
  }
}
