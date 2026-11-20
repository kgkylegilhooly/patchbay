import DOMPurify from 'dompurify'
import { Marked, type Tokens, type TokensList } from 'marked'
import { imageHrefKind } from '../../core/reader/pictures'
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
      // A Mermaid block is drawn as a diagram once the page has it (see ./enhance.ts). Until then, or when it can't
      // be drawn, it shows as its source.
      const mermaid = (lang ?? '').trim().toLowerCase() === 'mermaid'
      const label = mermaid ? 'Mermaid diagram' : languageLabel(lang)
      return (
        `<div class="code-block${mermaid ? ' code-mermaid' : ''}"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
        `<span class="code-copy" role="button" tabindex="0">Copy</span></div>` +
        `<pre><code>${highlight(text.replace(/\n$/, ''), mermaid ? undefined : lang)}</code></pre></div>`
      )
    },
    // Read-only: the reader never writes the file, so a task box can't be ticked here.
    checkbox({ checked }) {
      return `<input type="checkbox" class="task" disabled=""${checked ? ' checked=""' : ''}> `
    },
    // A local picture is named here and shown once main has read it (see ./enhance.ts). The window never loads one
    // from the web: that stays a link to it.
    image({ text, href }) {
      const label = escapeHtml(text ? `Image: ${text}` : 'Image')
      if (imageHrefKind(href) === 'remote') {
        return `<a class="reader-img reader-img-remote" href="${escapeHtml(href ?? '')}" title="Not loaded: pictures from the web aren't shown here. Click to open it in the browser.">${label}</a>`
      }
      return `<span class="reader-img reader-img-local" title="${escapeHtml(href ?? '')}">${label}</span>`
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
const OWN_CLASS = /^(code-(block|head|lang|copy|mermaid)|tok-[a-z]+|task|reader-img(-local|-remote)?)$/

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
