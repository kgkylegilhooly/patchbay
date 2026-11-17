/**
 * Git Bash drops the first byte it reads after its window is resized: the resize signal waits for the next read, and
 * that read loses what it took. So right after opening the focus view, dragging a divider or resizing a node, the
 * first letter typed could vanish, turning `echo` into `cho`. Waiting doesn't help; it's the next read, however late.
 *
 * The fix is a byte bash ignores, Ctrl+@ (NUL, which only sets readline's invisible mark), sent ahead of the first
 * key after a resize, for the lost read to take instead. It's sent only when bash's line editor is what will read it:
 * anything else, such as a y/n question or a password prompt, would take it as part of the answer.
 */
export const SACRIFICE = '\x00'

export interface PromptState {
  /** xterm's bracketed paste mode: bash turns it on while its line editor waits for a command, and off to run one. */
  bracketedPaste: boolean
  /** A full-screen program, such as vim or less, has the screen. */
  alternateScreen: boolean
  /** The text on the cursor's row up to the cursor. */
  beforeCursor: string
}

/** Whether bash's line editor is waiting at an empty prompt, as $ or # just before the cursor shows. */
export function atShellPrompt(s: PromptState): boolean {
  return s.bracketedPaste && !s.alternateScreen && /[$#] $/.test(s.beforeCursor)
}

/** What to send for the first key after a resize: the key, with the sacrifice ahead of it at a bash prompt. */
export function guardFirstKey(data: string, resizedSinceInput: boolean, prompt: PromptState): string {
  return resizedSinceInput && atShellPrompt(prompt) ? SACRIFICE + data : data
}
