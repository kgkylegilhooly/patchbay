import { useState } from 'react'
import { closeOutputWatch, followOutputWatches, useOutputWatch } from './outputWatchUi'
import { say } from './reader/readerUi'
import { Panel } from './shell/Panel'
import { useStore } from './store'

followOutputWatches()

/** The box for Notify when it prints…: the text to wait for in one window's output. */
export function NotifyWhenLayer(): React.JSX.Element | null {
  const nodeId = useOutputWatch((s) => s.asking)
  const title = useStore((s) => (nodeId ? s.doc?.nodes.find((n) => n.id === nodeId)?.title : undefined))
  if (!nodeId) return null
  return <NotifyWhenBox key={nodeId} nodeId={nodeId} title={title ?? 'this window'} />
}

function NotifyWhenBox({ nodeId, title }: { nodeId: string; title: string }): React.JSX.Element {
  const [text, setText] = useState(() => useOutputWatch.getState().watches[nodeId] ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    const r = await window.patchbayOutputWatch?.watch(nodeId, text)
    if (!r) return
    if (!r.ok) return setProblem(r.reason)
    closeOutputWatch()
    say(`You'll be notified when ${title} prints "${r.phrase}".`, true)
  }
  return (
    <Panel
      kind="modal"
      title="Notify when it prints"
      label={`Notify when ${title} prints`}
      className="notify-when"
      onClose={closeOutputWatch}
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={closeOutputWatch}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid" data-notify-when="start" disabled={!text.trim()}>
            Notify me
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Text {title} will print</span>
        <input autoFocus value={text} placeholder="Compiled successfully" spellCheck={false} data-notify-when="text" onChange={(e) => (setText(e.target.value), setProblem(null))} />
      </label>
      <p className="recipe-dim">Plain text, any case. You're told once, the first time it appears in new output, then it's forgotten.</p>
      {problem && (
        <p className="field-problem" role="alert">
          {problem}
        </p>
      )}
    </Panel>
  )
}
