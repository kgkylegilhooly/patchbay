import type { AgentKind, CanvasNode } from '../shared/model'
import { PATHS, type IconName } from './iconPaths'

export type { IconName }

/** Spoke angle and length, uneven on purpose so it reads as a hand-drawn burst and not a gear. */
const SPOKES: Array<[number, number]> = [
  [0, 10],
  [28, 8.4],
  [58, 10.4],
  [88, 8.8],
  [118, 10],
  [150, 8.2],
  [180, 10.2],
  [208, 8.6],
  [238, 10.4],
  [268, 8.4],
  [298, 10],
  [330, 8.8]
]

/** The Claude burst, redrawn for this app rather than taken from an official file. */
export function ClaudeIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="kind-icon kind-icon-claude" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#d97757" strokeWidth="2.3" strokeLinecap="round">
        {SPOKES.map(([angle, length]) => (
          <line key={angle} x1="12" y1="12" x2="12" y2={12 - length} transform={`rotate(${angle} 12 12)`} />
        ))}
      </g>
    </svg>
  )
}

/** Patchbay's own mark for Codex: a prompt inside a hexagon. Not OpenAI's logo. */
export function CodexIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="kind-icon kind-icon-codex" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#8fa8ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
      <path d="M9 9.5l2.5 2.5L9 14.5M13 15h3" />
    </svg>
  )
}

export function TerminalIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      className="kind-icon kind-icon-terminal"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7l5 5-5 5M12 18h7" />
    </svg>
  )
}

export function RunIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="kind-icon kind-icon-run" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" />
    </svg>
  )
}

export function KindIcon({ kind, agent }: { kind: CanvasNode['kind']; agent?: AgentKind }): React.JSX.Element | null {
  if (kind === 'claude') return agent === 'codex' ? <CodexIcon /> : <ClaudeIcon />
  if (kind === 'terminal') return <TerminalIcon />
  if (kind === 'run') return <RunIcon />
  if (kind === 'browser') return <Icon name="browser" size={14} />
  if (kind === 'trigger') {
    return (
      <svg className="kind-icon kind-icon-trigger" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
        <path d={PATHS.trigger} />
      </svg>
    )
  }
  return null
}

export function Icon({ name, size }: { name: IconName; size?: number }): React.JSX.Element {
  if (name === 'claude') return <ClaudeIcon size={size} />
  if (name === 'codex') return <CodexIcon size={size} />
  if (name === 'terminal') return <TerminalIcon size={size} />
  if (name === 'run') return <RunIcon size={size} />
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      <path d={PATHS[name]} />
    </svg>
  )
}
