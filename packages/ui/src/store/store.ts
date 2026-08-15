import { create } from 'zustand'
import type { Attachment, NormalizedEvent, PermissionPreset, ProjectInfo, SessionInfo, StoredMessage, ToolName } from '@cc/protocol'
import {
  allDoneNotification,
  applyEvent,
  archive as archiveSession,
  badgeCount,
  countWaiting,
  notificationFor,
  suggestMatcher,
  DEFAULT_NOTIFY_POLICY,
  type NotifyPolicy,
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
  /** 깃·파일·뷰어는 프로젝트의 것이다 — 세션 없이도 봐야 한다 */
  focusedProjectId: string | null
  tab: Tab
  inboxOpen: boolean
  toast: string | null
  appFocused: boolean
  /** 코드 뷰어가 보고 있는 파일 (프로젝트 상대 경로) */
  viewerPath: string | null
  paletteOpen: boolean
  settingsOpen: boolean
  notifyPolicy: NotifyPolicy

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  focusSession(id: string | null): void
  focusProject(id: string): void
  setAppFocused(focused: boolean): void
  loadHistory(sessionId: string): Promise<void>
  saveWorkspace(): void
  setTab(t: Tab): void
  /** 파일을 뷰어 탭에서 연다 (파일 트리·깃 패널의 공통 진입점) */
  openFile(path: string): void
  toggleInbox(open?: boolean): void
  togglePalette(open?: boolean): void
  toggleSettings(open?: boolean): void
  setNotifyPolicy(p: NotifyPolicy): void
  setToast(msg: string | null): void

  addProject(path: string): Promise<ProjectInfo>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** 도구가 갖고 있던 이전 세션을 이어받는다 (터미널에서 만든 대화 포함) */
      resumeExternalId?: string
      importHistory?: boolean
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<Attachment | null>
  respondApproval(sessionId: string, requestId: string, decision: 'allow' | 'deny' | 'always', scope?: 'session' | 'project'): Promise<void>
  interrupt(sessionId: string): Promise<void>
  archive(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
}

let chatSeq = 0

/** 비포커스 세션이 유지하는 최근 메시지 수 — 다시 열면 저장소에서 더 불러온다 */
const WINDOW_SIZE = 50

/** 아직 스토어에 등록되지 않은 세션의 이벤트 보관함 (등록 직후 재생) */
const pendingEvents = new Map<string, NormalizedEvent[]>()

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  projects: {},
  sessions: {},
  chat: {},
  focusedSessionId: null,
  focusedProjectId: null,
  tab: 'chat',
  inboxOpen: false,
  toast: null,
  appFocused: true,
  viewerPath: null,
  paletteOpen: false,
  settingsOpen: false,
  notifyPolicy: DEFAULT_NOTIFY_POLICY,

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
            autoNamed: s.autoNamed, state: s.state, archived: s.archived, live: s.live,
            lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq, waitingSince: s.waitingSince,
          },
        ]),
      ),
      connection: 'connected',
    })

    // 보던 자리로 돌아온다 (C-3). 없거나 사라진 세션이면 조용히 무시한다.
    try {
      const snap = await platform.workspace.load()
      if (snap?.focusedSessionId && get().sessions[snap.focusedSessionId]) {
        get().focusSession(snap.focusedSessionId)
        // 보던 탭까지 돌아온다 (B-0)
        if (snap.tab) set({ tab: snap.tab as Tab })
        const savedPolicy = (snap as { notifyPolicy?: NotifyPolicy }).notifyPolicy
        if (savedPolicy) set({ notifyPolicy: savedPolicy })
      }
    } catch {
      /* 스냅샷이 없어도 앱은 정상 동작한다 */
    }
  },

  /** 상태가 바뀔 때마다 저장한다 — '종료 시 저장'은 크래시에 무력하다 */
  saveWorkspace() {
    const s = get()
    void s.platform?.workspace.save({ focusedSessionId: s.focusedSessionId, tab: s.tab }).catch(() => {})
  },

  setAppFocused(focused) {
    set({ appFocused: focused })
  },

  dispatchEvent(e) {
    const sessionId = e.sessionId
    if (!sessionId) return

    // 삭제는 세션이 사라지는 것이므로 리듀서를 태우지 않는다
    if (e.type === 'session_deleted') {
      set((s) => {
        const sessions = { ...s.sessions }
        const chat = { ...s.chat }
        delete sessions[sessionId]
        delete chat[sessionId]
        return {
          sessions,
          chat,
          focusedSessionId: s.focusedSessionId === sessionId ? null : s.focusedSessionId,
        }
      })
      return
    }

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

      const ctx = { appFocused: st.appFocused, policy: st.notifyPolicy }
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

  /** 프로젝트만 선택 — 세션을 고르지 않아도 깃·파일·뷰어를 볼 수 있다 */
  focusProject(id) {
    set((s) => ({
      focusedProjectId: id,
      // 다른 프로젝트를 고르면 세션 포커스는 놓는다 (섞이면 어느 프로젝트를 보는지 헷갈린다)
      focusedSessionId: s.sessions[s.focusedSessionId ?? '']?.projectId === id ? s.focusedSessionId : null,
      viewerPath: null,
    }))
    get().saveWorkspace()
  },

  focusSession(id) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    set({ focusedSessionId: id, tab: 'chat', ...(projectId ? { focusedProjectId: projectId } : {}) })
    get().saveWorkspace()

    // 포커스를 벗어난 세션의 메시지는 잘라낸다 (docs/state-management.md §4).
    // 세션 10개 × 수백 턴을 전부 들고 있으면 §7.1 메모리 목표를 지킬 수 없다.
    // 요약(상태·안읽음·미리보기)은 그대로 남으므로 사이드바·인박스는 정확하다.
    if (prev && prev !== id) {
      const items = get().chat[prev]
      if (items && items.length > WINDOW_SIZE) {
        set((s) => ({ chat: { ...s.chat, [prev]: items.slice(-WINDOW_SIZE) } }))
      }
    }

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
    get().saveWorkspace()
  },

  openFile(path) {
    set({ viewerPath: path, tab: 'viewer' })
    get().saveWorkspace()
  },
  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },
  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen }))
  },
  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },
  setNotifyPolicy(notifyPolicy) {
    set({ notifyPolicy })
    // 정책은 워크스페이스 스냅샷에 함께 실린다 (E-5)
    void get().platform?.workspace.save({
      focusedSessionId: get().focusedSessionId,
      tab: get().tab,
      notifyPolicy,
    } as never).catch(() => {})
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
      projectId,
      cwd: project.path,
      // 고른 값이 그대로 host까지 간다 — 예전엔 프리셋이 'normal' 고정이고 모델은 전달조차 되지 않았다
      tool: opts?.tool ?? project.defaultTool,
      model: opts?.model ?? project.defaultModel,
      permissionPreset: opts?.permissionPreset ?? 'normal',
      initialPrompt: opts?.initialPrompt,
      resumeExternalId: opts?.resumeExternalId,
      importHistory: opts?.importHistory,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: { ...initialSession({ id: info.id, projectId, name: info.name }), lastSeq: info.lastSeq, lastReadSeq: info.lastReadSeq },
      },
      // 시작 프롬프트도 내가 한 말이다 — 대화창에 보여야 한다 (E2E가 잡은 누락)
      chat: opts?.initialPrompt
        ? { ...s.chat, [info.id]: [{ kind: 'user', seq: ++chatSeq, text: opts.initialPrompt }] }
        : s.chat,
      focusedSessionId: info.id,
    }))

    // 불러온 세션은 host에 이미 이전 대화가 쌓여 있다 — 화면으로 끌어온다
    if (opts?.importHistory && opts.resumeExternalId) {
      const msgs = await platform.agents.loadMessages(info.id)
      if (msgs.length > 0) {
        const restored = messagesToChat(msgs)
        chatSeq = Math.max(chatSeq, ...restored.map((c) => c.seq))
        set((s) => ({ chat: { ...s.chat, [info.id]: restored } }))
      }
    }

    // 등록 전에 도착해 보관해 둔 이벤트를 순서대로 재생한다
    const buffered = pendingEvents.get(info.id)
    if (buffered) {
      pendingEvents.delete(info.id)
      for (const e of buffered) get().dispatchEvent(e)
    }
    return info
  },

  /** 붙여넣기·드래그로 들어온 파일을 host에 저장하고 첨부 정보를 받는다 (FR-13) */
  async attachFile(sessionId, file) {
    const platform = get().platform
    if (!platform) return null
    try {
      const buf = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
      return await platform.agents.saveAttachment(sessionId, file.name, file.type || 'application/octet-stream', btoa(binary))
    } catch (e) {
      set({ toast: `첨부하지 못했습니다: ${(e as Error).message}` })
      return null
    }
  },

  async send(sessionId, text, attachments) {
    const seq = ++chatSeq
    const label = attachments?.length ? `${text}${text ? '\n' : ''}📎 ${attachments.map((a) => a.name).join(', ')}` : text
    set((s) => ({
      chat: { ...s.chat, [sessionId]: [...(s.chat[sessionId] ?? []), { kind: 'user', seq, text: label }] },
    }))
    try {
      await get().platform!.agents.send(sessionId, text, attachments)
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

  async resumeSession(sessionId) {
    const platform = get().platform
    if (!platform) return false
    try {
      const res = await platform.agents.resumeSession(sessionId)
      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: res.resumed } },
        toast: res.resumed ? null : `이어갈 수 없습니다: ${res.reason ?? '알 수 없는 이유'}`,
      }))
      return res.resumed
    } catch (err) {
      set({ toast: `이어갈 수 없습니다: ${(err as Error).message}` })
      return false
    }
  },

  async respondApproval(sessionId, requestId, decision, scope) {
    // '항상 허용'의 패턴은 core가 계산한다 (host는 core를 모르므로 여기서 실어 보낸다)
    const pending = get().sessions[sessionId]?.pendingApproval
    const matcher =
      decision === 'always' && pending
        ? pending.detail.kind === 'command'
          ? suggestMatcher(pending.detail.command)
          : pending.detail.kind === 'file_edit'
            ? pending.detail.path
            : undefined
        : undefined
    await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
  },

  async interrupt(sessionId) {
    await get().platform!.agents.interrupt(sessionId)
  },

  /** 세션 완전 삭제. 되돌릴 수 없으므로 호출 전에 확인을 받는다 (UI 책임) */
  async deleteSession(sessionId) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? '세션'
    try {
      await platform.agents.deleteSession(sessionId)
      set({ toast: `삭제했습니다: ${name}` })
    } catch (e) {
      set({ toast: `삭제하지 못했습니다: ${(e as Error).message}` })
    }
  },

  async updateSessionSettings(sessionId, s) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.updateSettings(sessionId, s)
      set((st) => ({
        sessions: {
          ...st.sessions,
          [sessionId]: { ...st.sessions[sessionId]!, model: info.model, permissionPreset: info.permissionPreset },
        },
      }))
      set({ toast: s.model !== undefined ? `모델: ${info.model ?? '기본'} (다음 턴부터)` : `권한: ${info.permissionPreset}` })
    } catch (e) {
      set({ toast: `설정을 바꾸지 못했습니다: ${(e as Error).message}` })
    }
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
