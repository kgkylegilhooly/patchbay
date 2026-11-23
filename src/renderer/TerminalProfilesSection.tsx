import { useState } from 'react'
import { argsFromLines, launchLine, newProfileId, startupLines, type ProfileList, type TerminalProfile } from '../shared/terminalProfiles'
import { bridge } from './bridge'
import { confirmThen } from './shell/confirmStore'
import { setTerminalProfiles, terminalProfileBridge, useTerminalProfiles } from './terminalProfilesUi'
import './terminalProfiles.css'

/** A profile as its form holds it: arguments and the startup command as text, one per line. */
interface Draft {
  id: string
  name: string
  program: string
  args: string
  startupCommand: string
  cwd: string
  isNew: boolean
}

const toDraft = (p: TerminalProfile, isNew = false): Draft => ({
  id: p.id,
  name: p.name,
  program: p.program,
  args: p.args.join('\n'),
  startupCommand: p.startupCommand ?? '',
  cwd: p.cwd ?? '',
  isNew
})

function fromDraft(d: Draft): TerminalProfile {
  const p: TerminalProfile = { id: d.id, name: d.name.trim(), program: d.program.trim(), args: argsFromLines(d.args) }
  if (d.startupCommand.trim()) p.startupCommand = d.startupCommand.trim()
  if (d.cwd.trim()) p.cwd = d.cwd.trim()
  return p
}

/** What a profile starts, as shown under it and in its form. */
function Launch({ profile }: { profile: Pick<TerminalProfile, 'program' | 'args' | 'startupCommand'> }): React.JSX.Element {
  const typed = startupLines(profile.startupCommand)
  return (
    <span className="tp-launch">
      <code>{launchLine(profile.program || '<program>', profile.args)}</code>
      {typed.length > 0 && (
        <>
          {' '}then types <code>{typed.join(' ⏎ ')}</code>
        </>
      )}
    </span>
  )
}

