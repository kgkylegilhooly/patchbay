import { useState } from 'react'
import { modelNameOf, START_MODE_LABELS, START_MODES, startModeOf, type StartMode } from '../shared/startMode'
import { closeRestartAs, restartAsPatch, useRestartAs } from './restartAs'
import { Panel } from './shell/Panel'
import { patchNode, restartNode, useStore } from './store'

/** The box for Restart as…: mode and model for one Claude window, then a restart that keeps its conversation. */
export function RestartAsLayer(): React.JSX.Element | null {
  const nodeId = useRestartAs((s) => s.nodeId)
  const node = useStore((s) => (nodeId ? s.doc?.nodes.find((n) => n.id === nodeId) : undefined))
  if (!nodeId || node?.kind !== 'claude') return null
  return <RestartAsBox key={nodeId} id={nodeId} title={node.title} startMode={startModeOf(node.startMode) ?? ''} model={modelNameOf(node.model) ?? ''} resumes={!!node.sessionId} />
}

function RestartAsBox(p: { id: string; title: string; startMode: StartMode | ''; model: string; resumes: boolean }): React.JSX.Element {
  const [mode, setMode] = useState<StartMode | ''>(p.startMode)
  const [model, setModel] = useState(p.model)
  const badModel = model.trim() !== '' && !modelNameOf(model)
  const go = (): void => {
    if (badModel) return
    patchNode(p.id, restartAsPatch(mode, model))
    closeRestartAs()
    void restartNode(p.id)
  }
  return (
    <Panel
      kind="modal"
      title="Restart as"
      label={`Restart ${p.title} as`}
      className="send-later"
      onClose={closeRestartAs}
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={closeRestartAs}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid" data-restart-as="go" disabled={badModel}>
            Restart
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Permission mode</span>
        <select autoFocus aria-label="Permission mode" value={mode} data-restart-as="mode" onChange={(e) => setMode(e.target.value as StartMode | '')}>
          <option value="">As in Settings</option>
          {START_MODES.map((m) => (
            <option key={m} value={m}>
              {START_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <input aria-label="Model" placeholder="As in Settings, or opus, sonnet…" spellCheck={false} value={model} data-restart-as="model" aria-invalid={badModel} onChange={(e) => setModel(e.target.value)} />
      </label>
      {badModel && (
        <p className="field-problem" role="alert">
          One word, as opus, sonnet or a model id.
        </p>
      )}
      <p className="recipe-dim">
        {p.resumes
          ? `${p.title} stops now and starts again this way, picking its conversation back up. A turn under way stops.`
          : `${p.title} starts this way.`}{' '}
        It keeps the choice for later restarts.
      </p>
    </Panel>
  )
}
