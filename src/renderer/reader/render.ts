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
  // No ids or data attributes from the document: they could pose as the reader's own markers or the app's.
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'id'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true as const
}

/** The classes this renderer gives out. Any other class in a document is dropped, so it can't pass for an app part. */
const OWN_CLASS = /^(code-(block|head|lang|copy)|tok-[a-z]+|task|reader-img)$/

/** A document's HTML, made safe: see PURIFY and OWN_CLASS. Exported for tests. */
export function clean(html: string): string {
  // DOMPurify returns its input untouched when it has no DOM. Never let that through.
  if (!DOMPurify.isSupported) return escapeHtml(html.replace(/<[^>]*>/g, ''))
  const fragment = DOMPurify.sanitize(html, PURIFY)
  for (const el of fragment.querySelectorAll('[class]')) {
    const kept = [...el.classList].filter((c) => OWN_CLASS.test(c))
    if (kept.length) el.setAttribute('class', kept.join(' '))
    else el.removeAttribute('class')
  }
  const box = document.createElement('div')
  box.append(fragment)
  return box.innerHTML
}

/** A section's blocks, with the document's link definitions. */
export function renderBlocks(tokens: TokensList): string {
  return clean(markdown.parser(tokens))
}

/** A heading's words, with their inline formatting. */
export function renderHeading(heading: Tokens.Heading): string {
  return clean(markdown.parseInline(heading.text, { async: false }) as string)
}
