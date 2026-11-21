import { useState } from 'react'
import { bridge } from './bridge'
import { FormShell } from './shell/FormShell'

const lastPart = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? ''

export function NewProjectForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (fields: { name: string; folder: string }) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')

  return (
    <FormShell
      title="New project"
      icon="project"
      onCancel={onCancel}
      blocked={!name.trim() && !folder}
      submitLabel="Create project"
      onSubmit={() => {
        const chosen = name.trim() || lastPart(folder)
        if (chosen) onCreate({ name: chosen, folder })
      }}
    >
      <div className="field">
        <span className="field-label">Folder</span>
        <div className="folder-row">
          <span className={folder ? 'folder' : 'folder folder-empty'} title={folder}>
            {folder || 'Where new sessions start'}
          </span>
          <button type="button" className="btn" onClick={() => void bridge.pickFolder().then((f) => f && setFolder(f))}>
            Choose folder
          </button>
        </div>
      </div>
      <label className="field">
        <span className="field-label">Name</span>
        <input name="projectName" autoFocus placeholder={lastPart(folder) || 'For example, Patchbay'} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
    </FormShell>
  )
}
