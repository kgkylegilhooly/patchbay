import { basename, join, resolve } from 'node:path'
import type { TranscriptMessage } from '../core/transcript/read'
import type { CanvasStore } from '../shared/contract'
import { agentOf, type AgentKind } from '../shared/model'
import { checkDocPath, systemFolders } from './reader/policy'
import { asMarkdownPath, handoffFileName } from './search/saveHandoff'

/** F28: an agent window's conversation, saved as Markdown where the person picks, and its raw transcript shown in Explorer. */

const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' }

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

/** The messages that say something, each under who said it. A Codex note on its way through a turn is marked as one. */
export function conversationMarkdown(w: { title: string; cwd: string; agent?: AgentKind }, messages: TranscriptMessage[], now: Date): string {
  const name = AGENT_NAME[agentOf(w)]
  const parts = [`# ${w.title}`, '', `Conversation with ${name} in \`${w.cwd}\`, saved from Patchbay on ${stamp(now)}.`, '']
  for (const m of messages) {
    const text = m.text.trim()
    if (!text) continue
    parts.push(m.role === 'user' ? '## You' : m.commentary ? `## ${name} (on the way)` : `## ${name}`, '', text, '')
  }
  return parts.join('\n')
}

export type SaveConversationResult = { ok: true; path: string; messages: number } | { ok: false; reason: string; cancelled?: true }

export interface ConversationSaverDeps {
  store: CanvasStore
  home: string
  /** The whole conversation (readAllMessages). */
  read(path: string): Promise<TranscriptMessage[]>
  /** The system save dialog, which asks before replacing a file. */
  pickFile(defaultPath: string): Promise<string | null>
  /** `exclusive` fails with EEXIST rather than replace a file. */
  writeFile(path: string, text: string, exclusive: boolean): Promise<void>
  now?: () => Date
  system?: string[]
}

/** Window menu > Save conversation…: only the person's pick in the save dialog decides where a file is written. */
export function createConversationSaver(d: ConversationSaverDeps) {
  const system = d.system ?? systemFolders()
  return async function saveConversation(nodeId: string): Promise<SaveConversationResult> {
    const node = d.store.get().nodes.find((n) => n.id === nodeId)
    if (node?.kind !== 'claude') return { ok: false, reason: 'That window is not an agent.' }
    if (!node.transcriptPath) return { ok: false, reason: `${node.title} has no conversation yet.` }
    const messages = await d.read(node.transcriptPath).catch(() => null)
    if (!messages) return { ok: false, reason: `Couldn't read the conversation of ${node.title}.` }
    const kept = messages.filter((m) => m.text.trim())
    if (kept.length === 0) return { ok: false, reason: `${node.title} has no messages to save yet.` }
    const picked = await d.pickFile(join(node.cwd || d.home, handoffFileName(`${node.title} conversation`)))
    if (!picked) return { ok: false, cancelled: true, reason: 'Not saved.' }
    const check = checkDocPath(asMarkdownPath(picked), system)
    if (!check.ok) return { ok: false, reason: check.reason }
    // The dialog asked before replacing the name it gave. A name changed here wasn't asked about, so it never replaces.
    const changed = check.path.toLowerCase() !== resolve(picked).toLowerCase()
    try {
      await d.writeFile(check.path, conversationMarkdown(node, kept, (d.now ?? (() => new Date()))()), changed)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: `${basename(check.path)} already exists. Save again and pick another name.` }
      return { ok: false, reason: `The conversation couldn't be saved: ${(e as Error).message}` }
    }
    return { ok: true, path: check.path, messages: kept.length }
  }
}

export type RevealTranscriptResult = { ok: true } | { ok: false; reason: string }

/** Window menu > Reveal transcript: the agent's own .jsonl, selected in Explorer. */
export function revealTranscript(store: CanvasStore, nodeId: string, reveal: (path: string) => void, exists: (path: string) => boolean): RevealTranscriptResult {
  const node = store.get().nodes.find((n) => n.id === nodeId)
  if (node?.kind !== 'claude') return { ok: false, reason: 'That window is not an agent.' }
  if (!node.transcriptPath) return { ok: false, reason: `${node.title} has no conversation yet.` }
  if (!exists(node.transcriptPath)) return { ok: false, reason: `The transcript of ${node.title} is no longer on disk.` }
  reveal(node.transcriptPath)
  return { ok: true }
}
