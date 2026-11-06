import type { InboxItem } from '@cc/core'
import type { MailThreadRow } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { projectLabelOf } from '../../store/selectors.js'
import { StateDot } from '../../components/primitives.jsx'
import { RelativeAge } from '../../components/RelativeAge.js'
import { RowApproval } from '../approval/RowApproval.jsx'
import { inboxStateLabel } from './inboxLabel.js'
import { heldLabel, partyName, threadStateLabel } from './mailLabels.js'

/*
 * THROWAWAY (P11 options for the owner, not for main): the Inbox's one list, drawn two ways.
 * a: "Waiting on you" oldest wait first (as the list orders waits today), held mail pinned on top, read mail under "Earlier".
 * b: one list newest first (as mail is), held mail a row at its time, nothing folded.
 */
type Row =
  | { kind: 'session'; at: number; it: InboxItem }
  | { kind: 'mail'; at: number; t: MailThreadRow }
  | { kind: 'held'; at: number; key: string; title: string; why: string }

export function ProtoOneList({ option, items, settled }: { option: 'a' | 'b'; items: InboxItem[]; settled: boolean }) {
  const mail = useStore((s) => s.mail)
  const projects = useStore((s) => s.projects)
  const sessionRows: Row[] = items.map((it) => ({ kind: 'session', at: it.waitingSince ?? 0, it }))
  const threads = mail?.threads ?? []
  const waitingMail: Row[] = threads.filter((t) => option === 'b' || t.unread > 0).map((t) => ({ kind: 'mail', at: t.updatedAt, t }))
  const earlier = option === 'a' ? threads.filter((t) => t.unread === 0) : []
  const held: Row[] = (mail?.held ?? []).map((h) => ({ kind: 'held', at: Date.now(), key: h.messageId, title: `${partyName(h.sender)} → ${partyName(h.recipient)}: ${h.subject}`, why: heldLabel(h.reason).why }))
  const list = [...sessionRows, ...waitingMail, ...(option === 'b' ? held : [])].sort((x, y) => (option === 'a' ? x.at - y.at : y.at - x.at))
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <header className="flex items-baseline gap-2 border-b border-line/60 px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Waiting on you</h2>
        <span className="readout text-xs text-ink-faint">{list.length}</span>
        <span className="ml-auto text-2xs text-ink-faint">{option === 'a' ? 'Oldest first' : 'Newest first'}</span>
      </header>
      {option === 'a' && held.length > 0 && <ul className="mx-2 mt-1 flex flex-col gap-1">{held.map((r) => <HeldRow key={r.kind === 'held' ? r.key : ''} row={r} />)}</ul>}
      <ul className="flex flex-col gap-0.5 p-1">
        {list.map((r) => (
          <li key={r.kind === 'session' ? `s:${r.it.id}` : r.kind === 'mail' ? `m:${r.t.id}` : `h:${r.key}`} className="rounded-field hover:bg-surface-hover/25">
            {r.kind === 'session' ? (
              <SessionRow it={r.it} project={projectLabelOf(projects, r.it.projectId)} settled={settled} />
            ) : r.kind === 'mail' ? (
              <MailRow t={r.t} />
            ) : (
              <HeldRow row={r} />
            )}
          </li>
        ))}
      </ul>
      {earlier.length > 0 && (
        <>
          <h3 className="px-4 pb-1 pt-2 text-xs text-ink-faint">Earlier</h3>
          <ul className="flex flex-col gap-0.5 p-1">
            {earlier.map((t) => (
              <li key={t.id} className="rounded-field opacity-80 hover:bg-surface-hover/25">
                <MailRow t={t} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function SessionRow({ it, project, settled }: { it: InboxItem; project: string; settled: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-2.5 py-2 pl-3 pr-3">
        <StateDot state={it.state} />
        <span className={`truncate text-md ${it.unread ? 'text-ink' : 'text-ink-muted'}`}>{it.name}</span>
        <span className="truncate text-xs text-ink-faint">{project}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="text-xs text-ink-faint">{inboxStateLabel(it)}</span>
          <span className="readout w-12 text-right text-xs text-ink-faint">{it.waitingSince ? <RelativeAge when={it.waitingSince} /> : null}</span>
        </span>
      </div>
      {it.state === 'waiting_approval' && !it.proposal && <RowApproval sessionId={it.id} keys={false} settled={settled} onOpen={() => {}} />}
    </div>
  )
}

function MailRow({ t }: { t: MailThreadRow }) {
  return (
    <div className="flex items-center gap-2.5 py-2 pl-3 pr-3">
      <span className={`w-2 shrink-0 text-center text-2xs ${t.unread > 0 ? 'text-ink-signal' : 'text-transparent'}`}>●</span>
      <span className={`truncate text-md ${t.unread > 0 ? 'text-ink' : 'text-ink-muted'}`}>{t.subject}</span>
      <span className="truncate text-xs text-ink-faint">{t.owner.kind === 'person' ? '' : partyName(t.owner)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2.5">
        {t.last && <span className="max-w-48 truncate text-xs text-ink-faint">{t.last.preview}</span>}
        <span className="text-xs text-ink-faint">{threadStateLabel(t)}</span>
        <span className="readout w-12 text-right text-xs text-ink-faint">
          <RelativeAge when={t.updatedAt} />
        </span>
      </span>
    </div>
  )
}

function HeldRow({ row }: { row: Row }) {
  if (row.kind !== 'held') return null
  return (
    <div className="flex items-center gap-2 rounded-field border border-line px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-ink">{row.title}</span>
        <span className="truncate text-xs text-ink-faint">{row.why}</span>
      </span>
    </div>
  )
}
