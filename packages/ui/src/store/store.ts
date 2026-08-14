import { create } from 'zustand'
import type { NormalizedEvent, ProjectInfo, SessionInfo, StoredMessage } from '@cc/protocol'
import {
  applyEvent,
  archive as archiveSession,
  bumpSeq,
  initialSession,
  markRead as markReadPure,
  rename as renamePure,
  type SessionSummary,
} from '@cc/core'
import type { ConnectionState, Platform } from '@cc/platform/ports'

/**
 * 스토어는 배선만 한다 — 상태 변경 로직은 전부 core (docs/state-management.md §2).
 * 명령은 포트로, 상태 갱신은 이벤트 → core 리듀서로만 (CQRS-lite: 낙관적 갱신 없음).
 */

export type Tab = 'chat' | 'files' | 'git' | 'viewer'

export type ChatItem =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'tool'; seq: number; tool: string; title: string; readOnly: boolean; result?: string; ok?: boolean }
  | { kind: 'approval'; seq: number; requestId: string; summary: string; decision?: string }

export type AppState = {
  platform: Platform | null
  connection: ConnectionState
  projects: Record<string, ProjectInfo>
  sessions: Record<string, SessionSummary>
  chat: Record<string, ChatItem[]>
  focusedSessionId: string | null
  tab: Tab
  inboxOpen: boolean
  toast: string | null

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  focusSession(id: string | null): void
  setTab(t: Tab): void
  toggleInbox(open?: boolean): void
  setToast(msg: string | null): void

  addProject(path: string): Promise<ProjectInfo>
  createSession(projectId: string, opts?: { initialPrompt?: string }): Promise<SessionInfo>
  send(sessionId: string, text: string): Promise<void>
  respondApproval(sessionId: string, requestId: string, decision: 'allow' | 'deny' | 'always', scope?: 'session' | 'project'): Promise<void>
  interrupt(sessionId: string): Promise<void>
  archive(sessionId: string): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
}

let chatSeq = 0

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  projects: {},
  sessions: {},
  chat: {},
  focusedSessionId: null,
  tab: 'chat',
  inboxOpen: false,
  toast: null,

  async attach(platform) {
    set({ platform })
    platform.agents.subscribe((e) => get().dispatchEvent(e))
    platform.agents.onConnectionChange((connection) => set({ connection }))

    const [projects, sessions] = await Promise.all([platform.projects.list(), platform.agents.listSessions()])
    set({
      projects: Object.fromEntries(projects.map((p) => [p.id, p])),
      sessions: Object.fromEntries(
        sessions.map((s) => [
          s.id,
          {
            ...initialSession({ id: s.id, projectId: s.projectId, name: s.name }),
            autoNamed: s.autoNamed, state: s.state, archived: s.archived,
            lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq, waitingSince: s.waitingSince,
          },
        ]),
      ),
      connection: 'connected',
    })
  },

  dispatchEvent(e) {
    const sessionId = e.sessionId
    if (!sessionId) return
    const cur = get().sessions[sessionId]
    if (!cur) return

    const next = applyEvent(cur, e, Date.now())
    const chat = appendChat(get().chat[sessionId] ?? [], e)
    const withSeq = chat.length > 0 ? bumpSeq(next, chat[chat.length - 1]!.seq) : next

    set((st) => ({
      sessions: { ...st.sessions, [sessionId]: withSeq },
      chat: { ...st.chat, [sessionId]: chat },
    }))
  },

  focusSession(id) {
    set({ focusedSessionId: id, tab: 'chat' })
    if (id) void get().markRead(id)
  },
  setTab(tab) {
    set({ tab })
  },
  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },
  setToast(toast) {
    set({ toast })
  },

  async addProject(path) {
    const p = await get().platform!.projects.add(path)
    set((s) => ({ projects: { ...s.projects, [p.id]: p } }))
    return p
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const info = await platform.agents.createSession({
      projectId, cwd: project.path, tool: project.defaultTool,
      permissionPreset: 'normal', initialPrompt: opts?.initialPrompt,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: initialSession({ id: info.id, projectId, name: info.name }),
      },
      focusedSessionId: info.id,
    }))
    return info
  },

  async send(sessionId, text) {
    const seq = ++chatSeq
    set((s) => ({
      chat: { ...s.chat, [sessionId]: [...(s.chat[sessionId] ?? []), { kind: 'user', seq, text }] },
    }))
    await get().platform!.agents.send(sessionId, text)
  },

  async respondApproval(sessionId, requestId, decision, scope) {
    await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope)
  },

  async interrupt(sessionId) {
    await get().platform!.agents.interrupt(sessionId)
  },

  async archive(sessionId) {
    await get().platform!.agents.archiveSession(sessionId)
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: archiveSession(s.sessions[sessionId]!) },
      focusedSessionId: s.focusedSessionId === sessionId ? null : s.focusedSessionId,
    }))
  },

  async rename(sessionId, name) {
    await get().platform!.agents.rename(sessionId, name)
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: renamePure(s.sessions[sessionId]!, name) } }))
  },

  async markRead(sessionId) {
    const s = get().sessions[sessionId]
    if (!s || s.lastReadSeq >= s.lastSeq) return
    await get().platform!.agents.markRead(sessionId, s.lastSeq)
    set((st) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(st.sessions[sessionId]!, s.lastSeq) } }))
  },
}))

/** 이벤트를 대화 아이템으로 (스트리밍 델타는 마지막 assistant 항목에 append) */
function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {
  switch (e.type) {
    case 'message_delta': {
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') {
        const copy = items.slice(0, -1)
        return [...copy, { ...last, text: last.text + e.text }]
      }
      return [...items, { kind: 'assistant', seq: ++chatSeq, text: e.text }]
    }
    case 'tool_call':
      return [...items, { kind: 'tool', seq: ++chatSeq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly }]
    case 'tool_result': {
      const idx = [...items].reverse().findIndex((i) => i.kind === 'tool' && i.result === undefined)
      if (idx === -1) return items
      const real = items.length - 1 - idx
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      return items.map((it, i) => (i === real ? { ...target, result: e.summary, ok: e.ok } : it))
    }
    case 'approval_request':
      return [
        ...items,
        {
          kind: 'approval', seq: ++chatSeq, requestId: e.requestId,
          summary: e.detail.kind === 'command' ? e.detail.command : e.detail.kind === 'file_edit' ? e.detail.path : e.detail.raw,
        },
      ]
    case 'approval_resolved':
      return items.map((it) => (it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it))
    default:
      return items
  }
}

/** 메시지 복원 (재시작·세션 전환 시) */
export function messagesToChat(msgs: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of msgs) {
    if (m.kind === 'text' && m.role === 'user') {
      items.push({ kind: 'user', seq: m.seq, text: String((m.payload as { text?: string })?.text ?? '') })
    } else if (m.kind === 'text') {
      const e = m.payload as { text?: string }
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') last.text += e.text ?? ''
      else items.push({ kind: 'assistant', seq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary) items.push({ kind: 'tool', seq: m.seq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly })
    }
  }
  return items
}
