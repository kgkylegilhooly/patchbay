import { useState } from 'react'
import { bridge } from './bridge'
import { sendSummary, type SendResult } from './noteSend'
import { say } from './reader/readerUi'
import { closeSendToAgents, useSendToAgents } from './sendToAgents'
import { RecentPromptsButton } from './RecentPromptsButton'
import { rememberPrompt } from './recentPrompts'
import { Panel } from './shell/Panel'
import { useStore } from './store'

/** The box for one message to several agents. See sendToAgents.ts. */
export function SendToAgentsLayer(): React.JSX.Element | null {
  const ids = useSendToAgents((s) => s.ids)
  if (!ids) return null
  return <SendToAgents ids={ids} />
}

function SendToAgents({ ids }: { ids: string[] }): React.JSX.Element {
  // Agents closed while the box is open drop out of it.
  const nodes = useStore((s) => s.doc?.nodes)
  const agents = (nodes ?? []).filter((n) => n.kind === 'claude' && ids.includes(n.id))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (): Promise<void> => {
    if (busy || !text.trim() || !agents.length) return
    setBusy(true)
    rememberPrompt(text)
    const results: Array<{ title: string; result: SendResult }> = []
    for (const a of agents) {
      const result = await bridge.sendToAgent(a.id, text.trim()).catch((e: unknown): SendResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
      results.push({ title: a.title, result })
    }
    closeSendToAgents()
    say(sendSummary(results), results.every((r) => r.result.ok))
  }
  const label = `Send to ${agents.length} agent${agents.length === 1 ? '' : 's'}`
  return (
    <Panel
      kind="modal"
      title={label}
      label={label}
      className="send-to-agents"
      onClose={closeSendToAgents}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={closeSendToAgents}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid" data-send-many="send" disabled={busy || !text.trim() || !agents.length}>
            Send
          </button>
        </>
      }
    >
      <p className="recipe-dim" data-send-many="to">
        To {agents.map((a) => a.title).join(', ')}. A busy agent gets it once it's idle.
      </p>
      <label className="field">
        <span className="field-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Message
          <RecentPromptsButton onPick={setText} text={text} />
        </span>
        <textarea
          autoFocus
          rows={5}
          value={text}
          placeholder="Stop and commit what you have."
          data-send-many="text"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter makes a new line, as in a prompt; Ctrl+Enter sends.
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
      </label>
    </Panel>
  )
}
