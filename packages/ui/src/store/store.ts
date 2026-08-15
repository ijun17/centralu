import { create } from 'zustand'
import type { NormalizedEvent, ProjectInfo, SessionInfo, StoredMessage } from '@cc/protocol'
import {
  allDoneNotification,
  applyEvent,
  archive as archiveSession,
  badgeCount,
  countWaiting,
  notificationFor,
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
  appFocused: boolean

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  focusSession(id: string | null): void
  setAppFocused(focused: boolean): void
  loadHistory(sessionId: string): Promise<void>
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

/** 아직 스토어에 등록되지 않은 세션의 이벤트 보관함 (등록 직후 재생) */
const pendingEvents = new Map<string, NormalizedEvent[]>()

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
  appFocused: true,

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

  setAppFocused(focused) {
    set({ appFocused: focused })
  },

  dispatchEvent(e) {
    const sessionId = e.sessionId
    if (!sessionId) return
    const cur = get().sessions[sessionId]
    if (!cur) {
      // 세션 등록 전에 도착한 이벤트 (초기 프롬프트가 곧바로 스트리밍되는 경우).
      // 버리면 첫 턴이 통째로 사라지므로 보관했다가 등록 직후 재생한다.
      pendingEvents.set(sessionId, [...(pendingEvents.get(sessionId) ?? []), e])
      return
    }

    const next = applyEvent(cur, e, Date.now())
    const chat = appendChat(get().chat[sessionId] ?? [], e)
    const withSeq = chat.length > 0 ? bumpSeq(next, chat[chat.length - 1]!.seq) : next

    set((st) => ({
      sessions: { ...st.sessions, [sessionId]: withSeq },
      chat: { ...st.chat, [sessionId]: chat },
    }))

    // 상태가 바뀌었을 때만 알림을 판정한다 (판정은 core, 전달은 system 포트)
    if (withSeq.state !== cur.state) {
      const st = get()
      const platform = st.platform
      if (!platform) return

      const ctx = { appFocused: st.appFocused }
      const after = Object.values(st.sessions)
      const before = after.map((x) => (x.id === sessionId ? cur : x))

      const one = notificationFor({ id: sessionId, name: withSeq.name, state: withSeq.state }, cur.state, ctx)
      const all = allDoneNotification(after, before, ctx)
      // 개별 알림이 있으면 그것만 — 같은 순간에 두 번 울리지 않는다
      const notice = one ?? all
      if (notice) void platform.system.notify(notice.title, notice.body)
      void platform.system.setBadge(badgeCount(countWaiting(after)))
    }
  },

  focusSession(id) {
    set({ focusedSessionId: id, tab: 'chat' })
    if (!id) return
    void get().markRead(id)
    // 아직 안 읽어온 세션이면 저장된 대화를 불러온다 (host 재시작 후에도 기록은 남는다)
    if (!get().chat[id]) void get().loadHistory(id)
  },

  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    try {
      const msgs = await platform.agents.loadMessages(sessionId)
      const items = messagesToChat(msgs)
      set((s) => ({ chat: { ...s.chat, [sessionId]: s.chat[sessionId] ?? items } }))
    } catch {
      // 기록을 못 불러와도 새 대화는 가능하므로 조용히 넘어간다
    }
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

    // 등록 전에 도착해 보관해 둔 이벤트를 순서대로 재생한다
    const buffered = pendingEvents.get(info.id)
    if (buffered) {
      pendingEvents.delete(info.id)
      for (const e of buffered) get().dispatchEvent(e)
    }
    return info
  },

  async send(sessionId, text) {
    const seq = ++chatSeq
    set((s) => ({
      chat: { ...s.chat, [sessionId]: [...(s.chat[sessionId] ?? []), { kind: 'user', seq, text }] },
    }))
    try {
      await get().platform!.agents.send(sessionId, text)
    } catch (err) {
      // 전송 실패를 조용히 삼키면 사용자는 답을 기다리며 계속 서 있게 된다.
      // 보낸 것처럼 남은 말풍선을 걷어내고 무엇을 해야 하는지 알린다.
      set((s) => ({
        chat: { ...s.chat, [sessionId]: (s.chat[sessionId] ?? []).filter((i) => i.seq !== seq) },
      }))
      const e = err as Error & { code?: string }
      set({
        toast:
          e.code === 'session_not_found'
            ? '이 세션은 더 이상 실행 중이 아닙니다. 기록은 남아 있으니 새 세션을 시작하세요.'
            : `보내지 못했습니다: ${e.message}`,
      })
    }
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
