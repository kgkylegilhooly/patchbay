import { useEffect, useRef, useState } from 'react'
import { ATTEMPT_KEYS, attemptLabel, startProblem, suggestBranches, type AttemptKey, type AttemptRequest, type Comparison, type SourceInfo, type StartComparison } from '../shared/compare'
import { AGENT_NAMES, type AgentKind } from '../shared/model'
import { compare } from './compareBridge'
import { useAgentChoice } from './agentChoice'
import { useStore } from './store'
import { taskComparisonBrief } from '../shared/taskCompare'
import { Panel } from './shell/Panel'

const SHOWN_FILES = 8

/**
 * "Try another approach": one brief, two attempts, each in its own new worktree from the one commit shown here. Only
 * reads until Start. Uncommitted changes in the source checkout are never copied or dropped without the person's tick.
 */
export function CompareStart({ projectId, source, brief: initialBrief, taskId: initialTask, onStarted, onCancel }: { projectId: string; source: string; brief?: string; taskId?: string; onStarted: (c: Comparison, problem?: string) => void; onCancel: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<SourceInfo | null>(null)
  const [brief, setBrief] = useState(initialBrief ?? '')
  // A P1 task this comparison is for: its attempts, runs and the choice are recorded on it. Accepting stays the person's.
  const [taskId, setTaskId] = useState(initialTask ?? '')
  const projectTasks = useStore((s) => s.doc?.projects.find((p) => p.id === projectId)?.tasks?.tasks)
  const openTasks = (projectTasks ?? []).filter((t) => t.state !== 'cancelled' && t.state !== 'accepted')
  const [attempts, setAttempts] = useState<Record<AttemptKey, AttemptRequest>>({ a: { agent: 'claude', approach: '', branch: '' }, b: { agent: 'codex', approach: '', branch: '' } })
  const [branchEdited, setBranchEdited] = useState(false)
  const [leaveOut, setLeaveOut] = useState(false)
  const [verify, setVerify] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const briefRef = useRef<HTMLTextAreaElement>(null)
  // Settings > Agents: an agent turned off can't be picked, and an attempt left on one blocks Start until changed.
  const agents = useAgentChoice()

  const read = (): void => {
    setInfo(null)
    setLeaveOut(false)
    void compare.inspect(source).then(setInfo)
  }
  useEffect(read, [source])
  useEffect(() => briefRef.current?.focus(), [])

  const suggested = suggestBranches(brief)
  const branchOf = (k: AttemptKey): string => (branchEdited ? attempts[k].branch : suggested[k])
  const set = (k: AttemptKey, patch: Partial<AttemptRequest>): void => setAttempts((s) => ({ ...s, [k]: { ...s[k], ...patch } }))

  const req: StartComparison | null = info?.ok
    ? { projectId, source, brief, base: info.commit, leaveOutUncommitted: leaveOut, attempts: ATTEMPT_KEYS.map((k) => ({ ...attempts[k], branch: branchOf(k) })), verify, ...(taskId ? { taskId } : {}) }
    : null
  const blocked = info ? (req ? startProblem(req, info, agents) : info.ok ? null : info.reason) : 'Reading the checkout…'

  const start = async (): Promise<void> => {
    if (!req || blocked || busy) return
    setBusy(true)
    setProblem(null)
    const r = await compare.start(req)
    setBusy(false)
    if (r.ok) onStarted(r.comparison)
    else if (r.comparison) onStarted(r.comparison, r.reason)
    else setProblem(r.reason)
  }

  const dirty = info?.ok ? info.uncommitted.length + info.uncommittedMore : 0
  // The amber box above already asks about uncommitted changes, so that one reason isn't repeated in red down here.
  const shownBlocked = req && info?.ok && dirty > 0 && !leaveOut ? startProblem({ ...req, leaveOutUncommitted: true }, info, agents) : blocked

  return (
    <Panel
      kind="modal"
      title="Try another approach"
      icon="branch"
      sub="Two attempts at one brief, each with its own worktree, branch and agent, from the same commit."
      className="compare-start"
      bodyClassName="compare-start-body"
      onClose={onCancel}
      busy={busy}
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
      footer={
        <>
          {problem || (shownBlocked && info) ? <p className="field-problem compare-start-problem shell-foot-hint">{problem ?? shownBlocked}</p> : <span className="shell-foot-hint">Ctrl+Enter</span>}
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-solid" disabled={!!blocked || busy}>
            {busy ? 'Starting…' : 'Start both'}
          </button>
        </>
      }
    >
      <section className="compare-base" aria-label="Base">
        <span className="field-label">Base</span>
        {!info && <p className="compare-dim">Reading {source}…</p>}
        {info && !info.ok && <p className="field-problem">{info.reason}</p>}
        {info?.ok && (
          <div className="compare-base-line">
            <code className="compare-sha" title={info.commit}>
              {info.commit.slice(0, 10)}
            </code>
            <span className="compare-subject">{info.subject}</span>
            <span className="compare-dim">
              {info.branch ? `on ${info.branch}` : 'detached HEAD'} · {info.repo}
            </span>
            <button type="button" className="btn btn-sm" onClick={read}>
              Read again
            </button>
          </div>
        )}
        {info?.ok && dirty > 0 && (
          <div className="compare-dirty" role="alert">
            <p>
              This checkout has {dirty} uncommitted change{dirty === 1 ? '' : 's'}. {dirty === 1 ? 'It is' : 'They are'} not part of commit {info.commit.slice(0, 7)}, so neither attempt would
              have {dirty === 1 ? 'it' : 'them'}.
            </p>
            <ul className="compare-files">
              {info.uncommitted.slice(0, SHOWN_FILES).map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
              {dirty > SHOWN_FILES && <li className="compare-dim">and {dirty - SHOWN_FILES} more</li>}
            </ul>
            <label className="compare-check">
              <input type="checkbox" checked={leaveOut} onChange={(e) => setLeaveOut(e.target.checked)} />
              <span>
                Start both from {info.commit.slice(0, 7)} and leave {dirty === 1 ? 'this change out. It stays' : 'these changes out. They stay'} in this checkout, untouched.
              </span>
            </label>
            <p className="compare-dim">To include them, cancel and commit them first.</p>
          </div>
        )}
      </section>

      {(openTasks.length > 0 || taskId) && (
        <label className="field">
          <span className="field-label">For task (optional): its attempts, runs and your choice are recorded on it</span>
          <select
            data-compare-task
            value={taskId}
            onChange={(e) => {
              const id = e.target.value
              setTaskId(id)
              const task = openTasks.find((t) => t.id === id)
              if (task && !brief.trim()) setBrief(taskComparisonBrief(task))
            }}
          >
            <option value="">No task</option>
            {taskId && !openTasks.some((t) => t.id === taskId) && <option value={taskId}>A task that is closed or gone</option>}
            {openTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.brief.length > 70 ? `${t.brief.slice(0, 69)}…` : t.brief}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span className="field-label">Brief, the same for both</span>
        <textarea ref={briefRef} rows={4} value={brief} placeholder="What both attempts should do" onChange={(e) => setBrief(e.target.value)} />
      </label>

      <div className="compare-attempts-form">
        {ATTEMPT_KEYS.map((k) => (
          <fieldset key={k} className="compare-attempt-form" data-attempt={k}>
            <legend>
              <span className="compare-badge">{attemptLabel(k)}</span> Attempt {attemptLabel(k)}
            </legend>
            <div className="compare-agents" role="radiogroup" aria-label={`Agent for attempt ${attemptLabel(k)}`}>
              {(['claude', 'codex'] as AgentKind[]).map((agent) => (
                <label key={agent} className={`compare-agent${attempts[k].agent === agent ? ' compare-agent-on' : ''}`}>
                  <input type="radio" name={`agent-${k}`} checked={attempts[k].agent === agent} disabled={!agents.enabled.includes(agent)} onChange={() => set(k, { agent })} />
                  {AGENT_NAMES[agent]}
                  {!agents.enabled.includes(agent) && ' (off in Settings)'}
                </label>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Approach (optional, added to the brief)</span>
              <input value={attempts[k].approach} placeholder={k === 'a' ? 'e.g. keep the current API' : 'e.g. rewrite it with a state machine'} onChange={(e) => set(k, { approach: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Branch</span>
              <input
                value={branchOf(k)}
                spellCheck={false}
                onChange={(e) => {
                  if (!branchEdited) setAttempts((s) => ({ a: { ...s.a, branch: suggested.a }, b: { ...s.b, branch: suggested.b } }))
                  setBranchEdited(true)
                  set(k, { branch: e.target.value })
                }}
              />
            </label>
          </fieldset>
        ))}
      </div>

      <label className="field">
        <span className="field-label">Verification command (optional, run in each worktree when you ask, with no shell)</span>
        <input value={verify} spellCheck={false} placeholder="npm test" onChange={(e) => setVerify(e.target.value)} />
      </label>
    </Panel>
  )
}
