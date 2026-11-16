/**
 * Questions Claude Code and Codex can ask on screen before their session starts, which only the person can answer.
 * No hook fires while one is showing, so the screen is the only sign of it.
 */
const QUESTIONS: Array<[string[], string]> = [
  [['trust this folder', 'trust the files in this folder', 'trust the contents of this directory', 'a project you created or one you trust'], 'folder-trust'],
  [['sign in with chatgpt', 'select login method', 'choose a login method', 'choose your login method'], 'sign-in']
]

/** How much of the start of a session is kept to look for a question in. */
export const STARTUP_SCREEN_CHARS = 6000

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
const PHRASES = QUESTIONS.map(([phrases, kind]) => [phrases.map(squash), kind] as const)

/**
 * Which question the screen shows, if any. Takes readable text, with terminal escapes removed. Full-screen programs
 * place words with cursor moves rather than spaces, so spacing is ignored.
 */
export function startupQuestion(screen: string): string | null {
  const flat = squash(screen)
  for (const [phrases, kind] of PHRASES) if (phrases.some((p) => flat.includes(p))) return kind
  return null
}
