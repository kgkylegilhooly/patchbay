import { expect, test } from 'vitest'
import { agentProgramProblem, type ProgramLookups } from '../../src/main/sessions/agentProgramCheck'
import { customLaunch } from '../../src/main/sessions/claudeLaunch'
import { fixOf, withFix } from '../../src/main/sessions/startFix'

const look = (found: string[], onPath: { claude?: boolean; codex?: boolean } = {}): ProgramLookups & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    found: async (line) => {
      asked.push(line)
      return found.some((f) => line.startsWith(f))
    },
    claude: async () => {
      if (!onPath.claude) throw new Error('not found')
    },
    codex: async () => {
      if (!onPath.codex) throw new Error('not found')
    }
  }
}

test('says nothing when the agent program is found', async () => {
  expect(await agentProgramProblem('claude', {}, look([], { claude: true }))).toBeNull()
  expect(await agentProgramProblem('codex', {}, look([], { codex: true }))).toBeNull()
  expect(await agentProgramProblem('claude', { claudeCommand: 'node fake.cjs' }, look(['node']))).toBeNull()
})

test('names the agent when its program is not on PATH', async () => {
  expect(await agentProgramProblem('claude', {}, look([]))).toBe("Claude Code wasn't found on PATH.")
  expect(await agentProgramProblem('codex', {}, look([], { claude: true }))).toBe("Codex wasn't found on PATH.")
})

test('a command or terminal from Settings is looked up as a launch would, and named as from Settings', async () => {
  expect(await agentProgramProblem('codex', { codexCommand: 'codex-nope' }, look([], { codex: true }))).toBe("The Codex command set in Settings wasn't found.")
  expect(await agentProgramProblem('claude', { claudeTerminal: 'wt.exe', claudeCommand: 'claude' }, look(['claude']))).toBe("The terminal program set for Claude Code wasn't found.")
  // With a terminal set, the command runs inside it and may be on that shell's PATH only, so only the terminal is asked.
  const t = look(['bash.exe'])
  expect(await agentProgramProblem('claude', { claudeTerminal: 'bash.exe', claudeCommand: '~/.local/bin/claude' }, t)).toBeNull()
  expect(await agentProgramProblem('claude', { claudeTerminal: 'bash.exe' }, t)).toBeNull()
  expect(t.asked).toEqual(['bash.exe', 'bash.exe'])
  // Codex has no terminal setting: Claude's isn't asked about for it.
  const l = look(['codex-x'])
  expect(await agentProgramProblem('codex', { claudeTerminal: 'wt.exe', codexCommand: 'codex-x' }, l)).toBeNull()
  expect(l.asked).toEqual(['codex-x'])
})

test("a launch that can't find its program names the agent, and Codex never falls back to claude", () => {
  const find = (name: string): string | null => (name === 'claude' ? 'C:\\bin\\claude.exe' : null)
  expect(() => customLaunch({ command: 'codex-nope', agent: 'codex' }, [], find)).toThrow('The Codex command "codex-nope" was not found')
  expect(() => customLaunch({ command: 'claude-nope' }, [], find)).toThrow('The Claude Code command "claude-nope" was not found')
  // With no command set, a Codex launch looks for codex, not claude.
  expect(() => customLaunch({ agent: 'codex' }, [], find)).toThrow('"codex" was not found')
})

test('a start error carries its fix: one given, else a missing folder asks for a folder', () => {
  const e = withFix(new Error('x'), 'agents')
  expect(fixOf(e, 'spawn-failed')).toBe('agents')
  // The first fix given stands.
  expect(fixOf(withFix(e, 'sessions'), 'spawn-failed')).toBe('agents')
  expect(fixOf(new Error('gone'), 'cwd-missing')).toBe('folder')
  expect(fixOf(new Error('boom'), 'spawn-failed')).toBeUndefined()
})
