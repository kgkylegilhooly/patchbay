import { useRef, useState } from 'react'
import { bridge } from './bridge'
import type { IconName } from './iconPaths'
import { FormShell } from './shell/FormShell'
import { ProfilePicker } from './TerminalProfilePicker'

/** The same words as the menu items that open each form. */
const NAMES = { claude: 'New Claude Code', codex: 'New Codex', team: 'New team', terminal: 'New terminal', run: 'New run command' }
const ICONS: Record<keyof typeof NAMES, IconName> = { claude: 'claude', codex: 'codex', team: 'team', terminal: 'terminal', run: 'run' }

export function NewSessionForm({
  kind,
  initialFolder,
  initialCommand = '',
  folderFor,
  editing = false,
  onCancel,
  onOpen
}: {
  kind: 'claude' | 'codex' | 'terminal' | 'run' | 'team'
  initialFolder: string
  initialCommand?: string
  /** For a terminal: where one of this profile (the default, with none) opens when no folder is chosen. */
  folderFor?: (profile: string | undefined) => string
  editing?: boolean
  onCancel: () => void
  onOpen: (fields: { cwd: string; text?: string; profile?: string }) => void
}): React.JSX.Element {
  const [cwd, setCwd] = useState(() => (folderFor ? folderFor(undefined) : initialFolder))
  const [text, setText] = useState(initialCommand)
  const [profile, setProfile] = useState<string | undefined>(undefined)
  /** The folder the person chose, so picking a profile with its own folder doesn't replace it. */
  const chose = useRef(false)
  const team = kind === 'team'
  const claude = kind === 'claude' || kind === 'codex' || team
  const agentName = kind === 'codex' ? 'Codex' : 'Claude Code'
  const run = kind === 'run'
  const blocked = team ? !cwd || !text.trim() : claude ? !cwd : run && !text.trim()
  const title = run && editing ? 'Edit command' : NAMES[kind]

  return (
    <FormShell
      title={title}
      icon={run && editing ? 'edit' : ICONS[kind]}
      className={claude ? 'pop-claude' : 'pop-terminal'}
      onCancel={onCancel}
      blocked={blocked}
      hint={claude}
      submitLabel={team ? 'Start team lead' : claude ? `Start ${agentName}` : run ? (editing ? 'Save command' : 'Start run') : 'Start terminal'}
      onSubmit={() => onOpen({ cwd, text: text.trim() || undefined, ...(kind === 'terminal' && profile ? { profile } : {}) })}
    >
      {team && <p className="pop-note">One lead Claude opens here. It splits the task into workstreams, starts a team for them, and brings the results together.</p>}
      <div className="field">
        <span className="field-label">Folder</span>
        <div className="folder-row">
          <span className={cwd ? 'folder' : 'folder folder-empty'} title={cwd}>
            {cwd || (claude ? `Choose where ${agentName} will work` : 'Your home folder')}
          </span>
          <button
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
          onChange={(id) => {
            setProfile(id)
            // The same order as the menus and patchbay open-terminal: see terminalFolderFor.
            if (folderFor && !chose.current) setCwd(folderFor(id))
          }}
        />
      )}
      <label className="field">
        <span className="field-label">{team ? 'The task' : claude ? 'Starting prompt (optional)' : run ? 'Command' : 'Command (optional)'}</span>
        {claude ? (
          // The folder is already filled in, so typing goes to the prompt or the command.
          <textarea data-autofocus name={team ? 'task' : undefined} rows={team ? 5 : 3} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input data-autofocus name="command" placeholder={run ? 'For example, npm run dev' : 'For example, codex'} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </label>
    </FormShell>
  )
}
