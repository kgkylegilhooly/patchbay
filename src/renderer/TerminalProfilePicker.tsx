import { launchLine } from '../shared/terminalProfiles'
import './terminalProfiles.css'
import { useTerminalProfiles } from './terminalProfilesUi'

/** The New terminal form's choice of profile, the default first, with what it will start. */
export function ProfilePicker({ value, onChange }: { value: string | undefined; onChange: (id: string, folder?: string) => void }): React.JSX.Element | null {
  const list = useTerminalProfiles()
  if (!list) return null
  const id = value ?? list.defaultId
  const chosen = list.profiles.find((p) => p.id === id) ?? list.profiles[0]
  return (
    <label className="field">
      <span className="field-label">Profile</span>
      <select name="profile" value={chosen.id} onChange={(e) => onChange(e.target.value, list.profiles.find((p) => p.id === e.target.value)?.cwd)}>
        {list.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === list.defaultId ? `${p.name} (default)` : p.name}
          </option>
        ))}
      </select>
      <span className="tp-launch" title="What it starts">
        {launchLine(chosen.program, chosen.args)}
        {chosen.startupCommand ? `, then types: ${chosen.startupCommand.split(/\r?\n/).join(' ; ')}` : ''}
      </span>
    </label>
  )
}
