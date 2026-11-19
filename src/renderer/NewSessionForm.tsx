import { useEffect, useRef, useState } from 'react'
import { bridge } from './bridge'
import { ProfilePicker } from './TerminalProfilePicker'

const NAMES = { claude: 'New Claude', codex: 'New Codex', team: 'Spawn a team', terminal: 'New terminal', run: 'New run command' }

export function NewSessionForm({
  kind,
  initialFolder,
  initialCommand = '',
  editing = false,
  onCancel,
  onOpen
}: {
  kind: 'claude' | 'codex' | 'terminal' | 'run' | 'team'
  initialFolder: string
  initialCommand?: string
  editing?: boolean
  onCancel: () => void
  onOpen: (fields: { cwd: string; text?: string; profile?: string }) => void
}): React.JSX.Element {
  const [cwd, setCwd] = useState(initialFolder)
  const [text, setText] = useState(initialCommand)
  const [profile, setProfile] = useState<string | undefined>(undefined)
  /** The folder the person chose, so picking a profile with its own folder doesn't replace it. */
  const chose = useRef(false)
  const team = kind === 'team'
  const claude = kind === 'claude' || kind === 'codex' || team
  const agentName = kind === 'codex' ? 'Codex' : 'Claude'
  const run = kind === 'run'
  const blocked = team ? !cwd || !text.trim() : claude ? !cwd : run && !text.trim()
  const chooseRef = useRef<HTMLButtonElement>(null)
  const taskRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // The task is the one thing a team has to be given.
    if (team) taskRef.current?.focus()
    else chooseRef.current?.focus()
  }, [team])

  return (
    <form
      className={`pop ${claude ? 'pop-claude' : 'pop-terminal'}`}
      aria-label={run && editing ? 'Edit command' : NAMES[kind]}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked) return
        onOpen({ cwd, text: text.trim() || undefined, ...(kind === 'terminal' && profile ? { profile } : {}) })
      }}
    >
      {team && <p className="pop-note">One lead Claude opens here. It splits the task into workstreams, starts a team for them, and brings the results together.</p>}
      <div className="field">
        <span className="field-label">Folder</span>
        <div className="folder-row">
          <span className={cwd ? 'folder' : 'folder folder-empty'} title={cwd}>
            {cwd || (claude ? `Choose where ${agentName} will work` : 'Your home folder')}
          </span>
          <button
            ref={chooseRef}
            type="button"
            className="btn"
            onClick={() => void bridge.pickFolder().then((folder) => folder && ((chose.current = true), setCwd(folder)))}
          >
            Choose folder
          </button>
        </div>
      </div>
      {kind === 'terminal' && !editing && (
        <ProfilePicker
          value={profile}
          onChange={(id, folder) => {
            setProfile(id)
            if (folder && !chose.current) setCwd(folder)
          }}
        />
      )}
      <label className="field">
        <span className="field-label">{team ? 'The task' : claude ? 'Starting prompt (optional)' : run ? 'Command' : 'Command (optional)'}</span>
        {claude ? (
          <textarea ref={taskRef} name={team ? 'task' : undefined} rows={team ? 5 : 3} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input name="command" placeholder={run ? 'For example, npm run dev' : 'For example, codex'} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </label>
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-solid" disabled={blocked}>
          {team ? 'Start the lead' : claude ? `Open ${agentName}` : run ? (editing ? 'Save command' : 'Run') : 'Open terminal'}
        </button>
      </div>
    </form>
  )
}
