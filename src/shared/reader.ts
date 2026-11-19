/**
 * The Reader: a read-only node for plans and Markdown files, with comments the person sends back to an agent.
 * See docs/plans/doc-viewer.md.
 */

/** Where a comment is: the headings above it, from the top down, and the words it's on. */
export interface CommentAnchor {
  /** Heading titles from the outermost down. Empty for text before the first heading. */
  section: string[]
  /** The rendered text commented on, whitespace collapsed. */
  quote: string
}

export interface ReaderComment {
  id: string
  /** Null for a comment on the whole document. */
  anchor: CommentAnchor | null
  text: string
  createdAt: number
  resolved: boolean
  /** When it last went to an agent, and to whom. Cleared when it's edited or reopened, so it goes again. */
  /**
   * When it last went to an agent, and to whom. `queued` when the agent was busy, so it waits its turn: it goes once
   * the agent is idle, and is lost if the agent exits first.
   */
  sent?: { at: number; to: string; queued?: boolean }
}

/** What reading a reader node's file gives the window. */
export type ReadResult =
  | { ok: true; text: string; mtimeMs: number; path: string }
  | { ok: false; reason: string; missing?: boolean }

export type Refusal = { ok: false; reason: string }

/** What `open` takes: a path the person chose, and where to put the node. */
export interface OpenDoc {
  path: string
  /** Canvas coordinates for the node's top left. Without them it goes beside `fromNodeId`, or near the view. */
  at?: { x: number; y: number }
  /** The node it came from, as a terminal whose path was clicked. Its cwd resolves a relative path. */
  fromNodeId?: string
}

/**
 * The Reader's calls to main, as window.patchbayDocs. Each is one request on `pb:docs:<method>`, served in
 * src/main/reader/ipc.ts. Main pushes `pb:docs:changed` with the path whenever a watched file changes.
 */
export interface DocsBridge {
  read(nodeId: string): Promise<ReadResult>
  open(a: OpenDoc): Promise<{ ok: true; nodeId: string } | Refusal>
  /** Shows a file picker, then opens what was picked. `cancelled` when nothing was. */
  pick(at?: { x: number; y: number }): Promise<{ ok: true; nodeId: string } | Refusal | { ok: false; cancelled: true; reason: string }>
  /** The latest plan, or long Markdown answer, in an agent's conversation, opened beside it. */
  openPlan(agentId: string): Promise<{ ok: true; nodeId: string; what: 'plan file' | 'plan' | 'answer' } | Refusal>
  comments(nodeId: string): Promise<{ ok: true; comments: ReaderComment[] } | Refusal>
  saveComments(nodeId: string, comments: ReaderComment[]): Promise<{ ok: true } | Refusal>
  /** A link in the document, resolved against its folder and opened the safe way terminal links are. */
  openLink(nodeId: string, href: string): Promise<{ ok: true } | Refusal>
}

/** What a reader can open. Plain text is allowed so a .txt plan reads too. */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.mkd', '.txt']

export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase().replace(/(?::\d+){1,2}$/, '').replace(/#.*$/, '')
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** The file's name without its folder, for titles. */
export function docName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
