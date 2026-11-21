import { useEffect, useState } from 'react'
import { AGENT_LIMIT } from '../../core/resources/agentLimit'
import type { ResourceReading } from '../../shared/resources'
import { useStore } from '../store'
import { PARKING, setParkingEnabled, useParkingEnabled } from '../terminalParking'
import { appBreakdown, cpuText, idleText, readAgo, resourcesBridge, scrollbackEstimate, sizeText, usedShare } from './resourcesUi'
import './resources.css'

const STATUS_WORDS: Record<string, string> = { working: 'working', 'needs-you': 'needs you', starting: 'starting', queued: 'queued', exited: 'ended', unknown: 'running' }

function Meter({ share, label }: { share: number; label: string }): React.JSX.Element {
  const level = share >= 0.9 ? 'high' : share >= 0.75 ? 'warn' : 'ok'
  return (
    <span className="res-meter" data-level={level} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
      <span className="res-meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  )
}

/**
 * Settings > Background sessions: what Patchbay, its session host and each session's programs use, the PC's memory,
 * and the two limits. Readings refresh every half minute while this shows. See src/main/resources. `onAgentLimit` is
 * absent until the settings file has been read, since saving before then would lose its other fields.
 */
export function ResourceSection({ agentLimit, onAgentLimit }: { agentLimit: string; onAgentLimit?: (value: string) => void }): React.JSX.Element {
  const [reading, setReading] = useState<ResourceReading | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const parking = useParkingEnabled()
  const scrollback = useStore((s) => s.terminalLook.scrollback)
  const projects = useStore((s) => s.doc?.projects)

  useEffect(() => {
    const bridge = resourcesBridge()
    if (!bridge) return
    let live = true
    void bridge.get(true).then((r) => live && r && setReading(r))
    void bridge.watch(true)
    const off = bridge.onReading((r) => {
      setReading(r)
      setNow(Date.now())
    })
    const clock = setInterval(() => setNow(Date.now()), 10_000)
    return () => {
      live = false
      off()
      clearInterval(clock)
      void bridge.watch(false)
    }
  }, [])

  const refresh = (): void => {
    setBusy(true)
    void resourcesBridge()
      ?.get(true)
      .then((r) => r && setReading(r))
      .finally(() => {
        setBusy(false)
        setNow(Date.now())
      })
  }

  const sys = reading?.system
  const projectName = (id: string | null): string => (id ? (projects?.find((p) => p.id === id)?.name ?? '') : '')

  return (
    <div className="set-group res" data-resources>
      <div className="set-row">
        <div className="set-text">
          <span className="set-title">This PC</span>
          <p className="set-help">Memory in use, and the memory Windows has promised to programs. When promises reach the limit, new programs and commands fail to start.</p>
        </div>
        <div className="set-control res-system">
          {sys ? (
            <>
              <span className="res-line">
                <span>Memory</span>
                <Meter share={usedShare(sys.totalPhys, sys.availPhys)} label="Memory in use" />
                <span className="res-num">
                  {sizeText(sys.totalPhys - sys.availPhys)} of {sizeText(sys.totalPhys)}
                </span>
              </span>
              {sys.commitLimit > 0 && (
                <span className="res-line">
                  <span>Promised</span>
                  <Meter share={usedShare(sys.commitLimit, sys.commitAvail)} label="Memory promised to programs" />
                  <span className="res-num">
                    {sizeText(sys.commitLimit - sys.commitAvail)} of {sizeText(sys.commitLimit)}
                  </span>
                </span>
              )}
            </>
          ) : (
            <span className="set-value">…</span>
          )}
        </div>
      </div>

      <div className="set-row">
        <div className="set-text">
          <span className="set-title">Patchbay</span>
          <p className="set-help">{reading ? appBreakdown(reading.app) : ' '}</p>
        </div>
        <div className="set-control">
          <span className="set-value res-num" data-res-app>
            {reading ? sizeText(reading.app.total) : '…'}
          </span>
        </div>
      </div>

      {reading?.host && (
        <div className="set-row">
          <div className="set-text">
            <span className="set-title">Session host</span>
            <p className="set-help">Its own process. Each session's programs are counted below.</p>
          </div>
          <div className="set-control">
            <span className="set-value res-num">{sizeText(reading.host.memory)}</span>
          </div>
        </div>
      )}

      <div className="set-row set-row-wide res-sessions">
        <div className="res-head">
          <div className="set-text">
            <span className="set-title">Running sessions</span>
            <p className="set-help">Each with every program it started, such as tests, servers and tools. {reading ? readAgo(reading.processesAt, now) : ''}</p>
          </div>
          <button type="button" className="btn" onClick={refresh} disabled={busy} data-cmd="resources-refresh">
            {busy ? 'Reading…' : 'Refresh'}
          </button>
        </div>
        {reading?.processesProblem && (
          <p className="field-problem" role="alert">
            {reading.processesProblem}
          </p>
        )}
        {reading && reading.sessions.length > 0 ? (
          <div className="res-table-wrap">
            <table className="res-table">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">State</th>
                  <th scope="col" className="res-num">
                    CPU
                  </th>
                  <th scope="col" className="res-num">
                    Memory
                  </th>
                </tr>
              </thead>
              <tbody>
                {reading.sessions.map((s) => (
                  <tr key={s.id} data-session={s.id}>
                    <td>
                      <span className="res-title">{s.title || 'Untitled'}</span>
                      {projectName(s.projectId) && <span className="res-project">{projectName(s.projectId)}</span>}
                    </td>
                    <td className="res-state">{s.idleSince !== null ? idleText(s.idleSince, now) : (STATUS_WORDS[s.status] ?? s.status)}</td>
                    <td className="res-num">{cpuText(s.cpu)}</td>
                    <td className="res-num" title={s.processes ? `${s.processes} process${s.processes === 1 ? '' : 'es'}` : undefined}>
                      {sizeText(s.memory)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="set-help">{reading ? 'No sessions are running.' : ' '}</p>
        )}
      </div>

      <div className="set-row">
        <div className="set-text">
          <label className="set-title" htmlFor="set-agent-limit">
            Most agents at once
          </label>
          <p className="set-help">
            An agent past this doesn't start, and says why in its window. Running agents are never stopped. Blank for no limit.
            {reading ? ` ${reading.agents.running} running now.` : ''}
          </p>
        </div>
        <div className="set-control">
          <input
            id="set-agent-limit"
            className="res-limit"
            type="number"
            inputMode="numeric"
            min={AGENT_LIMIT.min}
            max={AGENT_LIMIT.max}
            placeholder="No limit"
            value={agentLimit}
            disabled={!onAgentLimit}
            onChange={(e) => onAgentLimit?.(e.target.value.replace(/[^\d]/g, ''))}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="set-text">
          <label className="set-title" htmlFor="set-unload-offscreen">
            Unload windows far off-screen
          </label>
          <p className="set-help">
            A terminal or agent window more than a screen away for {PARKING.afterMs / 60_000} minutes lets go of what it has drawn, up to about {sizeText(scrollbackEstimate(scrollback))} at your
            scrollback, and draws it again from its session when you come back. The session keeps running.
          </p>
        </div>
        <div className="set-control">
          <button type="button" id="set-unload-offscreen" role="switch" aria-checked={parking} className={`switch${parking ? ' switch-on' : ''}`} onClick={() => setParkingEnabled(!parking)}>
            <span className="switch-knob" />
          </button>
        </div>
      </div>
    </div>
  )
}
