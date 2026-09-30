import { useEffect, useState } from 'react'
// The document's shape is one set shared with the host half (M4 P-5) — it used to be written
// separately here and in agent-host's apps/control.ts, and the two disagreed on whether
// `notifies` was required.
import type { ControlDoc } from '@cc/protocol'
import {
  answerQuestion,
  focusSession,
  invokeAppTool,
  respondApproval,
  send,
  setAppState,
  useAppState,
  useInbox,
  useLastWords,
  useRunningTool,
  useSessionSummaries,
  type SessionSummary,
} from '../api.js'

/**
 * The control rail (#80) — the person's workbench.
 *
 * The person is one stage embedded in N pipelines: the agent runs a lap, the person's turn
 * comes up, they clear it quickly, and it moves on. What this rail optimizes for is the
 * throughput of the person's turn — arriving and hunting for context (scrolling) is the biggest
 * friction, so "what is needed" is written on the row first, and a one-line answer is finished
 * right there in the row.
 *
 * Top = action (my turn), bottom = background (running) — the reading order is the priority
 * order. The running section compresses the grid's monitoring purpose into a single line: a
 * session running under bypass never stops, so the moment to step in is read from the narration,
 * not from a waiting list.
 */

/**
 * A judgment counter (#80: "does anyone keep using this" is a number, not a feeling) — counts
 * inline replies made right in the row and entries made by opening the rail.
 *
 * A known race: this document is shared with the host, and both sides read the whole document,
 * modify it, and write the whole thing back. Whichever side writes later reverts the field the
 * earlier side wrote — if the UI writes from a stale copy, a notification or task the host added
 * in between disappears. Two spots where the window was seconds wide have been closed (#178):
 * host's control_create_task waits for the foreman and then re-reads the document, and the store
 * does not write over a document it has not read yet (at that point `doc` was null, so this
 * function overwrote the whole document with just `{ metrics }`). What remains is the
 * millisecond-wide window before a broadcast catches the copy up. Closing it fully would need
 * per-field updates or version comparison instead of a whole-document write.
 */
export function bumpMetric(doc: ControlDoc | null, key: 'inlineReplies' | 'railOpens'): void {
  const metrics = { ...(doc?.metrics ?? {}) }
  metrics[key] = (metrics[key] ?? 0) + 1
  setAppState('control', { ...(doc ?? {}), metrics })
}

