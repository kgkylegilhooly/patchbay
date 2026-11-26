/** The keys pressed, as Electron names them ("Ctrl+Alt+J"), or null for a modifier alone or Tab, which moves on. */
export function recordedKey(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'Tab', 'AltGraph'].includes(e.key)) return null
  // By where the key is, so Shift+1 is 1, not !, and a layout's letters read as their key.
  const name = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : e.key.length === 1 ? e.key.toUpperCase() : e.key
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', name].filter(Boolean).join('+')
}
