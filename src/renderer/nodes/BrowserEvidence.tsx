import { useEffect, useState } from 'react'
import type { BrowserAttempt, EvidenceCapture } from '../../shared/browserEvidence'
import type { TaskRevision } from '../../shared/task'
import { bridge } from '../bridge'
import { useStore } from '../store'
import './browserEvidence.css'

const revisionText = (r: TaskRevision | null | undefined): string => {
  if (!r) return 'unavailable'
  if (r.noRepo) return 'not a git repository'
  if (!r.revision) return `unavailable${r.reason ? ` (${r.reason})` : ''}`
  return `${r.revision.slice(0, 12)} · ${r.uncommitted === null ? 'uncommitted changes unknown' : r.uncommitted ? 'uncommitted changes' : 'clean'}`
}

function EvidencePicture({ attempt, capture, index }: { attempt: BrowserAttempt; capture: EvidenceCapture; index: number }): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    void bridge.browserEvidenceImage(attempt.nodeId, attempt.id, index).then((value) => {
      if (!alive) return
      setImage(value)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [attempt.nodeId, attempt.id, index, capture.state])
  return (
    <figure>
      <figcaption>
        {new Date(capture.at).toLocaleTimeString()} · {capture.viewport.preset ?? 'node size'} {capture.viewport.width} × {capture.viewport.height}
        {capture.masked && <span className="evidence-masked"> · fields and frames hidden</span>}
      </figcaption>
      {image ? (
        <a href={image} download={`browser-${attempt.id}-${index}.png`}>
          <img src={image} alt={`Observed page at ${new Date(capture.at).toISOString()}`} />
        </a>
      ) : (
        <p className="evidence-gap">{loaded ? capture.reason ?? 'Screenshot unavailable or expired.' : 'Loading screenshot…'}</p>
      )}
    </figure>
  )
}

function Attempt({ a }: { a: BrowserAttempt }): React.JSX.Element {
  return (
    <>
      <p>
        <strong>Observed</strong> · {a.viewport.preset ?? 'node size'} {a.viewport.width} × {a.viewport.height}
        <br />
        {a.url}
      </p>
      <p className="evidence-id">
        Attempt {a.id}
        {a.taskId && ` · Task ${a.taskId}`}
      </p>
      <p>
        Started by {a.startedBy ? `${a.startedBy.title}` : 'an agent'}
        {a.finishedBy && a.finishedBy.id !== a.startedBy?.id ? `, finished by ${a.finishedBy.title}` : ''}.
      </p>
      <p>Checkout revision: {revisionText(a.revision)}. What the page's server runs is unknown.</p>
      <p>
        <strong>Agent assertion:</strong> {a.state === 'recording' ? 'not made yet' : a.assertion}
        {a.finishedBy ? ` (by ${a.finishedBy.title})` : ''}. No human acceptance recorded here.
      </p>
      {a.gaps.map((g) => (
        <p className="evidence-gap" key={g}>
          {g}
        </p>
      ))}
      <div className="evidence-pictures">
        {a.captures.map((c, i) => (
          <EvidencePicture key={i} attempt={a} capture={c} index={i} />
        ))}
      </div>
      <details>
        <summary>Observed actions ({a.actions.length})</summary>
        <ol>
          {a.actions.map((s, i) => (
            <li key={i}>
              {new Date(s.at).toLocaleTimeString()} · {s.action} · {s.state}
              {s.by && ` · by ${s.by}`}
              <br />
              <small>
                {s.url} · page {s.pageId}
              </small>
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>Observed diagnostics ({a.diagnostics.length})</summary>
        <p>Since recording began. Console text, request headers and bodies are omitted for privacy. Empty logs are not proof of success.</p>
        {a.diagnostics.map((d, i) => (
          <p key={i}>
            {new Date(d.at).toLocaleTimeString()} · {d.kind} · {d.message} {d.status ?? d.failure ?? ''}
            <br />
            {d.method} {d.url}
            <br />
            <small>
              Page {d.pageId} · {d.pageUrl} · attempt {d.attemptId}
            </small>
          </p>
        ))}
      </details>
    </>
  )
}

/** A browser node's recorded checks. Only a count travels with the node; the checks are fetched while this is open. */
export function BrowserEvidence({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const summary = useStore((s) => s.browsers[nodeId]?.evidence)
  const [expanded, setExpanded] = useState(false)
  const [attempts, setAttempts] = useState<BrowserAttempt[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const version = summary?.version ?? 0
  useEffect(() => {
    if (!expanded) return
    let alive = true
    void bridge.browserEvidence(nodeId).then((list) => {
      if (alive) setAttempts(list)
    })
    return () => {
      alive = false
    }
  }, [expanded, nodeId, version])
  const count = summary?.count ?? 0
  const open = selected ?? attempts?.[0]?.id
  // A page nothing has checked yet has nothing to show here, unless a capture is starting or something went wrong.
  if (count === 0 && !summary?.recording && !summary?.problem) return null
  return (
    <details
      className="browser-evidence nodrag nopan nowheel"
      data-browser-evidence
      onToggle={(e) => {
        if (e.target === e.currentTarget) setExpanded(e.currentTarget.open)
      }}
    >
      <summary>
        Checks ({count})
        {summary?.recording && ' · recording'}
      </summary>
      {expanded && (
        <div className="browser-evidence-content">
          <p>Observed captures and actions are partial evidence. They do not prove the entire feature works.</p>
          {summary?.problem && <p className="evidence-gap">{summary.problem}</p>}
          {attempts === null && <p>Loading…</p>}
          {attempts?.length === 0 && <p>No recorded verification. Agents can use browser verify to record a check.</p>}
          {attempts?.map((a) => (
            <details
              key={a.id}
              className="browser-attempt"
              open={open === a.id}
              onToggle={(e) => {
                if (e.target === e.currentTarget && e.currentTarget.open) setSelected(a.id)
              }}
            >
              <summary>
                {a.state === 'recording' ? 'Recording' : a.state === 'incomplete' ? 'Incomplete capture' : 'Recorded capture'} · {new Date(a.startedAt).toLocaleString()}
              </summary>
              {open === a.id && <Attempt a={a} />}
            </details>
          ))}
        </div>
      )}
    </details>
  )
}
