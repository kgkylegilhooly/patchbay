import { useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { EXTRACTED_NOTE, handoffMarkdown, handoffPrompt, MAX_HANDOFF_CHARS } from '../core/search/handoffText'
import type { Evidence, HandoffDraft, HandoffSection, HandoffSource } from '../core/search/types'
import { AGENT_NAMES, type AgentKind } from '../shared/model'
import { bridge } from './bridge'
import { ClaudeIcon, CodexIcon } from './icons'
import { closeHandoff, closeSearch, searchBridge } from './searchUi'
import { useStore } from './store'
import { useAgentChoice } from './agentChoice'
import './search.css'

const EVIDENCE: Record<Evidence, string> = { found: 'Found', partial: 'Partial', stale: 'Stale', missing: 'Missing' }

/** Enough rows to show a section without scrolling, up to a point. */
const rowsFor = (text: string): number => Math.min(14, Math.max(3, text.split('\n').length + 1))

/**
 * "Continue with another agent": a handoff extracted from a conversation, for the person to edit before it becomes the
 * next agent's first prompt. Nothing in it is written by AI, and the editor says so.
 */
export function HandoffEditor({ source }: { source: HandoffSource & { title: string } }): React.JSX.Element {
  const flow = useReactFlow()
  const [draft, setDraft] = useState<HandoffDraft | null>(null)
  const [sections, setSections] = useState<HandoffSection[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const agents = useAgentChoice()
  const [agent, setAgent] = useState<AgentKind>(agents.enabled.includes('claude') ? 'claude' : agents.default)
  // Settings may be read, or change, after this opens: never leave an agent that's off chosen.
  useEffect(() => {
    if (!agents.enabled.includes(agent)) setAgent(agents.default)
  }, [agents, agent])
  const [title, setTitle] = useState(`Continue: ${source.title}`.slice(0, 80))
  const [cwd, setCwd] = useState('')
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void searchBridge()
      .prepareHandoff(source.type === 'node' ? { type: 'node', nodeId: source.nodeId } : { type: 'closed', closedId: source.closedId })
      .then((r) => {
        if (!live) return
        if (!r.ok) return setProblem(r.reason)
        setDraft(r.draft)
        setSections(r.draft.sections)
        setAgent(r.draft.agent)
        setCwd(r.draft.cwd)
      })
    return () => {
      live = false
    }
  }, [source])

  const prompt = draft ? handoffPrompt(draft, sections, agent) : ''
  const tooLong = prompt.length > MAX_HANDOFF_CHARS
  const edit = (id: string, text: string): void => setSections((all) => all.map((s) => (s.id === id ? { ...s, text } : s)))
  const edited = (s: HandoffSection): boolean => draft?.sections.find((o) => o.id === s.id)?.text !== s.text

  const start = async (): Promise<void> => {
    if (!draft) return
    setStarting(true)
    setProblem(null)
    const besideNodeId = source.type === 'node' ? source.nodeId : undefined
    const r = await searchBridge().startHandoff({ text: prompt, agent, cwd, title, ...(draft.projectId ? { projectId: draft.projectId } : {}), ...(besideNodeId ? { besideNodeId } : {}) })
    setStarting(false)
    if (!r.ok) return setProblem(r.reason)
    closeHandoff()
    closeSearch()
    // The new window may be in another project than the one on screen.
    const doc = useStore.getState().doc
    const projectId = doc?.nodes.find((n) => n.id === r.nodeId)?.projectId ?? draft.projectId
    if (doc && projectId && projectId !== doc.activeProjectId && doc.projects.some((p) => p.id === projectId)) void bridge.dispatch({ op: 'switchProject', id: projectId })
    setTimeout(() => void flow.fitView({ nodes: [{ id: r.nodeId }], padding: 0.2, maxZoom: 1, duration: 260 }), 300)
  }

  const copy = async (): Promise<void> => {
    if (!draft) return
    await bridge.writeClipboard(handoffMarkdown(draft.sourceTitle, sections))
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className="handoff-back"
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeHandoff()
      }}
    >
      <section className="handoff" role="dialog" aria-modal="true" aria-label="Continue with another agent">
        <header className="drawer-head">
          <h2>Continue with another agent</h2>
          <button className="icon-btn" aria-label="Close handoff" onClick={closeHandoff}>
            ×
          </button>
        </header>
        <div className="handoff-body">
          <p className="handoff-from">
            Handoff from <strong>{source.title}</strong>
            {draft && <span className="handoff-from-agent"> · {AGENT_NAMES[draft.agent]}</span>}
          </p>
          <p className="handoff-label" role="note">
            <span className="handoff-label-tag">Extracted</span>
            {EXTRACTED_NOTE} Edit anything before starting.
          </p>
          {!draft && !problem && <p className="drawer-empty">Reading the conversation…</p>}
          {sections.map((s) => (
            <div key={s.id} className="handoff-section">
              <div className="handoff-section-head">
                <label htmlFor={`handoff-${s.id}`}>{s.title}</label>
                <span className={`evidence evidence-${s.evidence}`}>{EVIDENCE[s.evidence]}</span>
                {s.note && <span className="handoff-note">{s.note}</span>}
                {edited(s) && <span className="handoff-edited">edited</span>}
              </div>
              <textarea id={`handoff-${s.id}`} spellCheck={false} rows={rowsFor(s.text)} value={s.text} onChange={(e) => edit(s.id, e.target.value)} />
            </div>
          ))}
        </div>
        {problem && <p className="search-problem">{problem}</p>}
        <footer className="handoff-foot">
          <div className="handoff-start">
            <div className="handoff-agents" role="radiogroup" aria-label="Start with">
              {agents.enabled.map((k) => (
                <button key={k} role="radio" aria-checked={agent === k} className={`search-kind${agent === k ? ' search-kind-on' : ''}`} onClick={() => setAgent(k)}>
                  {k === 'claude' ? <ClaudeIcon /> : <CodexIcon />} {AGENT_NAMES[k]}
                </button>
              ))}
            </div>
            <label className="handoff-field">
              <span className="field-label">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="handoff-field handoff-folder">
              <span className="field-label">Folder</span>
              <span className="handoff-folder-row">
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
                <button className="btn" onClick={() => void bridge.pickFolder().then((f) => f && setCwd(f))}>
                  Choose…
                </button>
              </span>
            </label>
          </div>
          <div className="handoff-actions">
            <span className={`handoff-count${tooLong ? ' handoff-count-over' : ''}`}>
              {prompt.length.toLocaleString()} / {MAX_HANDOFF_CHARS.toLocaleString()} characters
            </span>
            <button className="btn" disabled={!draft} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy as Markdown'}
            </button>
            <button className="btn" onClick={closeHandoff}>
              Cancel
            </button>
            <button className="btn btn-solid" disabled={!draft || starting || tooLong || !title.trim()} onClick={() => void start()}>
              {starting ? 'Starting…' : `Start ${AGENT_NAMES[agent]}`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
