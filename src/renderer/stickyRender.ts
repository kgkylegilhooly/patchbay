import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { escapeHtml, highlight, languageLabel } from './highlight'

let tasks = 0
let tasksOn = false

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // A fenced block gets a header that names its language and a copy control, which is a span because buttons are
    // forbidden below. Whoever shows the HTML handles the click.
    code({ text, lang }) {
      return (
        `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(languageLabel(lang))}</span>` +
        `<span class="code-copy" role="button" tabindex="0">Copy</span></div>` +
        `<pre><code>${highlight(text.replace(/\n$/, ''), lang)}</code></pre></div>`
      )
    },
    // Task boxes are numbered in the order they appear, so a click can find its line in the text.
    checkbox({ checked }) {
      const n = tasks++
      return `<input type="checkbox" class="task" data-task="${n}"${checked ? ' checked=""' : ''}${tasksOn ? '' : ' disabled=""'}> `
    }
  }
})

/**
 * Markdown as safe HTML, for notes and chat. The text can come from agents, so it's treated as untrusted. Task boxes
 * can only be ticked where the caller asks for that, as a note does.
 */
export function renderMarkdown(text: string, options: { tasks?: boolean } = {}): string {
  // DOMPurify returns its input untouched when it has no DOM. Never let that through.
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(text)}</p>`
  tasks = 0
  tasksOn = options.tasks === true
  const html = markdown.parse(text, { async: false })
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['style']
  })
}

/** What a rendered block's copy control should put on the clipboard, or null if the click wasn't on one. */
export function copiedCode(target: EventTarget | null): string | null {
  const copy = target instanceof Element ? target.closest('.code-copy') : null
  const code = copy?.closest('.code-block')?.querySelector('pre')
  return code ? (code.textContent ?? '') : null
}

/** Shows that the copy happened, for a moment. */
export function flashCopied(target: EventTarget | null): void {
  const copy = target instanceof Element ? target.closest('.code-copy') : null
  if (!copy) return
  copy.textContent = 'Copied'
  setTimeout(() => (copy.textContent = 'Copy'), 1200)
}
