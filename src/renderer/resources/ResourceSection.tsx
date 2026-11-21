import { useEffect, useState } from 'react'
import { AGENT_LIMIT } from '../../core/resources/agentLimit'
import type { ResourceReading } from '../../shared/resources'
import type { SyncReport } from '../../shared/sessionSync'
import { HostSection } from '../HostSection'
import '../sessionSync'
import { NOTES, OrphanActions } from '../sessionSyncUi'
import { useStore } from '../store'
import { PARKING, setParkingEnabled, useParkingEnabled } from '../terminalParking'
import { appBreakdown, cpuText, readAgo, resourcesBridge, scrollbackEstimate, sessionLines, shownLine, sizeText, syncSummary, usedShare } from './resourcesUi'
import './resources.css'

function Meter({ share, label }: { share: number; label: string }): React.JSX.Element {
  const level = share >= 0.9 ? 'high' : share >= 0.75 ? 'warn' : 'ok'
  return (
    <span className="res-meter" data-level={level} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
      <span className="res-meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  )
}

/**
 * Settings > Background sessions below its two switches: the PC's memory; one table of every session the host runs,
 * matched against the canvas (session-sync's check) and with what each uses (the resource reading); the host itself;
 * then Patchbay's own memory and the two limits. One Check now runs both. The two keep their own timers: the check every
 * minute or so, readings every half minute while this shows. See src/main/resources and docs/plans/session-sync.md.
 * `onAgentLimit` is absent until the settings file has been read, since saving before then would lose its other fields.
 */
export function ResourceSection({ agentLimit, onAgentLimit }: { agentLimit: string; onAgentLimit?: (value: string) => void }): React.JSX.Element {
  const [reading, setReading] = useState<ResourceReading | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
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

  useEffect(() => {
    const sync = window.patchbaySync
    if (!sync) return
    let live = true
    void sync.report().then((r) => live && r && setReport(r))
    const off = sync.onReport(setReport)
    return () => {
      live = false
      off()
    }
  }, [])

  const check = (): void => {
    setBusy(true)
    void Promise.all([
      window.patchbaySync?.check().then(setReport, () => {}),
      resourcesBridge()
        ?.get(true)
        .then((r) => r && setReading(r), () => {})
    ]).finally(() => {
      setBusy(false)
      setNow(Date.now())
    })
  }

  const sys = reading?.system
  const lines = sessionLines(report, reading)
  const projectName = (id: string | null): string => (id ? (projects?.find((p) => p.id === id)?.name ?? '') : '')
  const hostMemory = reading?.host?.memory

  return (
    <>
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

        <div className="set-row set-row-wide res-sessions">
          <div className="res-head">
            <div className="set-text">
              <span className="set-title">Sessions</span>
              <p className="set-help">
                What the host runs, against what the canvas shows, and what each uses with every program it started, such as tests, servers and tools. Checked every minute or so; one the canvas shows
                as ended but the host still runs is shown again, and one with no node is never ended without asking. <span data-sync-summary>{syncSummary(report)}</span>{' '}
                {reading ? readAgo(reading.processesAt, now) : ''}
              </p>
            </div>
            <button type="button" className="btn" onClick={check} disabled={busy} data-sync-action="check" data-cmd="resources-refresh">
              {busy ? 'Checking…' : 'Check now'}
            </button>
          </div>
          {reading?.processesProblem && (
            <p className="field-problem" role="alert">
              {reading.processesProblem}
            </p>
          )}
          {lines.length > 0 ? (
            <div className="res-table-wrap">
              <table className="res-table" data-sync-table>
                <thead>
                  <tr>
                    <th scope="col">Node</th>
                    <th scope="col">Process</th>
                    <th scope="col" className="res-num">
                      CPU
                    </th>
                    <th scope="col" className="res-num">
                      Memory
                    </th>
                    <th scope="col">Canvas shows</th>
                    <th scope="col" aria-label="Notes" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} data-session={line.id} data-sync-row={line.sync ? (line.sync.problem ?? 'ok') : undefined}>
                      <td>
                        {line.title !== null ? (
                          <>
                            <span className="res-title">{line.title || 'Untitled'}</span>
                            {projectName(line.projectId) && <span className="res-project">{projectName(line.projectId)}</span>}
                          </>
                        ) : (
                          <span className="sync-none">No node · {line.id.slice(0, 8)}</span>
                        )}
                      </td>
                      <td className="res-state">{line.running ? (line.pid ?? 'starting') : 'ended'}</td>
                      <td className="res-num">{line.use ? cpuText(line.use.cpu) : ''}</td>
                      <td className="res-num" title={line.use?.processes ? `${line.use.processes} process${line.use.processes === 1 ? '' : 'es'}` : undefined}>
                        {line.use ? sizeText(line.use.memory) : ''}
                      </td>
                      <td className="res-state">{shownLine(line, now)}</td>
                      <td>
                        {line.sync?.problem === 'orphan' ? (
                          <>
                            <span className="sync-note">{NOTES.orphan}</span> <OrphanActions id={line.id} onDone={check} />
                          </>
                        ) : (
                          line.sync?.problem && <span className="sync-note">{NOTES[line.sync.problem]}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="set-help">{reading || report ? 'No sessions are running.' : ' '}</p>
          )}
        </div>
      </div>

      <HostSection memory={hostMemory ? sizeText(hostMemory) : undefined} />

      <div className="set-group res">
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
    </>
  )
}
