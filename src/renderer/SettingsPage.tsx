import { useEffect, useRef, useState } from 'react'
import { needsTerminal, type Settings } from '../shared/settings'
import { bridge } from './bridge'
import { playChime } from './chime'
import { HostSection } from './HostSection'
import { ClaudeIcon, TerminalIcon } from './icons'
import type { Overrides } from './keys'
import type { UpdateState } from '../shared/contract'
import { cleanTerminalLook, FONT_SIZE, SCROLLBACK, type Prefs, type TerminalLook, type TogglePref } from './prefs'
import { ShortcutSettings } from './ShortcutSettings'
import { TerminalProfilesSection } from './TerminalProfilesSection'
import type { UsageMode } from './usageView'
import { AGENT_KINDS, agentChoice, defaultAgentNote, withAgent } from '../shared/agents'
import { AGENT_NAMES, type AgentKind } from '../shared/model'
import { noteAgentSettings } from './agentChoice'
import './agents.css'

/** Suggestions only. Any installed font can be typed. */
const MONO_FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono', 'Hack', 'Iosevka', 'Courier New']

const SAVE_DELAY_MS = 400

const SECTIONS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'claude', label: 'Agents' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'keys', label: 'Keyboard shortcuts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sessions', label: 'Background sessions' },
  { id: 'about', label: 'About' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const PERMISSION_MODES: Array<[string, string]> = [
  ['', "Claude's own default"],
  ['acceptEdits', 'Accept file edits automatically'],
  ['plan', 'Plan before changing anything'],
  ['bypassPermissions', 'Skip all permission prompts']
]

const CODEX_APPROVALS: Array<[string, string]> = [
  ['', "Codex's own default (asks)"],
  ['never', 'Never ask, keep the sandbox'],
  ['bypass', 'Skip all approvals and the sandbox']
]

const TEST_RESULT = {
  shown: "Windows accepted it. If you didn't see it, check Do Not Disturb, and Patchbay under System > Notifications in Windows Settings.",
  failed: 'Windows refused it. Check Patchbay under System > Notifications in Windows Settings.',
  unsupported: "This copy of Windows doesn't support notifications."
}

const TERMINALS = ['C:\\Program Files\\Git\\bin\\bash.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe']

function SectionIcon({ id }: { id: SectionId }): React.JSX.Element {
  if (id === 'claude') return <ClaudeIcon size={16} />
  if (id === 'terminals') return <TerminalIcon size={16} />
  const paths: Partial<Record<SectionId, string>> = {
    canvas: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    keys: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14.5h8',
    notifications: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
    sessions: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5v.01M8 16.5v.01',
    about: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.01'
  }
  const path = paths[id]
  return (
    <svg className="kind-icon kind-icon-terminal" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

function Row({ title, help, htmlFor, wide, children }: { title: string; help?: React.ReactNode; htmlFor?: string; wide?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`set-row${wide ? ' set-row-wide' : ''}`}>
      <div className="set-text">
        <label className="set-title" htmlFor={htmlFor}>
          {title}
        </label>
        {help && <p className="set-help">{help}</p>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Toggle({ id, checked, onChange, disabled }: { id: string; checked: boolean; onChange: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button type="button" id={id} role="switch" aria-checked={checked} disabled={disabled} className={`switch${checked ? ' switch-on' : ''}`} onClick={onChange}>
      <span className="switch-knob" />
    </button>
  )
}

function ProgramInput({ name, value, placeholder, list, onChange }: { name: keyof Settings; value: string; placeholder: string; list?: string; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <div className="set-input-row">
      <input id={name} name={name} list={list} placeholder={placeholder} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="btn" onClick={() => void bridge.pickProgram().then((path) => path && onChange(path))}>
        Browse
      </button>
    </div>
  )
}

/** What the two launch fields add up to, in the order they run. */
function launchSummary(terminal: string, command: string): string {
  const run = command.trim() || 'claude'
  const line = run.includes('{args}') ? run.replace(/\{args\}/g, '<Patchbay options>') : `${run} <Patchbay options>`
  return terminal.trim() ? `${terminal.trim()}, running: ${line}` : line
}

export function SettingsPage({
  prefs,
  onToggle,
  onFontSize,
  onUsageMode,
  onKeys,
  onPrefs,
  onClose
}: {
  prefs: Prefs
  onToggle: (key: TogglePref) => void
  onFontSize: (size: number) => void
  onUsageMode: (mode: UsageMode) => void
  onKeys: (keys: Overrides) => void
  onPrefs: (patch: Partial<Prefs>) => void
  onClose: () => void
}): React.JSX.Element | null {
  const setLook = (patch: Partial<TerminalLook>): void => onPrefs({ terminal: { ...prefs.terminal, ...patch } })
  const [section, setSection] = useState<SectionId>('canvas')
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null)
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const latest = useRef<Settings | null>(null)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const close = useRef(onClose)
  close.current = onClose

  const commit = (): void => {
    const next = latest.current
    clearTimeout(timer.current)
    if (!dirty.current || !next) return
    // Held back until it's valid. Whatever was last saved stays in use.
    if (!next.claudeTerminal?.trim() && needsTerminal(next.claudeCommand ?? '')) return
    dirty.current = false
    void bridge.saveSettings(next).then((result) => {
      setSaved(result.ok ? { ok: true, text: 'Saved' } : { ok: false, text: result.reason })
      if (result.ok) noteAgentSettings(next)
    })
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => {
    void bridge.getSettings().then((settings) => {
      latest.current = settings
      setDraft(settings)
    })
    void bridge.getAppInfo().then(setInfo)
    // A menu never takes focus, so a terminal behind this page would otherwise still get what's typed.
    rootRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest?.('.project-rename')) return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      commitRef.current()
    }
  }, [])

  const set = (key: keyof Settings, value: string): void => {
    const next = { ...latest.current, [key]: value }
    latest.current = next
    dirty.current = true
    setDraft(next)
    setSaved(null)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => commitRef.current(), SAVE_DELAY_MS)
  }

  const [testResult, setTestResult] = useState<string | null>(null)
  const sendTest = (): void => {
    setTestResult(null)
    void bridge.testNotification().then((result) => setTestResult(TEST_RESULT[result]))
  }

  const terminal = draft?.claudeTerminal ?? ''
  const command = draft?.claudeCommand ?? ''
  const noShell = !terminal.trim() && needsTerminal(command)
  const mode = draft?.permissionMode ?? ''
  const agents = agentChoice(draft ?? {})
  const fallback = draft ? defaultAgentNote(draft) : null
  /** At least one agent stays on: withAgent refuses the last one, and its switch is disabled. */
  const setAgentOn = (kind: AgentKind, on: boolean): void => {
    const next = withAgent(latest.current ?? {}, kind, on)
    if (next) set('agentsOff', next.agentsOff ?? '')
  }
  const modes = PERMISSION_MODES.some(([value]) => value === mode) ? PERMISSION_MODES : [...PERMISSION_MODES, [mode, mode] as [string, string]]

  return (
    <div className="settings" ref={rootRef} tabIndex={-1} role="dialog" aria-label="Settings">
      <nav className="set-nav" aria-label="Settings sections">
        <h2>Settings</h2>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" data-section={s.id} aria-current={section === s.id ? 'page' : undefined} className={`set-nav-item${section === s.id ? ' set-nav-item-active' : ''}`} onClick={() => setSection(s.id)}>
            <SectionIcon id={s.id} />
            {s.label}
          </button>
        ))}
      </nav>

      <main className="set-main">
        <header className="set-head">
          <h3>{SECTIONS.find((s) => s.id === section)?.label}</h3>
          <span className={saved && !saved.ok ? 'set-saved set-saved-bad' : 'set-saved'} role="status">
            {saved?.text}
          </span>
          <button type="button" className="icon-btn set-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>

        {section === 'canvas' && (
          <div className="set-group">
            <Row title="Sessions sidebar" help="The list of sessions down the left of the canvas." htmlFor="set-sidebar">
              <Toggle id="set-sidebar" checked={prefs.sidebar} onChange={() => onToggle('sidebar')} />
            </Row>
            <Row title="Minimap" help="A small map of the canvas in the corner." htmlFor="set-minimap">
              <Toggle id="set-minimap" checked={prefs.minimap} onChange={() => onToggle('minimap')} />
            </Row>
            <Row title="Link legend" help="A key to what each kind of link means." htmlFor="set-legend">
              <Toggle id="set-legend" checked={prefs.legend} onChange={() => onToggle('legend')} />
            </Row>
            <Row title="Snap to grid" help="Windows line up with the dots when you drag them." htmlFor="set-snap">
              <Toggle id="set-snap" checked={prefs.snap} onChange={() => onToggle('snap')} />
            </Row>
            <Row title="Scroll wheel" help="What the wheel does over empty canvas. Ctrl and the wheel always zooms." htmlFor="set-wheel">
              <select id="set-wheel" value={prefs.wheel} onChange={(e) => onPrefs({ wheel: e.target.value === 'pan' ? 'pan' : 'zoom' })}>
                <option value="zoom">Zooms</option>
                <option value="pan">Moves the canvas</option>
              </select>
            </Row>
            <Row title="Usage percentages" help="What the numbers in the title bar show." htmlFor="set-usage-mode">
              <select id="set-usage-mode" name="usageMode" value={prefs.usageMode} onChange={(e) => onUsageMode(e.target.value as UsageMode)}>
                <option value="left">Left</option>
                <option value="used">Used</option>
              </select>
            </Row>
          </div>
        )}

        {section === 'claude' && draft && (
          <>
            <div className="set-group">
              <Row
                wide
                title="Terminal program"
                htmlFor="claudeTerminal"
                help="Starts first, inside the Claude window, and loads your profile and aliases. Leave it empty to run Claude directly. To give the program options of its own, put its path in double quotes."
              >
                <ProgramInput name="claudeTerminal" value={terminal} list="terminal-programs" placeholder="None" onChange={(v) => set('claudeTerminal', v)} />
                <datalist id="terminal-programs">
                  {TERMINALS.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Row>
              <Row
                wide
                title="Claude command"
                htmlFor="claudeCommand"
                help={
                  <>
                    For example <code>source ~/work.sh &amp;&amp; claude</code>. Patchbay's options for status and resume go at the end, or where you write <code>{'{args}'}</code>. Your command has to pass them on to Claude.
                  </>
                }
              >
                <ProgramInput name="claudeCommand" value={command} placeholder="claude" onChange={(v) => set('claudeCommand', v)} />
                {noShell && (
                  <p className="field-problem" role="alert">
                    This command needs a shell to run, so it isn't saved yet. Choose a terminal program above.
                  </p>
                )}
              </Row>
              <Row wide title="What will run" help="New Claude windows start with this. Open sessions keep running as they are.">
                <code className="set-summary">{launchSummary(terminal, command)}</code>
              </Row>
            </div>
            <div className="set-group">
              <Row
                wide
                title="Codex command"
                htmlFor="codexCommand"
                help={
                  <>
                    What runs for a Codex window, such as a full path to <code>codex.exe</code>. Leave it empty to use <code>codex</code> from your PATH. It runs directly, without a shell, and Patchbay's options go at the end, or where you write <code>{'{args}'}</code>. The first Codex window asks you once to trust Patchbay's hooks.
                  </>
                }
              >
                <ProgramInput name="codexCommand" value={draft?.codexCommand ?? ''} placeholder="codex" onChange={(v) => set('codexCommand', v)} />
              </Row>
            </div>
            <div className="set-group">
              {AGENT_KINDS.map((kind) => {
                const on = agents.enabled.includes(kind)
                const last = on && agents.enabled.length === 1
                const name = AGENT_NAMES[kind]
                const help = last
                  ? `On. At least one agent stays on, so turn another on before turning ${name} off.`
                  : on
                    ? `Patchbay may start ${name}. Turn it off, as when its usage has run out, and nothing new of it starts.`
                    : `Off. No new ${name} windows, restarts or resumes, and agents can't open one. Ones running now keep running.`
                return (
                  <Row key={kind} title={name} htmlFor={`agent-${kind}`} help={help}>
                    <Toggle id={`agent-${kind}`} checked={on} disabled={last} onChange={() => setAgentOn(kind, !on)} />
                  </Row>
                )
              })}
              <Row
                title="Default agent"
                htmlFor="defaultAgent"
                help={
                  <>
                    Leads a new team, and is what agents open when they don't name one. New windows from the menus ask which you want.
                    {fallback && (
                      <span className="set-note" role="status" data-default-fallback>
                        {' '}
                        {fallback}
                      </span>
                    )}
                  </>
                }
              >
                <select id="defaultAgent" name="defaultAgent" value={agents.default} onChange={(e) => set('defaultAgent', e.target.value === 'codex' ? 'codex' : '')}>
                  {AGENT_KINDS.map((kind) => (
                    <option key={kind} value={kind} disabled={!agents.enabled.includes(kind)}>
                      {AGENT_NAMES[kind]}
                    </option>
                  ))}
                </select>
              </Row>
              <Row
                title="Codex permissions"
                htmlFor="codexApproval"
                help="What Codex may do without asking. Never ask keeps Codex's sandbox, so anything it blocks comes back to Codex as a failure. Skip all runs every command with no sandbox and no question, so use it only in a folder you trust. New and restarted Codex windows use it."
              >
                <select id="codexApproval" name="codexApproval" value={CODEX_APPROVALS.some(([v]) => v === draft?.codexApproval) ? draft?.codexApproval : ''} onChange={(e) => set('codexApproval', e.target.value)}>
                  {CODEX_APPROVALS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row title="Claude permissions" help="What Claude may do without asking." htmlFor="permissionMode">
                <select id="permissionMode" name="permissionMode" value={mode} onChange={(e) => set('permissionMode', e.target.value)}>
                  {modes.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Row>
            </div>
          </>
        )}

        {section === 'terminals' && draft && (
          <div className="set-group">
            <TerminalProfilesSection />
            <Row wide title="Shell for run commands" htmlFor="shell" help="The program run command windows use. Leave it empty for Git Bash, or PowerShell if Git Bash isn't installed. New terminals use the profiles above.">
              <ProgramInput name="shell" value={draft.shell ?? ''} placeholder="Automatic" onChange={(v) => set('shell', v)} />
            </Row>
            <Row title="Font size" help="Applies to every terminal and agent window, straight away.">
              <div className="stepper" role="group" aria-label="Font size">
                <button type="button" className="btn" aria-label="Smaller" data-font="down" disabled={prefs.fontSize <= FONT_SIZE.min} onClick={() => onFontSize(prefs.fontSize - 1)}>
                  −
                </button>
                <output className="stepper-value">{prefs.fontSize}</output>
                <button type="button" className="btn" aria-label="Larger" data-font="up" disabled={prefs.fontSize >= FONT_SIZE.max} onClick={() => onFontSize(prefs.fontSize + 1)}>
                  +
                </button>
              </div>
            </Row>
            <Row title="Font" htmlFor="set-font-family" help="Any monospaced font installed on this PC. Leave it empty for Cascadia Mono.">
              <input id="set-font-family" list="mono-fonts" placeholder="Cascadia Mono" spellCheck={false} value={prefs.terminal.fontFamily} onChange={(e) => setLook({ fontFamily: e.target.value })} />
              <datalist id="mono-fonts">
                {MONO_FONTS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Row>
            <Row title="Cursor" htmlFor="set-cursor-style" help="How the cursor is drawn in terminals and agent windows.">
              <select id="set-cursor-style" value={prefs.terminal.cursorStyle} onChange={(e) => setLook({ cursorStyle: e.target.value as TerminalLook['cursorStyle'] })}>
                <option value="block">Block</option>
                <option value="bar">Bar</option>
                <option value="underline">Underline</option>
              </select>
            </Row>
            <Row title="Blinking cursor" htmlFor="set-cursor-blink">
              <Toggle id="set-cursor-blink" checked={prefs.terminal.cursorBlink} onChange={() => setLook({ cursorBlink: !prefs.terminal.cursorBlink })} />
            </Row>
            <Row title="Copy on select" htmlFor="set-copy-select" help="Selecting text copies it, without pressing Ctrl+C.">
              <Toggle id="set-copy-select" checked={prefs.terminal.copyOnSelect} onChange={() => setLook({ copyOnSelect: !prefs.terminal.copyOnSelect })} />
            </Row>
            <Row title="Scrollback" htmlFor="set-scrollback" help={`Lines each window keeps to scroll back through, from ${SCROLLBACK.min.toLocaleString('en-US')} to ${SCROLLBACK.max.toLocaleString('en-US')}. More uses more memory.`}>
              <input
                id="set-scrollback"
                type="number"
                min={SCROLLBACK.min}
                max={SCROLLBACK.max}
                step={1000}
                key={prefs.terminal.scrollback}
                defaultValue={prefs.terminal.scrollback}
                // Applied on leaving the field, so typing a number isn't clamped at every key.
                onBlur={(e) => setLook({ scrollback: cleanTerminalLook({ ...prefs.terminal, scrollback: Number(e.target.value) }).scrollback })}
              />
            </Row>
          </div>
        )}

        {section === 'keys' && <ShortcutSettings overrides={prefs.keys} onChange={onKeys} />}

        {section === 'notifications' && draft && (
          <div className="set-group">
            <Row title="Windows notifications" help="When a session needs you or finishes its turn, unless you're already in that window." htmlFor="set-notifications">
              <Toggle id="set-notifications" checked={draft.notifications !== 'off'} onChange={() => set('notifications', draft.notifications === 'off' ? '' : 'off')} />
            </Row>
            <Row title="Sound" help="A short chime when a session needs you. The taskbar badge stays on either way." htmlFor="set-sound">
              <Toggle id="set-sound" checked={draft.sound !== 'off'} onChange={() => set('sound', draft.sound === 'off' ? '' : 'off')} />
            </Row>
            <Row title="Try them" help={testResult ?? 'Plays the chime, or sends a real notification.'}>
              <div className="set-input-row">
                <button type="button" className="btn" data-test="chime" onClick={playChime}>
                  Play chime
                </button>
                <button type="button" className="btn" data-test="notification" onClick={sendTest}>
                  Send notification
                </button>
              </div>
            </Row>
          </div>
        )}

        {section === 'sessions' && (
          <>
            {draft && (
              <div className="set-group">
                <Row title="Keep the PC awake while agents work" help="Stops Windows sleeping while any session is starting or working. The screen can still turn off. It lets go once every agent is idle or waiting on you." htmlFor="set-keep-awake">
                  <Toggle id="set-keep-awake" checked={draft.keepAwake !== 'off'} onChange={() => set('keepAwake', draft.keepAwake === 'off' ? '' : 'off')} />
                </Row>
              </div>
            )}
            <HostSection />
          </>
        )}

        {section === 'about' && (
          <div className="set-group">
            <Row title="Version">
              <span className="set-value">Patchbay {info?.version}</span>
            </Row>
            <Row wide title="Your data" help="Your canvas, settings and saved terminal output.">
              <div className="set-input-row">
                <code className="set-summary">{info?.dataDir}</code>
                <button type="button" className="btn" onClick={() => void bridge.openDataFolder()}>
                  Open folder
                </button>
              </div>
            </Row>
            <Row title="Log" help="When the window stopped responding or crashed, and how it recovered. Useful to share if Patchbay misbehaves.">
              <button type="button" className="btn" data-cmd="open-log" onClick={() => void bridge.openLog()}>
                Open log
              </button>
            </Row>
            <Row title="Settings file" help="The Claude and terminal settings as text, for editing by hand.">
              <button type="button" className="btn" data-cmd="edit-settings" onClick={() => void bridge.openSettingsFile()}>
                Open file
              </button>
            </Row>
          </div>
        )}
        {section === 'about' && draft && <UpdateSettings draft={draft} set={set} />}
      </main>
    </div>
  )
}

function updateText(s: UpdateState | null): string {
  if (!s) return ''
  switch (s.phase) {
    case 'off':
      return s.reason
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking…'
    case 'none':
      return `Up to date. Checked ${new Date(s.checkedAt).toLocaleTimeString()}.`
    case 'downloading':
      return `Downloading ${s.version}… ${s.percent}%`
    case 'ready':
      return `Version ${s.version} is ready to install.`
    case 'error':
      return `The check failed: ${s.message}`
  }
}

/** Where updates come from, whether to look for them by itself, and the restart that installs one. */
function UpdateSettings({ draft, set }: { draft: Settings; set: (key: keyof Settings, value: string) => void }): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    void bridge.getUpdateState().then(setState)
    return bridge.onUpdateState(setState)
  }, [])
  const busy = state?.phase === 'checking' || state?.phase === 'downloading'
  return (
    <div className="set-group" data-settings-updates>
      <Row
        wide
        title="Update feed"
        htmlFor="updateFeed"
        help={
          <>
            Where new versions come from: <code>github:owner/repo</code> for GitHub releases, or an https address holding <code>latest.yml</code>. Leave it empty for no updates.
          </>
        }
      >
        <input id="updateFeed" name="updateFeed" placeholder="github:owner/repo" spellCheck={false} value={draft.updateFeed ?? ''} onChange={(e) => set('updateFeed', e.target.value)} />
      </Row>
      <Row title="Check for updates by itself" htmlFor="set-update-check" help="Shortly after Patchbay starts, then every 6 hours. A new version downloads, and waits for you to restart.">
        <Toggle id="set-update-check" checked={draft.updateCheck !== 'off'} onChange={() => set('updateCheck', draft.updateCheck === 'off' ? '' : 'off')} />
      </Row>
      <Row title="Status" help={<span data-update-status>{updateText(state)}</span>}>
        {state?.phase === 'ready' ? (
          confirming ? (
            <span className="set-input-row">
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Not now
              </button>
              <button type="button" className="btn btn-solid" data-update="restart-confirm" onClick={() => void bridge.restartToUpdate()}>
                End sessions and restart
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-solid" data-update="restart" title="Running sessions end. Agents resume their conversations in the new version." onClick={() => setConfirming(true)}>
              Restart to update
            </button>
          )
        ) : (
          <button type="button" className="btn" data-update="check" disabled={busy} onClick={() => void bridge.checkForUpdates()}>
            Check now
          </button>
        )}
      </Row>
      {confirming && (
        <p className="set-help set-warning" role="alert">
          Installing ends every running session. Claude and Codex windows resume their conversations when the new version opens. Terminals start again in their folders.
        </p>
      )}
    </div>
  )
}
