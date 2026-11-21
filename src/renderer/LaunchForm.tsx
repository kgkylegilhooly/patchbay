import { useEffect, useRef, useState } from 'react'
import type { LaunchListing } from '../shared/contract'
import type { LaunchItem } from '../shared/launch'
import { bridge } from './bridge'
import { FormShell } from './shell/FormShell'

export type LaunchChoice = { folder: string; item: LaunchItem }

/**
 * Picks a configuration or compound from .vscode/launch.json. Choosing a folder only reads the file. Nothing runs
 * until Run is clicked, and anything that can't run as written is shown with the reason and can't be picked.
 */
export function LaunchForm({ initialFolder, onCancel, onRun }: { initialFolder: string; onCancel: () => void; onRun: (choice: LaunchChoice) => void }): React.JSX.Element {
  const [folder, setFolder] = useState(initialFolder)
  const [listing, setListing] = useState<LaunchListing | { ok: false; reason: string } | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const chooseRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => chooseRef.current?.focus(), [])
  // Once the folder is read, the next thing to do is pick a configuration, so focus goes to the first that can run.
  useEffect(() => {
    if (listing?.ok) listRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus()
  }, [listing])
  useEffect(() => {
    setListing(null)
    setChosen(null)
    if (folder) void bridge.readLaunchConfigs(folder).then(setListing)
  }, [folder])

  const items: LaunchListing['items'] = listing?.ok ? listing.items : []
  const key = (i: LaunchItem) => `${i.kind}:${i.name}`
  const picked = items.find((i) => key(i) === chosen && !i.problem)

  return (
    <FormShell
      title="New run configuration"
      icon="launch"
      className="pop-terminal pop-launch"
      onCancel={onCancel}
      blocked={!picked}
      submitLabel="Start run"
      onSubmit={() => picked && onRun({ folder, item: picked })}
    >
      <div className="field">
        <span className="field-label">Folder with .vscode\launch.json</span>
        <div className="folder-row">
          <span className={folder ? 'folder' : 'folder folder-empty'} title={folder}>
            {folder || 'Choose a folder'}
          </span>
          <button ref={chooseRef} type="button" className="btn" onClick={() => void bridge.pickFolder().then((f) => f && setFolder(f))}>
            Choose folder
          </button>
        </div>
      </div>
      {listing && !listing.ok && <p className="field-problem">{listing.reason}</p>}
      {listing?.ok && items.length === 0 && <p className="field-problem">launch.json has no configurations.</p>}
      {items.length > 0 && (
        <ul ref={listRef} className="launch-list" role="listbox" aria-label="Configurations">
          {items.map((i) => (
            <li key={key(i)}>
              <label className={`launch-item${i.problem ? ' launch-item-off' : ''}`} data-launch={i.name} data-runnable={i.problem ? 'no' : 'yes'}>
                <input type="radio" name="launch" disabled={!!i.problem} checked={chosen === key(i)} onChange={() => setChosen(key(i))} />
                <span className="launch-name">
                  {i.name}
                  {i.kind === 'compound' && <span className="launch-kind"> compound: {i.members.join(', ')}</span>}
                </span>
                {i.problem ? (
                  <span className="launch-why">{i.problem}</span>
                ) : (
                  i.command && <code className="launch-command">{i.command}</code>
                )}
                {!i.problem && i.notes.length > 0 && <span className="launch-note">Left to the debugger: {i.notes.join(', ')}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </FormShell>
  )
}
