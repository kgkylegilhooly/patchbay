import DOMPurify from 'dompurify'
import { marked } from 'marked'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Sticky markdown as safe HTML. Sticky text can come from agents, so it's treated as untrusted. */
export function renderMarkdown(text: string): string {
  // DOMPurify returns its input untouched when it has no DOM. Never let that through.
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(text)}</p>`
  const html = marked.parse(text, { async: false, gfm: true, breaks: true })
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['style']
  })
}
