/**
 * Text typed into an agent as one bracketed paste. ConPTY hands a program its input in reads of at most 1024 bytes,
 * and Claude Code (2.1.327) drops every full read of plain typed input, so a long message arrived without its start.
 * A paste is kept whole across any number of reads, by Claude Code and by Codex, which both turn bracketed paste on.
 *
 * The text must already be free of control characters (see plainText), so it can't end the paste early. Enter goes
 * separately, after it: inside the paste it would be a line break, not a submit.
 */
export function asPaste(text: string): string {
  return `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`
}
