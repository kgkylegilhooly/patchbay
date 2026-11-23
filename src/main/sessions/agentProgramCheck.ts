import { AGENT_NAMES, type AgentKind } from '../../shared/model'
import type { Settings } from '../../shared/settings'
import { commandFound, resolveClaudeAsync } from './claudeLaunch'
import { resolveCodexAsync } from './codexLaunch'

export interface ProgramLookups {
  found: (commandLine: string) => Promise<boolean>
  claude: () => Promise<unknown>
  codex: () => Promise<unknown>
}

const real: ProgramLookups = { found: commandFound, claude: resolveClaudeAsync, codex: resolveCodexAsync }

/**
 * Why an agent of this kind won't start, as the New form says it before Start, or null when its program is found.
 * Looked up the way a launch looks: the terminal program from Settings first, then the command from Settings, then
 * the program on PATH. Never runs anything. See docs/plans/r3-start.md.
 */
export async function agentProgramProblem(kind: AgentKind, settings: Settings, look: ProgramLookups = real): Promise<string | null> {
  const name = AGENT_NAMES[kind]
  const terminal = kind === 'claude' ? settings.claudeTerminal?.trim() : ''
  const command = (kind === 'claude' ? settings.claudeCommand : settings.codexCommand)?.trim()
  if (terminal && !(await look.found(terminal))) return `The terminal program set for ${name} wasn't found.`
  if (command) return (await look.found(command)) ? null : `The ${name} command set in Settings wasn't found.`
  try {
    await (kind === 'codex' ? look.codex() : look.claude())
    return null
  } catch {
    return `${name} wasn't found on PATH.`
  }
}
