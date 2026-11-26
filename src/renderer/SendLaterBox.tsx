import { useState } from 'react'
import { closeSendLater, nextAtFor, useSendLater } from './sendLater'
import { say } from './reader/readerUi'
import { Panel } from './shell/Panel'
import { useStore } from './store'

/** The box for Send later: what to send to one agent, and when. See sendLater.ts. */
export function SendLaterLayer(): React.JSX.Element | null {
  const nodeId = useSendLater((s) => s.nodeId)
  const title = useStore((s) => (nodeId ? s.doc?.nodes.find((n) => n.id === nodeId)?.title : undefined))
  if (!nodeId) return null
  return <SendLaterBox key={nodeId} title={title ?? 'this agent'} />
}

const inAnHour = (): string => {
  const d = new Date(Date.now() + 60 * 60_000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function SendLaterBox({ title }: { title: string }): React.JSX.Element {
  const schedule = useSendLater((s) => s.schedule)
  const [text, setText] = useState('')
  const [time, setTime] = useState(inAnHour)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const at = nextAtFor(time, Date.now())
  const send = async (): Promise<void> => {
    if (!schedule || busy || !text.trim() || at === null) return
    setBusy(true)
    const r = await schedule(text, at)
    setBusy(false)
    if (!r.ok) return setProblem(r.reason)
    closeSendLater()
    say(`It will go to ${title} at ${time}${new Date(at).getDate() !== new Date().getDate() ? ' tomorrow' : ''}. Delete its trigger on the canvas to cancel.`, true)
  }
  return (
    <Panel
      kind="modal"
      title="Send later"
      label={`Send later to ${title}`}
      className="send-later"
      onClose={closeSendLater}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={closeSendLater}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid" data-send-later="schedule" disabled={busy || !text.trim() || at === null}>
            Send at {time}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Message to {title}</span>
        <textarea autoFocus rows={4} value={text} placeholder="Check the deploy and tell me if anything failed." data-send-later="text" onChange={(e) => (setText(e.target.value), setProblem(null))} />
      </label>
      <label className="field">
        <span className="field-label">At</span>
        <input type="time" value={time} data-send-later="time" onChange={(e) => (setTime(e.target.value), setProblem(null))} />
      </label>
      <p className="recipe-dim">
        It goes once, as a trigger beside {title} that you can see and delete. If {title} isn't running then, nothing is sent. A time that has passed today means tomorrow.
      </p>
      {problem && (
        <p className="field-problem" role="alert">
          {problem}
        </p>
      )}
    </Panel>
  )
}
