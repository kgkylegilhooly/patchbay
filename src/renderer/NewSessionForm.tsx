import { modelNameOf, START_MODE_LABELS, START_MODES, type StartMode } from '../shared/startMode'
import { useRef, useState } from 'react'
import { bridge } from './bridge'
import { shortPath } from './shortPath'
import type { IconName } from './iconPaths'
import { FormShell } from './shell/FormShell'
import { ProfilePicker } from './TerminalProfilePicker'
import { blockedReason, once, oneOpen } from './startHints'
import { AgentProgramWarning } from './AgentProgramWarning'
import { RecentPromptsButton } from './RecentPromptsButton'
import { rememberPrompt } from './recentPrompts'

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
  onOpen: (fields: { cwd: string; text?: string; profile?: string; chose?: boolean; startMode?: StartMode; model?: string }) => void
}): React.JSX.Element {
  const [cwd, setCwd] = useState(() => (folderFor ? folderFor(undefined) : initialFolder))
  const [text, setText] = useState(initialCommand)
  const [profile, setProfile] = useState<string | undefined>(undefined)
  // F61: how this Claude starts, over the global setting. Blank keeps the global one.
  const [mode, setMode] = useState<StartMode | ''>('')
  const [model, setModel] = useState('')
  const own = (): { startMode?: StartMode; model?: string } => (kind === 'claude' ? { ...(mode ? { startMode: mode } : {}), ...(modelNameOf(model) ? { model: modelNameOf(model) } : {}) } : {})
  /** The folder the person chose, so picking a profile with its own folder doesn't replace it. */
  const chose = useRef(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  // One folder picker at a time, and one start per form: Ctrl+Enter pressed again, or a second picker's answer, does
  // nothing more.
  const [pickFolder] = useState(() => oneOpen(() => bridge.pickFolder()))
  const latestOpen = useRef(onOpen)
  latestOpen.current = onOpen
  const [openOnce] = useState(() =>
    once((fields: Parameters<typeof onOpen>[0]) => {
      // An agent's prompt, kept for Recent. One filled in for the person (a handoff, a fix brief) only if they changed it.
      if (kind !== 'terminal' && kind !== 'run' && fields.text && fields.text !== initialCommand.trim()) rememberPrompt(fields.text)
      latestOpen.current(fields)
    })
  )
  const team = kind === 'team'
  const claude = kind === 'claude' || kind === 'codex' || team
  const agentName = kind === 'codex' ? 'Codex' : 'Claude Code'
  const run = kind === 'run'
  const blocked = team ? !cwd || !text.trim() : claude ? !cwd : run && !text.trim()
  const title = run && editing ? 'Edit command' : NAMES[kind]
  /** Asks for a folder. With `start`, an agent starts there once one is chosen, so Ctrl+Enter with no folder still starts. */
  const chooseFolder = (start: boolean): void =>
    void pickFolder().then((folder) => {
      if (!folder) return
      chose.current = true
      setCwd(folder)
      if (start && !blockedReason(kind, { cwd: folder, text })) openOnce({ cwd: folder, text: text.trim() || undefined, chose: true, ...own() })
      else promptRef.current?.focus()
    })

  return (
    <FormShell
      title={title}
      icon={run && editing ? 'edit' : ICONS[kind]}
      className={claude ? 'pop-claude' : 'pop-terminal'}
      onCancel={onCancel}
      blocked={blocked}
      blockedWhy={blockedReason(kind, { cwd, text })}
      onBlockedSubmit={claude && !cwd ? () => chooseFolder(true) : undefined}
      blockedKeyHint={claude && !cwd ? 'Ctrl+Enter asks for a folder, then starts there' : undefined}
      hint={claude}
      submitLabel={team ? 'Start team lead' : claude ? `Start ${agentName}` : run ? (editing ? 'Save command' : 'Start run') : 'Start terminal'}
      onSubmit={() => openOnce({ cwd, text: text.trim() || undefined, ...(kind === 'terminal' && profile ? { profile } : {}), ...(chose.current ? { chose: true } : {}), ...own() })}
    >
      {team && <p className="pop-note">One lead Claude opens here. It splits the task into workstreams, starts a team for them, and brings the results together.</p>}
      {claude && <AgentProgramWarning agent={kind === 'codex' ? 'codex' : kind === 'claude' ? 'claude' : undefined} />}
      <div className="field">
        <span className="field-label">Folder</span>
        <div className="folder-row">
          <span className={cwd ? 'folder' : 'folder folder-empty'} title={cwd}>
            {cwd ? shortPath(cwd) : claude ? `Choose where ${agentName} will work` : 'Your home folder'}
          </span>
          <button
            type="button"
            // With no folder yet it's the next step, so it's the button that stands out. The prompt keeps the keyboard:
            // a task typed first mustn't press it (Space would) and open the folder picker mid-sentence.
            className={claude && !cwd ? 'btn btn-solid' : 'btn'}
            data-choose-folder
            onClick={() => (claude ? chooseFolder(false) : void pickFolder().then((folder) => folder && ((chose.current = true), setCwd(folder))))}
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
        <span className="field-label" style={claude ? { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } : undefined}>
          {team ? 'The task' : claude ? 'Starting prompt (optional)' : run ? 'Command' : 'Command (optional)'}
          {claude && (
            <RecentPromptsButton
              text={text}
              onPick={(picked) => {
                setText(picked)
                promptRef.current?.focus()
              }}
            />
          )}
        </span>
        {claude ? (
          // The folder is already filled in, so typing goes to the prompt or the command.
          <textarea ref={promptRef} data-autofocus name={team ? 'task' : undefined} rows={team ? 5 : claude && initialCommand.includes('\n') ? 8 : 3} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input data-autofocus name="command" placeholder={run ? 'For example, npm run dev' : 'For example, codex'} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </label>
      {kind === 'claude' && (
        <div className="field" data-start-mode>
          <span className="field-label">How it starts (optional)</span>
          <div className="folder-row">
            <select aria-label="Permission mode" value={mode} onChange={(e) => setMode(e.target.value as StartMode | '')}>
              <option value="">As in Settings</option>
              {START_MODES.map((m) => (
                <option key={m} value={m}>
                  {START_MODE_LABELS[m]}
                </option>
              ))}
            </select>
            <input
              aria-label="Model"
              placeholder="Model, as opus or sonnet"
              spellCheck={false}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-invalid={model.trim() !== '' && !modelNameOf(model)}
              title={model.trim() && !modelNameOf(model) ? 'One word, as opus, sonnet or a model id' : undefined}
            />
          </div>
        </div>
      )}
    </FormShell>
  )
}
