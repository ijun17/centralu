import { isInTurn, isRecord, type SessionInfo, type ToolName } from '@cc/protocol/client'
import type { AgentPort } from '../ports/index.js'
import type { SessionStore } from './session-store.js'
import { mockError } from './mock-error.js'

/** Handoff notes and records (#78, #102, #142), written to the host's data folder rather than the project */
export class HandoffMock {
  /** Path → text, kept apart from the project files (#142) */
  handoffNotes = new Map<string, string>()

  private placeHandoffNote(s: SessionInfo, text: string): string {
    const path = `/mock-data/handoff/${s.projectId}/${s.id}.md`
    this.handoffNotes.set(path, text)
    return path
  }
  readonly agents: Pick<AgentPort, 'exportHandoffRecord' | 'exportHandoffNote'> = {
    /** Placed where notes go, as on the host: both modes landing in one place is the feature's contract (#102, #142) */
    exportHandoffRecord: async (sessionId: string, toTool?: ToolName) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError(`Session not found: ${sessionId}`, 'session_not_found')
      const text = `# CentralU Handoff Record (automatic)\n\npredecessor "${s.name}" (${s.tool}${toTool ? ` → ${toTool}` : ''}) — mock record for ${sessionId}`
      return { text, path: this.placeHandoffNote(s, text) }
    },
    /**
     * As the host (#142): the first human message after afterSeq is the request; the note is the last assistant
     * message before the next one. The mock's emit keeps a message in one row, so the last row is that message.
     */
    exportHandoffNote: async (sessionId: string, afterSeq: number) => {
      const s = this.store.sessions.get(sessionId)
      if (!s) throw mockError(`Session not found: ${sessionId}`, 'session_not_found')
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
        if (asked && r.role === 'assistant' && r.kind === 'text') note = isRecord(r.payload) && typeof r.payload.text === 'string' ? r.payload.text : ''
      }
      note = note.trim()
      return note ? { text: note, path: this.placeHandoffNote(s, note) } : null
    },
  }

  constructor(
    private readonly store: SessionStore,
  ) {}
}