function ProfileForm({ draft, taken, onChange, onSave, onCancel }: { draft: Draft; taken: (name: string) => boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }): React.JSX.Element {
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })
  const problem = !draft.name.trim() ? 'Give it a name.' : taken(draft.name) ? 'Another profile has that name.' : !draft.program.trim() ? 'Choose the program it starts.' : null
  const preview = fromDraft(draft)
  return (
    <form
      className="tp-form"
      aria-label={draft.isNew ? 'New terminal profile' : `Edit ${draft.name}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (!problem) onSave()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <label className="tp-field">
        <span>Name</span>
        <input name="tp-name" autoFocus spellCheck={false} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="tp-field">
        <span>Program</span>
        <span className="set-input-row">
          <input name="tp-program" placeholder="For example, cmd.exe" spellCheck={false} value={draft.program} onChange={(e) => set({ program: e.target.value })} />
          <button type="button" className="btn" onClick={() => void bridge.pickProgram().then((path) => path && set({ program: path }))}>
            Browse
          </button>
        </span>
      </label>
      <label className="tp-field">
        <span>Arguments</span>
        <textarea name="tp-args" rows={3} spellCheck={false} placeholder={'One per line, passed as they are.\nFor example, /k on one line and a .bat path on the next.'} value={draft.args} onChange={(e) => set({ args: e.target.value })} />
      </label>
      <label className="tp-field">
        <span>Startup command</span>
        <textarea name="tp-startup" rows={2} spellCheck={false} placeholder="Optional. Typed once at the first prompt, for example cd ~/proj && nvm use" value={draft.startupCommand} onChange={(e) => set({ startupCommand: e.target.value })} />
      </label>
      <label className="tp-field">
        <span>Folder</span>
        <span className="set-input-row">
          <input name="tp-cwd" placeholder="Optional. Where it opens when no folder is chosen" spellCheck={false} value={draft.cwd} onChange={(e) => set({ cwd: e.target.value })} />
          <button type="button" className="btn" onClick={() => void bridge.pickFolder().then((folder) => folder && set({ cwd: folder }))}>
            Choose
          </button>
        </span>
      </label>
      <div className="tp-preview">
        <span className="tp-preview-label">Starts</span>
        <Launch profile={preview} />
      </div>
      <div className="tp-form-actions">
        {problem && <span className="tp-problem">{problem}</span>}
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-solid" disabled={!!problem}>
          Save profile
        </button>
      </div>
    </form>
  )
}

/** Settings > Terminals: the profiles new terminals start from, the default first. */
export function TerminalProfilesSection(): React.JSX.Element {
  const list = useTerminalProfiles()
  const [editing, setEditing] = useState<Draft | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async (profiles: TerminalProfile[], defaultId: string): Promise<boolean> => {
    const b = terminalProfileBridge()
    if (!b) return false
    const result = await b.save(profiles.filter((p) => !p.builtIn), defaultId)
    if (!result.ok) {
      setStatus({ ok: false, text: result.reason })
      return false
    }
    setTerminalProfiles(result.list)
    setStatus({ ok: true, text: 'Saved' })
    return true
  }

  if (!list) return <p className="set-help tp-empty">Reading terminal profiles…</p>

  const custom = (l: ProfileList): TerminalProfile[] => l.profiles.filter((p) => !p.builtIn)
  const taken = (name: string): boolean => list.profiles.some((p) => p.id !== editing?.id && p.name.trim().toLowerCase() === name.trim().toLowerCase())

  const commitDraft = async (): Promise<void> => {
    if (!editing) return
    const profile = fromDraft(editing)
    const mine = custom(list)
    const next = editing.isNew ? [...mine, profile] : mine.map((p) => (p.id === profile.id ? profile : p))
    if (await save(next, list.defaultId)) setEditing(null)
  }

  const duplicate = (p: TerminalProfile): void => {
    let name = `${p.name} copy`
    for (let i = 2; list.profiles.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${p.name} copy ${i}`
    setEditing(toDraft({ ...p, id: newProfileId(), name, builtIn: undefined }, true))
  }

  const askRemove = (p: TerminalProfile): void =>
    void confirmThen(
      {
        title: `Delete "${p.name}"?`,
        message: list.defaultId === p.id ? 'New terminals go back to the automatic choice. Terminals open now keep running.' : 'Terminals open now keep running.',
        verb: 'Delete profile',
        attrs: { 'data-tp-confirm': p.id },
        verbAttrs: { 'data-tp': 'delete-confirm' }
      },
      () => remove(p.id)
    )

  const remove = (id: string): void => {
    // Deleting the default hands it back to the automatic choice.
    void save(
      custom(list).filter((p) => p.id !== id),
      list.defaultId === id ? '' : list.defaultId
    )
  }

  return (
    <div className="tp">
      <div className="tp-head">
        <div>
          <span className="set-title">Terminal profiles</span>
          <p className="set-help">
            What a new terminal starts. New terminal opens the default; the others are in the Add menu, the canvas menu, the palette and the New terminal form. A terminal keeps its profile when it restarts.
          </p>
        </div>
        <span className={status && !status.ok ? 'set-saved set-saved-bad' : 'set-saved'} role="status">
          {status?.text}
        </span>
        <button type="button" className="btn" data-tp="add" onClick={() => setEditing({ id: newProfileId(), name: '', program: '', args: '', startupCommand: '', cwd: '', isNew: true })}>
          Add profile
        </button>
      </div>
      {editing?.isNew && <ProfileForm draft={editing} taken={taken} onChange={setEditing} onSave={() => void commitDraft()} onCancel={() => setEditing(null)} />}
      <ul className="tp-list" aria-label="Terminal profiles">
        {list.profiles.map((p) => {
          const isDefault = p.id === list.defaultId
          if (editing && !editing.isNew && editing.id === p.id) {
            return (
              <li key={p.id} data-profile={p.id} className="tp-item tp-item-editing">
                <ProfileForm draft={editing} taken={taken} onChange={setEditing} onSave={() => void commitDraft()} onCancel={() => setEditing(null)} />
              </li>
            )
          }
          return (
            <li key={p.id} data-profile={p.id} className={`tp-item${isDefault ? ' tp-item-default' : ''}`}>
              <div className="tp-main">
                <span className="tp-name">
                  {p.name}
                  {isDefault && <span className="tp-badge tp-badge-default">Default</span>}
                  {p.builtIn && <span className="tp-badge">Built-in</span>}
                </span>
                <Launch profile={p} />
                {p.cwd && <span className="tp-cwd">Opens in {p.cwd}</span>}
              </div>
              <div className="tp-actions">
                {!isDefault && (
                  <button type="button" className="btn" data-tp="default" onClick={() => void save(custom(list), p.id)}>
                    Make default
                  </button>
                )}
                {!p.builtIn && (
                  <button type="button" className="btn" data-tp="edit" onClick={() => setEditing(toDraft(p))}>
                    Edit
                  </button>
                )}
                <button type="button" className="btn" data-tp="duplicate" onClick={() => duplicate(p)}>
                  Duplicate
                </button>
                {!p.builtIn && (
                  <button type="button" className="btn btn-risky btn-destroy" data-tp="delete" onClick={() => askRemove(p)}>
                    Delete…
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
