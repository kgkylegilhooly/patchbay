import type { AgentKind } from '../../shared/model'

/** What a search result opens. */
export type SourceRef =
  /** An agent window on the canvas, or a note. */
  | { type: 'node'; nodeId: string }
  /** A conversation in the closed history. */
  | { type: 'closed'; closedId: string }
  /** A message between nodes: the receiver, else the sender, else only its text. */
  | { type: 'message'; from: string; to: string; at: number }
  /** Something else, such as a task result. Only its text can be shown. */
  | { type: 'text' }

/** Conversations, notes and messages are built in. Anything else comes from a registered source, such as task results. */
export type SearchKind = 'conversation' | 'note' | 'message' | (string & {})

/** One searchable piece: a message of a conversation, a note, one agent message. */
export interface SearchEntry {
  text: string
  /** Who wrote it, for a conversation's messages. */
  role?: 'user' | 'assistant'
  /** When it was written, in ms, if known. */
  at?: number
}

/** Where reading a transcript got to, so the next sync reads only what was added. */
export interface FileCursor {
  /** Bytes read, up to the end of the last complete line. */
  offset: number
  size: number
  /** The file's first bytes, to tell a replaced file from a grown one. */
  head: string
}

export interface IndexedDoc {
  key: string
  kind: SearchKind
  title: string
  projectId?: string
  ref: SourceRef
  agent?: AgentKind
  /** A conversation's transcript. */
  path?: string
  cwd?: string
  /** When it was last changed or written, in ms. */
  at: number
  entries: SearchEntry[]
  cursor?: FileCursor
}

/** A source as main describes it. Conversations are read from their transcript; the rest carry their text. */
export interface ConversationSpec {
  kind: 'conversation'
  key: string
  title: string
  projectId?: string
  ref: SourceRef
  agent?: AgentKind
  path: string
  cwd?: string
  at?: number
}
/** A note, a message, or a registered source's document, such as a task result. */
export interface TextSpec {
  kind: SearchKind
  key: string
  title: string
  projectId?: string
  ref: SourceRef
  at: number
  text: string
}
export type SourceSpec = ConversationSpec | TextSpec

export interface SyncInput {
  sources: SourceSpec[]
  /** Every project's name now, by id. Remembered after a project is deleted. */
  projects: Record<string, string>
}

export interface SearchQuery {
  text: string
  projectId?: string
  /** Inclusive, in ms. */
  from?: number
  to?: number
  kinds?: SearchKind[]
  limit?: number
}

export interface SearchHit {
  key: string
  kind: SearchKind
  title: string
  projectId?: string
  projectName?: string
  /** The project has been deleted. */
  projectGone?: boolean
  ref: SourceRef
  agent?: AgentKind
  /** When the best matching entry was written. */
  at: number
  role?: 'user' | 'assistant'
  /** Text around the match, with `marks` as [start, end) ranges in it. */
  snippet: string
  marks: Array<[number, number]>
  /** Entries in this source that match. */
  matches: number
  /** Which of the source's entries matched best, for opening it there. -1 when only the title matched. */
  entry: number
}

/** One page of a source's indexed messages, for reading it without loading the whole transcript. */
export interface SourceWindow {
  title: string
  kind: SearchKind
  /** The index of the first entry here, in the whole source. */
  start: number
  entries: SearchEntry[]
  /** How many entries the source has in all. */
  total: number
  /** The entry that matched, as an index in the whole source. It may be on another page. */
  focus: number
}

export interface IndexStats {
  conversations: number
  notes: number
  messages: number
  other: number
  /** Referenced transcripts that couldn't be found on the last sync. */
  missing: number
  /** When the last sync finished, in ms. Null before the first. */
  syncedAt: number | null
  syncing: boolean
}

export interface SearchResult {
  hits: SearchHit[]
  stats: IndexStats
  /** More sources matched than were returned. */
  more: boolean
}

export type Evidence = 'found' | 'partial' | 'stale' | 'missing'

export interface HandoffSection {
  id: string
  title: string
  text: string
  evidence: Evidence
  /** Why it has that evidence, in a few words, shown beside the badge. */
  note?: string
}

export interface HandoffDraft {
  sourceTitle: string
  agent: AgentKind
  /** Where the source ran, and so where the next agent starts by default. */
  cwd: string
  projectId?: string
  builtAt: number
  sections: HandoffSection[]
}

/** What a handoff can be made from. */
export type HandoffSource = { type: 'node'; nodeId: string } | { type: 'closed'; closedId: string }
