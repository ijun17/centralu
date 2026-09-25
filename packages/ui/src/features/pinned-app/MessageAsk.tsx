import { useMemo } from 'react'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useToolMeta } from '../../store/selectors.js'

/**
 * 고정 화면의 `ui/message` — 어느 세션으로 보낼지 사람에게 묻는다 (M4 B-4).
 *
 * 대화 안 화면의 말은 그 대화로 간다. 보낼 곳이 정해져 있다. 고정 화면에는 그런 대화가 없다. 앱이
 * 알아서 고르게 하면 화면(앱의 코드)이 사람 모르게 아무 세션에나 말을 넣을 수 있다. 그래서 **사람이
 * 고르기 전에는 아무것도 보내지 않는다.** 취소하면 화면은 거절을 받는다(보냈다고 믿지 않게).
 *
 * 보낼 글을 그대로 보여 준다. 사람이 그 글을 읽고 고르는 것이 이 확인의 전부다. 글이 아닌 조각
 * (이미지 등)은 보내지 않고 그렇다고 적는다. 목록은 이 앱의 프로젝트 세션이 먼저이고, 그다음이
 * 오케스트레이터와 다른 프로젝트의 세션이다. 사용자 폴더 앱은 프로젝트가 없으므로 오케스트레이터가
 * 먼저다(결정 4: 사용자 폴더 앱은 오케스트레이터의 것이다).
 */
export type MessageAskState = { text: string; dropped: number; resolve: (sent: boolean) => void }

export function MessageAsk({
  appTitle,
  projectId,
  ask,
  onAnswer,
}: {
  appTitle: string
  projectId: string | null
  ask: MessageAskState
  onAnswer: (sessionId: string | null) => void
}) {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const targets = useMemo(() => messageTargets(Object.values(sessions), projectId), [sessions, projectId])
  return (
    <div
      className="absolute inset-x-3 bottom-3 z-20 max-h-[70%] overflow-y-auto rounded-lg border border-edge bg-pit p-3 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      role="dialog"
      aria-label={`${appTitle} wants to send a message`}
      data-testid="pinned-message-ask"
    >
      <p className="text-[12px] text-chalk">{appTitle} wants to send this to a session:</p>
      <pre
        className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-edge bg-void px-2.5 py-2 font-sans text-[12px] text-ash"
        data-testid="pinned-message-text"
      >
        {ask.text}
      </pre>
      {ask.dropped > 0 && (
        <p className="mt-1 text-[11px] text-slate">
          {ask.dropped} non-text part{ask.dropped > 1 ? 's' : ''} will not be sent.
        </p>
      )}
      <p className="mt-3 text-[11px] text-slate">Send to</p>
      {targets.length === 0 ? (
        <p className="mt-1 text-[12px] text-ash">There is no session to send it to.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {targets.map((s) => (
            <li key={s.id}>
              <Target session={s} project={s.projectId ? projects[s.projectId]?.name : undefined} onPick={() => onAnswer(s.id)} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
          onClick={() => onAnswer(null)}
          data-testid="pinned-message-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Target({ session, project, onPick }: { session: SessionSummary; project: string | undefined; onPick: () => void }) {
  const meta = useToolMeta(session.tool)
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-ash transition-colors hover:bg-graphite/40 hover:text-chalk"
      onClick={onPick}
      data-testid={`pinned-message-to-${session.id}`}
    >
      <span className="readout flex size-[14px] shrink-0 items-center justify-center rounded-[3px] border border-graphite text-[9px] text-chalk">
        {meta.mark}
      </span>
      <span className="truncate">{session.kind === 'orchestrator' ? 'Orchestrator' : session.name}</span>
      {project && <span className="ml-auto shrink-0 truncate text-[10px] text-slate">{project}</span>}
    </button>
  )
}

/** 보낼 수 있는 세션, 가까운 것부터 — 이 앱의 프로젝트, 오케스트레이터, 나머지 */
export function messageTargets(all: SessionSummary[], projectId: string | null): SessionSummary[] {
  const rank = (s: SessionSummary) => {
    if (projectId && s.projectId === projectId) return 0
    if (s.kind === 'orchestrator') return 1
    return 2
  }
  return [...all].sort((a, b) => rank(a) - rank(b))
}

/** 화면이 보낸 조각에서 글만 — 나머지는 센다 */
export function messageText(content: unknown[]): { text: string; dropped: number } {
  const texts: string[] = []
  let dropped = 0
  for (const c of content) {
    const block = c as { type?: unknown; text?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else dropped++
  }
  return { text: texts.join('\n\n').trim(), dropped }
}