export function ControlRail() {
  // Lets the waiting time (waitingMs) tick forward — 5 seconds is enough (it is a sense of time, not a stopwatch)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  const [creating, setCreating] = useState(false)
  const inbox = useInbox(now)
  const sessions = useSessionSummaries()
  const doc = useAppState<ControlDoc>('control')

  // Excludes the orchestrator (the resident conversation) and the foreman (the meta layer — the
  // Tasks section's job)
  const meta = (id: string) => sessions[id]?.kind === 'orchestrator' || sessions[id]?.kind === 'coordinator'
  const mine = inbox.filter((i) => !meta(i.id))
  const running = Object.values(sessions).filter((s) => s.state === 'working' && !meta(s.id))
  const tasks = doc?.tasks ?? []
  const notifies = [...(doc?.notifies ?? [])].sort(
    (a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || b.ts - a.ts,
  )

  const dismiss = (id: string) =>
    setAppState('control', { ...(doc ?? {}), notifies: (doc?.notifies ?? []).filter((n) => n.id !== id) })

  return (
    <aside
      // Width and border belong to the slot (AppRails) — the rail only fills in the content
      // (#81 ownership boundary)
      className="flex w-full min-w-0 flex-col overflow-y-auto bg-void"
      data-testid="control-rail"
    >
      {/* Things where the machine called out the person by name — calls that do not show up as session state (control_notify) */}
      {notifies.length > 0 && (
        <section className="border-b border-edge px-3 py-2">
          <h2 className="text-[10px] uppercase text-slate">Notices</h2>
          {notifies.map((n) => (
            <div key={n.id} className="mt-1.5 flex items-start gap-1.5" data-testid={`rail-notify-${n.id}`}>
              <p className={`min-w-0 flex-1 text-[11px] leading-snug ${n.priority === 'high' ? 'text-chalk' : 'text-ash'}`}>
                {n.text}
                {n.sessionId && sessions[n.sessionId] && (
                  <button
                    className="ml-1 text-[10px] text-slate underline-offset-2 hover:text-chalk hover:underline"
                    onClick={() => focusSession(n.sessionId!)}
                  >
                    {sessions[n.sessionId]!.name} →
                  </button>
                )}
              </p>
              <button
                className="shrink-0 text-[11px] text-slate hover:text-chalk"
                onClick={() => dismiss(n.id)}
                data-testid={`rail-notify-dismiss-${n.id}`}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      {/* My turn — action. In the exact order of the inbox's own judgment (@cc/core buildInbox) */}
      <section className="border-b border-edge px-3 py-2">
        <h2 className="text-[10px] uppercase text-slate">
          My turn {mine.length > 0 && <span className="text-chalk">{mine.length}</span>}
        </h2>
        {mine.length === 0 && <p className="mt-1.5 text-[11px] text-slate">Nothing needs you right now.</p>}
        {mine.map((item) => (
          <TurnRow key={item.id} id={item.id} waitingMs={item.waitingMs} unread={item.unread} s={sessions[item.id]} />
        ))}
      </section>

      {/* Tasks — a bundle of multiple sessions the foreman coordinates (#80 purpose 2). The
          person steps off the bus and into the referee's seat */}
      <section className="border-b border-edge px-3 py-2" data-testid="rail-tasks">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[10px] uppercase text-slate">Tasks {tasks.length > 0 && tasks.filter((t) => t.status === 'active').length}</h2>
          <button
            className="text-[10px] text-slate hover:text-chalk"
            onClick={() => setCreating(true)}
            data-testid="rail-new-task"
          >
            + New task
          </button>
        </div>
        {tasks
          .filter((t) => t.status === 'active')
          .map((t) => (
            <div key={t.id} className="mt-1.5" data-testid={`rail-task-${t.id}`}>
              <button
                className="block w-full text-left"
                onClick={() => focusSession(t.coordinatorId)}
                data-testid={`rail-task-open-${t.id}`}
              >
                <span className="block truncate text-[11px] text-ash">{t.title}</span>
                <span className="block truncate text-[10px] text-slate">
                  반장: {sessions[t.coordinatorId]?.state ?? 'gone'}
                </span>
              </button>
              {/*
                Members — the person sees the same view as the foreman (caught in dogfooding,
                2026-09-06: the number alone did not show which sessions this task involved).
                Pressing a chip goes to that session.
              */}
              <div className="mt-0.5 flex flex-wrap gap-1">
                {t.members.map((id) => (
                  <button
                    key={id}
                    onClick={() => focusSession(id)}
                    data-testid={`rail-task-member-${t.id}-${id}`}
                    title={sessions[id] ? `${sessions[id]!.name} — ${sessions[id]!.state}` : 'session gone'}
                    className="max-w-full truncate rounded border border-edge px-1 py-px text-[10px] text-slate transition-colors hover:border-graphite hover:text-chalk"
                  >
                    {sessions[id]?.name ?? '(gone)'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        {tasks.some((t) => t.status === 'done') && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] text-slate">Done {tasks.filter((t) => t.status === 'done').length}</summary>
            {tasks
              .filter((t) => t.status === 'done')
              .map((t) => (
                <button
                  key={t.id}
                  className="mt-1 block w-full truncate text-left text-[10px] text-slate hover:text-chalk"
                  onClick={() => focusSession(t.coordinatorId)}
                >
                  ✅ {t.title}
                </button>
              ))}
          </details>
        )}
      </section>

      {creating && <NewTaskDialog sessions={sessions} onClose={() => setCreating(false)} />}

      {/* Running — background. Compresses the grid's monitoring into one line per session */}
      <section className="px-3 py-2">
        <h2 className="text-[10px] uppercase text-slate">Running {running.length > 0 && running.length}</h2>
        {running.length === 0 && <p className="mt-1.5 text-[11px] text-slate">No sessions working.</p>}
        {running.map((s) => (
          <RunningRow key={s.id} s={s} />
        ))}
      </section>
    </aside>
  )
}

/**
 * A running row — the narration (speech) is authoritative, the tool is secondary (dogfooding,
 * 2026-09-05). Using preview alone lets a tool call overwrite the speech and leave only a line
 * like "pnpm verify" — the moment to step in is read from what the agent is thinking, not from a
 * tool name.
 */
function RunningRow({ s }: { s: SessionSummary }) {
  const words = useLastWords(s.id)
  const tool = useRunningTool(s.id)
  return (
    <button
      className="mt-1.5 block w-full text-left"
      onClick={() => focusSession(s.id)}
      data-testid={`rail-running-${s.id}`}
    >
      <span className="block truncate text-[11px] text-ash">{s.name}</span>
      <span className="block truncate text-[10px] leading-snug text-slate">{words ?? s.preview ?? '…'}</span>
      {tool && <span className="readout block truncate text-[9px] text-slate/70">{tool}</span>}
    </button>
  )
}

/** Seconds are noise — what a person reads is the sense of "just now / a few minutes / a while" */
function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

/**
 * A "my turn" row — "what is needed" comes first, and a one-line answer is finished right here.
 * If a deeper look is needed, press the name to go to that session (no new "peek" invented —
 * this is the existing focus view).
 */
function TurnRow({ id, waitingMs, unread, s }: { id: string; waitingMs: number; unread: boolean; s?: SessionSummary }) {
  const [text, setText] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  // Speech is authoritative, preview is the fallback for a session with no conversation loaded
  // (the same rule as RunningRow)
  const words = useLastWords(id)
  const doc = useAppState<ControlDoc>('control')
  if (!s) return null

  const approval = s.pendingApproval
  const question = s.pendingQuestions[0]?.questions[0]
  const questionReq = s.pendingQuestions[0]?.requestId

  return (
    <div className="mt-2" data-testid={`rail-turn-${id}`}>
      <button
        className="flex w-full items-baseline gap-1.5 text-left"
        onClick={() => {
          bumpMetric(doc, 'railOpens')
          focusSession(id)
        }}
      >
        <span className={`min-w-0 flex-1 truncate text-[11px] ${unread ? 'text-chalk' : 'text-ash'}`}>{s.name}</span>
        <span className="readout shrink-0 text-[9px] text-slate">{ago(waitingMs)}</span>
      </button>

      {approval && (
        <div className="mt-1">
          <p className="readout truncate text-[10px] text-slate">
            {approval.detail.kind === 'command'
              ? `$ ${approval.detail.command}`
              : approval.detail.kind === 'file_edit'
                ? approval.detail.path
                : approval.detail.kind === 'capability'
                  ? `${approval.detail.app.name} wants to ${approval.detail.text}`
                  : 'approval requested'}
          </p>
          {/* The diff is the material for a decision right here in the row — approving without
              opening the session requires seeing what actually changes */}
          {approval.detail.kind === 'file_edit' && showDiff && (
            <pre
              className="readout mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-1.5 text-[9px] leading-snug text-ash"
              data-testid={`rail-diff-${id}`}
            >
              {approval.detail.diffPreview}
            </pre>
          )}
          <div className="mt-1 flex gap-1.5">
            <button
              className="rounded border border-edge bg-panel px-2 py-0.5 text-[10px] text-chalk hover:border-graphite"
              onClick={() => {
                bumpMetric(doc, 'inlineReplies')
                respondApproval(id, approval.requestId, 'allow')
              }}
              data-testid={`rail-approve-${id}`}
            >
              Approve
            </button>
            <button
              className="rounded px-2 py-0.5 text-[10px] text-slate hover:text-chalk"
              onClick={() => {
                bumpMetric(doc, 'inlineReplies')
                respondApproval(id, approval.requestId, 'deny')
              }}
              data-testid={`rail-deny-${id}`}
            >
              Deny
            </button>
            {approval.detail.kind === 'file_edit' && (
              <button
                className="rounded px-2 py-0.5 text-[10px] text-slate hover:text-chalk"
                onClick={() => setShowDiff((v) => !v)}
                data-testid={`rail-diff-toggle-${id}`}
              >
                {showDiff ? 'Hide diff' : 'Diff'}
              </button>
            )}
          </div>
        </div>
      )}

      {!approval && question && questionReq && (
        <div className="mt-1">
          <p className="truncate text-[10px] text-slate">{question.question}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {/* A multi-select question does not get finished in a row — it is answered by opening
                the session and its full card */}
            {!question.multiSelect &&
              question.options.slice(0, 3).map((o) => (
                <button
                  key={o.label}
                  className="rounded border border-edge bg-panel px-1.5 py-0.5 text-[10px] text-chalk hover:border-graphite"
                  onClick={() => {
                    bumpMetric(doc, 'inlineReplies')
                    answerQuestion(id, questionReq, [{ question: question.question, answers: [o.label] }])
                  }}
                  data-testid={`rail-option-${id}-${o.label}`}
                >
                  {o.label}
                </button>
              ))}
          </div>
        </div>
      )}

      {!approval && !question && s.state === 'error' && (
        <p className="mt-1 truncate text-[10px] text-del">{s.lastError?.message ?? 'error'}</p>
      )}

      {!approval && !question && s.state === 'waiting_input' && (
        <>
          {/*
            The last activity gets its own line — putting it in the placeholder read as a
            "suggested reply" (dogfooding, 2026-09-05: `pnpm verify` sitting inside the composer
            raised the question "is this normal?"). The composer must always look like a blank
            sheet of paper.
          */}
          {(words ?? s.preview) && <p className="mt-1 truncate text-[10px] text-slate">{words ?? s.preview}</p>}
          <input
            className="mt-1 w-full rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            placeholder="Reply…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) {
              bumpMetric(doc, 'inlineReplies')
              send(id, text.trim())
              setText('')
            }
          }}
          data-testid={`rail-input-${id}`}
          />
        </>
      )}
    </div>
  )
}

/**
 * Creating a task — pick the members and write the goal, and a foreman stands up.
 * There is exactly one piece of creation logic, the host's app tool (control_create_task):
 * whether an orchestrator creates it or a person creates it through this dialog, both pass
 * through the same door (two implementations means one of them goes stale).
 */
function NewTaskDialog({ sessions, onClose }: { sessions: Record<string, SessionSummary>; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const workers = Object.values(sessions).filter((s) => s.kind === 'worker')

  const create = async () => {
    if (!title.trim() || members.length === 0 || busy) return
    setBusy(true)
    const r = await invokeAppTool('control', 'control_create_task', {
      title: title.trim(),
      goal: goal.trim(),
      memberSessionIds: members,
    })
    setBusy(false)
    if (r.isError) setError(r.text)
    else onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} data-testid="new-task-dialog">
      <div
        className="w-[380px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13px] text-chalk">New task</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ash">
          Pick member sessions and state the goal — a foreman session will coordinate them, keep a
          board, and call you on the rail when needed.
        </p>
        <input
          className="mt-3 w-full rounded border border-edge bg-panel px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="Task name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="task-title"
        />
        <textarea
          className="mt-2 w-full resize-none rounded border border-edge bg-panel px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          rows={2}
          placeholder="Goal — becomes the foreman's brief"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          data-testid="task-goal"
        />
        <p className="mt-2 text-[10px] uppercase text-slate">Members</p>
        <div className="mt-1 max-h-40 overflow-y-auto">
          {workers.length === 0 && <p className="text-[11px] text-slate">No worker sessions yet.</p>}
          {workers.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-ash hover:text-chalk">
              <input
                type="checkbox"
                className="accent-ash"
                checked={members.includes(s.id)}
                onChange={(e) =>
                  setMembers((m) => (e.target.checked ? [...m, s.id] : m.filter((x) => x !== s.id)))
                }
                data-testid={`task-member-${s.id}`}
              />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        {error && <p className="mt-2 text-[11px] text-del">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite disabled:opacity-40"
            disabled={!title.trim() || members.length === 0 || busy}
            onClick={() => void create()}
            data-testid="task-create"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
