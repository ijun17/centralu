import { useCallback, useEffect, useState } from 'react'
import type { TrashedSession } from '@cc/protocol'
import { messagesToChat, useStore, type ChatItem } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useToolMeta } from '../../store/selectors.js'
import { Markdown } from '../session/Markdown.jsx'

/**
 * Settings → Trash (#204): the way out of a deleted session, built in the same change as the way in.
 *
 * The retired archive (FR-20) is why this screen exists at all: it hid sessions with a keystroke and had no exit, so
 * a record that sat intact in the store was, to the person, gone. Here every session in the trash can be read,
 * restored, or deleted for good, and the screen says what each one still takes on this machine and what else goes
 * with it — a store that keeps everything anyone ever pasted into a chat should not keep it out of sight.
 *
 * Deleting for good is only here. Nothing empties the trash on its own, which is why the total is in the first line.
 */
export function TrashSection() {
  const platform = usePlatform()
  const restoreFromTrash = useStore((s) => s.restoreFromTrash)
  const [trash, setTrash] = useState<{ sessions: TrashedSession[]; bytes: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reading, setReading] = useState<TrashedSession | null>(null)
  /** The one confirmation open: a session, or the whole trash */
  const [confirming, setConfirming] = useState<TrashedSession | 'all' | null>(null)
  const [busy, setBusy] = useState(false)
  /** A refusal stays next to the row it is about — a toast is gone before it is read */
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)
  const [emptyReport, setEmptyReport] = useState<string | null>(null)

  const load = useCallback(() => {
    platform.trash
      .list()
      .then((t) => {
        setTrash(t)
        setLoadError(null)
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [platform])

  useEffect(load, [load])

  if (reading) return <TrashReader session={reading} onBack={() => setReading(null)} />

  const act = async (id: string | null, run: () => Promise<string | null>) => {
    setBusy(true)
    setRowError(null)
    setEmptyReport(null)
    try {
      const failed = await run()
      if (failed && id) setRowError({ id, text: failed })
      else if (failed) setEmptyReport(failed)
    } finally {
      setBusy(false)
      setConfirming(null)
      load()
    }
  }
  const purge = (s: TrashedSession) =>
    act(s.id, () =>
      platform.trash.purge(s.id).then(
        () => null,
        (e: Error) => e.message,
      ),
    )
  const emptyAll = () =>
    act(null, () =>
      platform.trash.empty().then(
        (r) =>
          r.failed.length === 0
            ? null
            : `${r.failed.length} stayed in the trash: ${r.failed.map((f) => `${f.name} — ${f.error}`).join('; ')}`,
        (e: Error) => e.message,
      ),
    )

  const sessions = trash?.sessions ?? []
  return (
    <section data-testid="settings-trash">
      <p className="text-[11px] leading-relaxed text-slate">
        Deleted sessions wait here with their conversations. Nothing is emptied on its own — a conversation leaves
        this machine only when you delete it for good here.
      </p>

      {loadError && (
        <p className="mt-2 text-[12px] text-chalk" data-testid="trash-load-error">
          Could not read the trash: {loadError}
        </p>
      )}

      <div className="mt-3 flex items-baseline gap-3">
        <span className="readout text-[12px] text-ash" data-testid="trash-total">
          {trash === null
            ? 'Loading…'
            : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} · ${size(trash.bytes)}`}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:text-del disabled:opacity-40 disabled:hover:text-slate"
          disabled={sessions.length === 0 || busy}
          onClick={() => setConfirming('all')}
          data-testid="trash-empty"
        >
          Empty trash…
        </button>
      </div>

      {confirming === 'all' && (
        <Confirm
          text={`Delete all ${sessions.length} for good? Their conversations, attachments and handoff notes leave this machine, with the tool files and worktrees marked below. This cannot be undone.`}
          busy={busy}
          onYes={emptyAll}
          onNo={() => setConfirming(null)}
        />
      )}
      {emptyReport && (
        <p className="mt-2 text-[11px] leading-relaxed text-chalk" data-testid="trash-empty-report">
          {emptyReport}
        </p>
      )}

      {trash !== null && sessions.length === 0 ? (
        <p className="mt-2 text-[12px] text-slate" data-testid="trash-list-empty">
          The trash is empty
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-edge/60 rounded border border-edge" data-testid="trash-list">
          {sessions.map((s) => (
            <li key={s.id} className="px-2.5 py-2" data-testid={`trash-row-${s.id}`}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-[12px] text-chalk">{s.name}</span>
                <span className="min-w-0 shrink truncate text-[10px] text-ash" data-testid={`trash-project-${s.id}`}>
                  {s.project ? s.project.name : 'No project'}
                  {s.project && !s.project.exists && ' (project deleted)'}
                </span>
                <span className="readout ml-auto shrink-0 text-[10px] text-slate">
                  {new Date(s.deletedAt).toLocaleDateString('en-US')}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-slate" data-testid={`trash-holds-${s.id}`}>
                {s.messages} {s.messages === 1 ? 'message' : 'messages'} · {size(s.bytes)}
                <GoesWith session={s} />
              </div>
              <div className="mt-1.5 flex gap-3 text-[11px]">
                <button
                  type="button"
                  className="text-slate hover:text-chalk"
                  onClick={() => setReading(s)}
                  data-testid={`trash-read-${s.id}`}
                >
                  Read
                </button>
                <button
                  type="button"
                  className="text-slate hover:text-chalk disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void act(s.id, () => restoreFromTrash(s.id))}
                  data-testid={`trash-restore-${s.id}`}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="text-slate hover:text-del disabled:opacity-40"
                  disabled={busy}
                  onClick={() => setConfirming(s)}
                  data-testid={`trash-purge-${s.id}`}
                >
                  Delete for good…
                </button>
              </div>
              {rowError?.id === s.id && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-chalk" data-testid={`trash-error-${s.id}`}>
                  {rowError.text}
                </p>
              )}
              {confirming !== 'all' && confirming?.id === s.id && (
                <Confirm
                  text={`Delete “${s.name}” for good? Its conversation, attachments and handoff note leave this machine${goesWithText(s)}. This cannot be undone.`}
                  busy={busy}
                  onYes={() => void purge(s)}
                  onNo={() => setConfirming(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** What else deleting for good takes, as the person chose when deleting — said on the row, not only in the confirm */
function GoesWith({ session: s }: { session: TrashedSession }) {
  const tool = useToolMeta(s.tool).label
  return (
    <>
      {s.conversationFile === 'remove' && <span className="text-del"> · the {tool} conversation file goes too</span>}
      {s.conversationFile === 'keep' && <span> · the {tool} conversation file stays</span>}
      {s.worktree && (
        <span className={s.worktree.remove ? 'text-del' : undefined}>
          {' '}
          · worktree <span className="font-mono">{s.worktree.branch}</span> {s.worktree.remove ? 'goes too' : 'stays'}
        </span>
      )}
    </>
  )
}

function goesWithText(s: TrashedSession): string {
  const parts: string[] = []
  if (s.conversationFile === 'remove') parts.push('the tool’s conversation file')
  if (s.worktree?.remove) parts.push(`the worktree at ${s.worktree.path}`)
  return parts.length ? `, and so do ${parts.join(' and ')}` : ''
}

function Confirm({ text, busy, onYes, onNo }: { text: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mt-2 rounded border border-del/40 bg-del-bg px-2.5 py-2" data-testid="trash-confirm">
      <p className="text-[11px] leading-relaxed text-chalk">{text}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate hover:text-chalk" onClick={onNo}>
          Cancel
        </button>
        <button
          type="button"
          className="rounded border border-del/40 px-2 py-0.5 text-[11px] text-del hover:border-del/70 disabled:opacity-40"
          disabled={busy}
          onClick={onYes}
          data-testid="trash-confirm-yes"
        >
          Delete for good
        </button>
      </div>
    </div>
  )
}

const PAGE = 200

/**
 * A trashed conversation, read-only. It is drawn plainly — the words, the tool calls by name, the boundaries —
 * because it is here to be recognised before it is restored or deleted, not worked in: nothing in it can be
 * answered, opened or run.
 */
function TrashReader({ session, onBack }: { session: TrashedSession; onBack: () => void }) {
  const platform = usePlatform()
  const [items, setItems] = useState<ChatItem[] | null>(null)
  const [oldest, setOldest] = useState<number | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const page = useCallback(
    (beforeSeq?: number) => {
      platform.trash
        .read(session.id, PAGE, beforeSeq)
        .then((msgs) => {
          setItems((cur) => [...messagesToChat(msgs), ...(beforeSeq === undefined ? [] : (cur ?? []))])
          setOldest(msgs[0]?.seq ?? null)
          setMore(msgs.length >= PAGE)
        })
        .catch((e: Error) => setError(e.message))
    },
    [platform, session.id],
  )
  useEffect(() => page(), [page])

  return (
    <section data-testid="trash-reader">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          className="text-[11px] text-slate hover:text-chalk"
          onClick={onBack}
          data-testid="trash-reader-back"
        >
          ← Trash
        </button>
        <span className="min-w-0 truncate text-[12px] text-chalk">{session.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-slate">read-only</span>
      </div>
      {error && <p className="mt-2 text-[12px] text-chalk">Could not read it: {error}</p>}
      {more && oldest !== null && (
        <button
          type="button"
          className="mt-2 text-[11px] text-slate hover:text-chalk"
          onClick={() => page(oldest)}
          data-testid="trash-reader-older"
        >
          Load earlier messages
        </button>
      )}
      <ol className="mt-2 space-y-2" data-testid="trash-reader-messages">
        {items?.length === 0 && <li className="text-[12px] text-slate">Nothing was said in this session</li>}
        {items?.map((it, i) => <ReaderItem key={`${it.storedSeq ?? 'x'}-${i}`} item={it} />)}
      </ol>
    </section>
  )
}

function ReaderItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <li className="rounded bg-panel px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-chalk">
          {item.from && <span className="mr-1.5 text-[10px] text-slate">from {item.from.name}</span>}
          {item.text}
          {item.attachments?.length ? (
            <span className="ml-1.5 text-[10px] text-slate">
              +{item.attachments.length} {item.attachments.length === 1 ? 'attachment' : 'attachments'}
            </span>
          ) : null}
        </li>
      )
    case 'assistant':
      return (
        <li className="text-[12px]">
          <Markdown text={item.text} projectRoot={null} />
        </li>
      )
    case 'tool':
      return <li className="font-mono text-[10px] text-slate">▸ {item.title || item.tool}</li>
    case 'approval':
      return (
        <li className="text-[10px] text-slate">
          Approval · {item.summary}
          {item.decision ? ` — ${item.decision}` : ''}
        </li>
      )
    case 'mark':
      return <li className="border-t border-edge/60 pt-1 text-center text-[10px] text-slate">{item.text}</li>
    case 'image':
      return <li className="text-[10px] text-slate">[image]</li>
    case 'reasoning':
      return null
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
