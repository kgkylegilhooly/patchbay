import { Lexer, type Token, type Tokens, type TokensList } from 'marked'

/**
 * A Markdown document cut into sections at its headings, for the Reader: each section renders on its own (so it can
 * collapse and be jumped to), and its plain text is what comments are anchored against.
 */
export interface DocSection {
  index: number
  /** 0 for the text before the first heading, else the heading's level. */
  depth: number
  /** The heading as plain text. Empty for the text before the first heading. */
  title: string
  /** Titles of this heading and those above it, from the outermost down. Empty before the first heading. */
  path: string[]
  /** The heading's own token, to render it. Absent before the first heading. */
  heading?: Tokens.Heading
  /** The blocks under the heading, up to the next heading of any level. They carry the document's link definitions. */
  body: TokensList
  /** The heading and body as plain text, whitespace collapsed: what a selection on the page reads as. */
  text: string
}

export interface DocOutline {
  sections: DocSection[]
  /** Every section's text joined, for a quote that spans sections. */
  text: string
}

/** Whitespace collapsed to single spaces, so text from the page and from the source compare. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

/** What a token reads as on the page, roughly as the browser's selection would give it. */
export function plainText(token: Token | Token[]): string {
  if (Array.isArray(token)) return token.map(plainText).join('')
  switch (token.type) {
    case 'space':
    case 'hr':
    case 'def':
      return ' '
    case 'br':
      return ' '
    case 'html': {
      const words = decode(token.text.replace(/<[^>]*>/g, token.block ? ' ' : ''))
      return token.block ? ` ${words} ` : words
    }
    case 'code':
      return ` ${token.text} `
    case 'codespan':
      return decode(token.text)
    case 'image':
      return token.text
    case 'checkbox':
      return ''
    case 'list':
      return ` ${(token as Tokens.List).items.map((item) => plainText(item.tokens)).join(' ')} `
    case 'table': {
      const t = token as Tokens.Table
      const cells = [...t.header, ...t.rows.flat()]
      return ` ${cells.map((c) => plainText(c.tokens)).join(' ')} `
    }
    case 'heading':
    case 'paragraph':
    case 'blockquote':
      return ` ${plainText((token as Tokens.Paragraph).tokens ?? [])} `
    default: {
      const t = token as Token & { tokens?: Token[]; text?: string }
      if (t.tokens?.length) return plainText(t.tokens)
      return typeof t.text === 'string' ? decode(t.text) : ''
    }
  }
}

function asList(tokens: Token[], links: TokensList['links']): TokensList {
  return Object.assign(tokens, { links })
}

/** Cuts a document into sections. GitHub-flavoured, as agents write it. */
export function outline(markdown: string): DocOutline {
  const all = Lexer.lex(markdown, { gfm: true })
  const sections: DocSection[] = []
  const stack: { depth: number; title: string }[] = []
  let current: { depth: number; title: string; path: string[]; heading?: Tokens.Heading; body: Token[] } = { depth: 0, title: '', path: [], body: [] }
  const close = (): void => {
    const empty = current.depth === 0 && current.body.every((t) => t.type === 'space')
    if (empty) return
    const text = normalizeText(`${current.heading ? plainText(current.heading) : ''} ${plainText(current.body)}`)
    sections.push({ index: sections.length, depth: current.depth, title: current.title, path: current.path, heading: current.heading, body: asList(current.body, all.links), text })
  }
  for (const token of all) {
    if (token.type !== 'heading') {
      current.body.push(token)
      continue
    }
    close()
    const heading = token as Tokens.Heading
    const title = normalizeText(plainText(heading))
    while (stack.length && stack[stack.length - 1].depth >= heading.depth) stack.pop()
    stack.push({ depth: heading.depth, title })
    current = { depth: heading.depth, title, path: stack.map((s) => s.title), heading, body: [] }
  }
  close()
  return { sections, text: sections.map((s) => s.text).join(' ') }
}

/** The sections a collapsed heading hides: those after it, until one at its level or above. */
export function hiddenBy(sections: Pick<DocSection, 'depth'>[], collapsed: ReadonlySet<number>): Set<number> {
  const hidden = new Set<number>()
  let until: number | null = null
  sections.forEach((s, i) => {
    if (until !== null && s.depth > until) {
      hidden.add(i)
      return
    }
    until = collapsed.has(i) && s.depth > 0 ? s.depth : null
  })
  return hidden
}
