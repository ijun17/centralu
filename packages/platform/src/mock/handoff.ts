import { isInTurn, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentPort } from '../ports/index.js'
import type { SessionStore } from './session-store.js'

/** Handoff notes and records (#78, #102, #142), written to the host's data folder rather than the project */
export class HandoffMock {
  /** The handoff note placed in the host's data folder (#142) — path → text. Not mixed with project files (fsState) */
  handoffNotes = new Map<string, string>()

  private placeHandoffNote(s: SessionInfo, text: string): string {
    const path = `/mock-data/handoff/${s.projectId}/${s.id}.md`
    this.handoffNotes.set(path, text)
    return path
  }
  readonly agents: Pick<AgentPort, 'exportHandoffRecord' | 'exportHandoffNote'> = {
    /**
     * A dead-agent handoff record (#78) — gives deterministic text carrying the session name,
     * like the real thing. **Placed in the notes location**, like the real thing (#102, #142):
     * the two modes converging on one location is the contract of this feature. The location
     * is the host's data folder, so it is not placed in the mock's project files (fsState).
     */
    exportHandoffRecord: async (sessionId: string, toTool?: ToolName) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      const text = `# CentralU Handoff Record (automatic)\n\npredecessor "${s.name}" (${s.tool}${toTool ? ` → ${toTool}` : ''}) — mock record for ${sessionId}`
      return { text, path: this.placeHandoffNote(s, text) }
    },
    /**
     * The note for a live handoff (#142) — the same rule as the real thing: the first human
     * message after afterSeq is the request, and the note is the **last** assistant message
     * before the next human message. The mock also gathers a message into one row (emit), so
     * the last row is exactly the last message.
     */
    exportHandoffNote: async (sessionId: string, afterSeq: number) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
      if (isInTurn(s.state)) return null
      let note = ''
      let asked = false
      for (const r of this.store.messages.get(sessionId) ?? []) {
        if (r.seq <= afterSeq) continue
        if (r.role === 'user') {
          if (asked) break
          asked = true
          continue
        }
        if (asked && r.role === 'assistant' && r.kind === 'text') note = (r.payload as { text?: string }).text ?? ''
      }
      note = note.trim()
      return note ? { text: note, path: this.placeHandoffNote(s, note) } : null
    },
  }

  constructor(
    private readonly store: SessionStore,
  ) {}
}
