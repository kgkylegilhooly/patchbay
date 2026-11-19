import DOMPurify from 'dompurify'
import { Marked, type Tokens, type TokensList } from 'marked'
import { escapeHtml, highlight, languageLabel } from '../highlight'

/**
 * A document's sections as safe HTML. Unlike a note, single line breaks don't break lines: a plan file is written for
 * a Markdown renderer, and agents wrap long paragraphs.
 */
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const mermaid = (lang ?? '').trim().toLowerCase() === 'mermaid'
      const label = mermaid ? 'Mermaid diagram (source)' : languageLabel(lang)
      return (
        `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
        `<span class="code-copy" role="button" tabindex="0">Copy</span></div>` +
        `<pre><code>${highlight(text.replace(/\n$/, ''), mermaid ? undefined : lang)}</code></pre></div>`
      )
    },
    // Read-only: the reader never writes the file, so a task box can't be ticked here.
    checkbox({ checked }) {
      return `<input type="checkbox" class="task" disabled=""${checked ? ' checked=""' : ''}> `
    },
    // The window loads no remote pictures, and local ones only from itself, so a picture is named rather than broken.
    image({ text, href }) {
      return `<span class="reader-img" title="${escapeHtml(href ?? '')}">${escapeHtml(text ? `Image: ${text}` : 'Image')}</span>`
    }
  }
})

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'img', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction']
}

function clean(html: string): string {
  // DOMPurify returns its input untouched when it has no DOM. Never let that through.
  if (!DOMPurify.isSupported) return escapeHtml(html.replace(/<[^>]*>/g, ''))
  return DOMPurify.sanitize(html, PURIFY) as string
}

/** A section's blocks, with the document's link definitions. */
export function renderBlocks(tokens: TokensList): string {
  return clean(markdown.parser(tokens))
}

/** A heading's words, with their inline formatting. */
export function renderHeading(heading: Tokens.Heading): string {
  return clean(markdown.parseInline(heading.text, { async: false }) as string)
}
