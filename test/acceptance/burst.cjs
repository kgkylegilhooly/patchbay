'use strict'
// Prints a lot at once, as Claude Code does when it reprints a whole long conversation, which it does after a resize:
// clears the screen and its history, then writes every line again, in color.
// Run: node burst.cjs <kilobytes> <tag> [--clear]
const kb = Number(process.argv[2] || 512)
const tag = process.argv[3] || 'x'
const clear = process.argv.includes('--clear')
const lines = []
let size = 0
for (let i = 0; size < kb * 1024; i++) {
  const line = `\x1b[38;2;${(i * 7) % 255};${(i * 13) % 255};200m●\x1b[0m line ${i} of the conversation, with \x1b[1mbold\x1b[0m and \x1b[38;2;150;150;160mdim text that runs on for a while\x1b[0m`
  lines.push(line)
  size += line.length + 2
}
process.stdout.write(`${clear ? '\x1b[2J\x1b[3J\x1b[H' : ''}${lines.join('\r\n')}\r\nBURST-DONE-${tag}\r\n`)
