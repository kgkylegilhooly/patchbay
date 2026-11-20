import { open, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { foldCodexChild } from '../../core/subagents/codexChild'
import { emptyProgress, type Progress } from '../../core/subagents/parse'
import { AGENT_ID, type SubagentCard, type SubagentSnapshot } from '../../shared/subagents'

/**
 * Subagent cards for Codex windows, from Codex 0.170's SubagentStart and SubagentStop hooks, as Claude's come from
 * the files Claude Code writes. SubagentStart says only which agent and of what kind; SubagentStop adds where its
 * rollout is, which is then read for its tool count, tokens, prompt and any error. While it runs, its rollout is
 * looked for beside the parent's, by the agent id in the file name (UNVERIFIED: that the hook's agent_id is the
 * child thread id Codex names the file after; if not, a running card shows no tool count until it stops).
 * Memory only, like Claude's cards. See docs/plans/followups-integration.md.
 */

interface Card {
  id: string
  parentId: string
  agentType: string
  status: SubagentCard['status']
  failure?: string
  startedAt: number
  endedAt?: number
  transcript: string | null
  offset: number
  progress: Progress
  /** The parent's turn it belongs to. */
  turn: number
  /** Stopped, and its rollout read to the end since. */
  final?: boolean
}

/** A running card whose window has been idle and that has said nothing for this long has gone without saying so. */
const STALE_MS = 11 * 60_000
const MAX_READ = 4 * 1024 * 1024
const PER_PARENT = 50

/**
 * Whether a subagent rollout a hook names may be read and shown: a .jsonl file under the parent rollout's Codex
 * sessions folder (`sessions/YYYY/MM/DD/` above it), or beside it when the parent isn't in such a tree. Anything
 * holding the window's hook environment could name another file, so nothing else is read.
 */
export function allowedChildRollout(parentTranscript: string | null, path: string): boolean {
  if (!parentTranscript || !isAbsolute(path) || !/\.jsonl$/i.test(path)) return false
  const day = dirname(resolve(parentTranscript))
  const parts = day.split(/[\\/]/)
  const dated = parts.length > 3 && /^\d{4}$/.test(parts.at(-3)!) && /^\d{2}$/.test(parts.at(-2)!) && /^\d{2}$/.test(parts.at(-1)!)
  const root = dated ? dirname(dirname(dirname(day))) : day
  const rel = relative(root, resolve(path))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface CodexCards {
  /** A Codex window's hook. Only SubagentStart and SubagentStop do anything. */
  noteHook(nodeId: string, payload: Record<string, unknown>, parentTranscript: string | null): void
  /** The window began a new turn: finished cards from before stop counting. */
  turnStarted(nodeId: string): void
  /** Reads what running agents have added, and settles those whose window ended or went quiet. */
  refresh(parents: { nodeId: string; transcriptPath: string | null; busy: boolean; exited: boolean }[]): Promise<void>
  snapshot(): SubagentSnapshot
  /** The rollout of one card, for the transcript viewer. */
  transcriptOf(nodeId: string, agentId: string): string | null
}

export function createCodexCards(opts: { now?: () => number; log?(line: string): void } = {}): CodexCards {
  const now = opts.now ?? Date.now
  const byParent = new Map<string, { turn: number; cards: Map<string, Card> }>()
  const parentOf = (nodeId: string) => {
    let p = byParent.get(nodeId)
    if (!p) {
      p = { turn: 0, cards: new Map() }
      byParent.set(nodeId, p)
    }
    return p
  }
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')

  const follow = async (c: Card): Promise<void> => {
    if (!c.transcript) return
    const size = (await stat(c.transcript)).size
    if (size < c.offset) {
      c.offset = 0
      c.progress = emptyProgress()
    }
    if (size === c.offset) return
    const handle = await open(c.transcript, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(size - c.offset, MAX_READ))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, c.offset)
      const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
      if (end === 0) {
        if (bytesRead === MAX_READ) c.offset += bytesRead
        return
      }
      c.progress = foldCodexChild(c.progress, buffer.subarray(0, end).toString('utf8'))
      c.offset += end
    } finally {
      await handle.close()
    }
  }

  /** Where Codex wrote a running child, if it named the file after the agent id, beside the parent's rollout. */
  const find = async (parentTranscript: string, agentId: string): Promise<string | null> => {
    const dir = dirname(parentTranscript)
    const names = await readdir(dir).catch(() => [] as string[])
    const name = names.find((n) => n.endsWith(`-${agentId}.jsonl`))
    return name ? join(dir, name) : null
  }
  const parentTranscripts = new Map<string, string>()

  return {
    noteHook(nodeId, payload, parentTranscript) {
      const name = payload.hook_event_name
      if (name !== 'SubagentStart' && name !== 'SubagentStop') return
      const id = text(payload.agent_id)
      if (!AGENT_ID.test(id)) return
      if (parentTranscript) parentTranscripts.set(nodeId, parentTranscript)
      const p = parentOf(nodeId)
      let card = p.cards.get(id)
      if (!card) {
        card = { id, parentId: nodeId, agentType: text(payload.agent_type).slice(0, 60) || 'agent', status: 'running', startedAt: now(), transcript: null, offset: 0, progress: emptyProgress(), turn: p.turn }
        p.cards.set(id, card)
        if (p.cards.size > PER_PARENT) {
          const oldest = [...p.cards.values()].filter((c) => c.status !== 'running').sort((a, b) => a.startedAt - b.startedAt)[0]
          if (oldest) p.cards.delete(oldest.id)
        }
      }
      if (name === 'SubagentStop') {
        const path = text(payload.agent_transcript_path)
        if (path && allowedChildRollout(parentTranscript ?? parentTranscripts.get(nodeId) ?? null, path)) card.transcript = path
        card.status = 'done'
        card.endedAt = now()
      }
    },
    turnStarted(nodeId) {
      const p = byParent.get(nodeId)
      if (!p) return
      p.turn++
      for (const [id, c] of p.cards) {
        if (c.status === 'running') c.turn = p.turn
        else p.cards.delete(id)
      }
    },
    async refresh(parents) {
      const seen = new Set(parents.map((x) => x.nodeId))
      for (const id of [...byParent.keys()]) if (!seen.has(id)) byParent.delete(id)
      for (const w of parents) {
        const p = byParent.get(w.nodeId)
        if (!p) continue
        if (w.transcriptPath) parentTranscripts.set(w.nodeId, w.transcriptPath)
        for (const c of p.cards.values()) {
          try {
            if (c.status === 'running' && !c.transcript && parentTranscripts.get(w.nodeId)) c.transcript = await find(parentTranscripts.get(w.nodeId)!, c.id)
            // A stopped card is read once more, to its end, so its counts and error are final.
            if (c.status === 'running' || !c.final) {
              const stopped = c.status !== 'running'
              await follow(c)
              if (stopped) c.final = true
            }
          } catch (e) {
            opts.log?.(`Codex subagent ${c.id} couldn't be read: ${(e as Error).message}`)
          }
          if (c.status === 'done' && c.progress.error && !c.failure) {
            c.status = 'failed'
            c.failure = c.progress.error
          }
          if (c.status !== 'running') continue
          if (w.exited) {
            c.status = 'failed'
            c.failure = 'The session ended'
            c.endedAt = now()
          } else if (!w.busy && now() - (c.progress.lastAt ?? c.startedAt) > STALE_MS) {
            c.status = 'failed'
            c.failure = 'No longer running'
            c.endedAt = now()
          }
        }
      }
    },
    snapshot() {
      const out: SubagentSnapshot = {}
      for (const [nodeId, p] of byParent) {
        const cards: SubagentCard[] = [...p.cards.values()]
          .filter((c) => c.turn === p.turn)
          .map((c) => ({
            id: c.id,
            parentId: nodeId,
            agentType: c.agentType,
            description: c.progress.prompt || c.agentType,
            status: c.status,
            ...(c.failure ? { failure: c.failure } : {}),
            startedAt: c.progress.startedAt ?? c.startedAt,
            ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
            tools: c.progress.tools,
            ...(c.progress.tokens !== undefined ? { tokens: c.progress.tokens } : {}),
            depth: 1
          }))
          .sort((x, y) => x.startedAt - y.startedAt)
        if (cards.length) out[nodeId] = { ran: cards.length, cards }
      }
      return out
    },
    transcriptOf(nodeId, agentId) {
      return byParent.get(nodeId)?.cards.get(agentId)?.transcript ?? null
    }
  }
}
