import { useCallback, useEffect, useState } from 'react'
import type { TrashedRun, TrashedSession } from '@cc/protocol'
import { messagesToChat, useStore, type ChatItem } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { formatBytes, formatDay } from '../../app/format.js'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { useToolMeta } from '../../store/selectors.js'
import { ReaderItem } from './TrashReaderItem.jsx'
import { TrashRunReader, TrashRuns } from './TrashRuns.jsx'

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
  const [trash, setTrash] = useState<{ sessions: TrashedSession[]; runs: TrashedRun[]; bytes: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reading, setReading] = useState<TrashedSession | null>(null)
  /** A kept app-agent run being read (#378) */
  const [readingRun, setReadingRun] = useState<TrashedRun | null>(null)
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
  if (readingRun) return <TrashRunReader run={readingRun} onBack={() => setReadingRun(null)} />

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
  /** One call per machine (#378 review): a linked machine's records are deleted there */
  const purgeRunsOf = async (list: readonly TrashedRun[]) => {
    const byMachine = new Map<string | null, string[]>()
    for (const r of list) byMachine.set(r.machine ?? null, [...(byMachine.get(r.machine ?? null) ?? []), r.runId])
    for (const [machine, runIds] of byMachine) await platform.trash.purgeRuns(runIds, machine)
  }
  const purgeRuns = (list: readonly TrashedRun[], at: string) =>
    act(at, () =>
      purgeRunsOf(list).then(
        () => null,
        (e: Error) => e.message,
      ),
    )
  /*
   * The sessions, then the run records this screen listed (#378): `trash.empty` leaves the records alone, so a linked
   * machine's are never deleted unseen
   */
  const emptyAll = () =>
    act(null, async () => {
      const listed = trash?.runs ?? []
      const failed: string[] = []
      if (sessions.length) {
        await platform.trash.empty().then(
          (r) => {
            if (r.failed.length) failed.push(`${r.failed.length} stayed in the trash: ${r.failed.map((f) => `${f.name} — ${f.error}`).join('; ')}`)
          },
          (e: Error) => failed.push(e.message),
        )
      }
      if (listed.length) await purgeRunsOf(listed).catch((e: Error) => failed.push(`The app runs stayed: ${e.message}`))
      return failed.length ? failed.join(' ') : null
    })

  const sessions = trash?.sessions ?? []
  const runs = trash?.runs ?? []
  const nothing = sessions.length === 0 && runs.length === 0
  return (
    <section data-testid="settings-trash">
      <p className="text-xs leading-body text-ink-faint">
        Deleted sessions wait here with their conversations. Nothing is emptied on its own — a conversation leaves
        this machine only when you delete it for good here.
      </p>

      {loadError && (
        <p className="mt-2 text-sm text-ink" data-testid="trash-load-error">
          Could not read the trash: {loadError}
        </p>
      )}

      <div className="mt-3 flex items-baseline gap-3">
        <span className="readout text-sm text-ink-muted" data-testid="trash-total">
          {trash === null
            ? 'Loading…'
            : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}${runs.length ? ` · ${runs.length} app ${runs.length === 1 ? 'run' : 'runs'}` : ''} · ${formatBytes(trash.bytes)}`}
        </span>
        <button
          type="button"
          className="ml-auto rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-danger disabled:opacity-40 disabled:hover:text-ink-faint"
          disabled={nothing || busy}
          onClick={() => setConfirming('all')}
          data-testid="trash-empty"
        >
          Empty trash…
        </button>
      </div>

      {confirming === 'all' && (
        <Confirm
          text={`Delete all ${sessions.length + runs.length} for good? Their conversations, attachments and handoff notes leave this machine, with the tool files and worktrees marked below${runs.length ? ', and the kept app runs' : ''}. This cannot be undone.`}
          busy={busy}
          onYes={emptyAll}
          onNo={() => setConfirming(null)}
        />
      )}
      {emptyReport && (
        <p className="mt-2 text-xs leading-body text-ink" data-testid="trash-empty-report">
          {emptyReport}
        </p>
      )}

      {trash !== null && nothing ? (
        <p className="mt-2 text-sm text-ink-faint" data-testid="trash-list-empty">
          The trash is empty
        </p>
      ) : sessions.length === 0 ? null : (
        <ul className="mt-2 divide-y divide-line/60 rounded-md border border-line" data-testid="trash-list">
          {sessions.map((s) => (
            <li key={s.id} className="px-2.5 py-2" data-testid={`trash-row-${s.id}`}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm text-ink">{s.name}</span>
                <span className="min-w-0 shrink truncate text-2xs text-ink-muted" data-testid={`trash-project-${s.id}`}>
                  {s.project ? s.project.name : 'No project'}
                  {s.project && !s.project.exists && ' (project deleted)'}
                </span>
                <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">
                  {formatDay(s.deletedAt)}
                </span>
              </div>
              <div className="mt-0.5 text-2xs text-ink-faint" data-testid={`trash-holds-${s.id}`}>
                {s.messages} {s.messages === 1 ? 'message' : 'messages'} · {formatBytes(s.bytes)}
                <GoesWith session={s} />
              </div>
              <div className="mt-1.5 flex gap-3 text-xs">
                <button
                  type="button"
                  className="text-ink-faint hover:text-ink"
                  onClick={() => setReading(s)}
                  data-testid={`trash-read-${s.id}`}
                >
                  Read
                </button>
                <button
                  type="button"
                  className="text-ink-faint hover:text-ink disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void act(s.id, () => restoreFromTrash(s.id))}
                  data-testid={`trash-restore-${s.id}`}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="text-ink-faint hover:text-danger disabled:opacity-40"
                  disabled={busy}
                  onClick={() => setConfirming(s)}
                  data-testid={`trash-purge-${s.id}`}
                >
                  Delete for good…
                </button>
              </div>
              {rowError?.id === s.id && (
                <p className="mt-1.5 text-xs leading-body text-ink" data-testid={`trash-error-${s.id}`}>
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
      <TrashRuns runs={runs} busy={busy} onRead={setReadingRun} onPurge={purgeRuns} />
      {rowError && runs.some((r) => r.runId === rowError.id || `${r.app.projectId ?? '_user'}/${r.app.id}` === rowError.id) && (
        <p className="mt-1.5 text-xs leading-body text-ink" data-testid="trash-runs-error">
          {rowError.text}
        </p>
      )}
    </section>
  )
}

/** What else deleting for good takes, as the person chose when deleting — said on the row, not only in the confirm */
function GoesWith({ session: s }: { session: TrashedSession }) {
  const tool = useToolMeta(s.tool).label
  return (
    <>
      {s.conversationFile === 'remove' && <span className="text-danger"> · the {tool} conversation file goes too</span>}
      {s.conversationFile === 'keep' && <span> · the {tool} conversation file stays</span>}
      {s.worktree && (
        <span className={s.worktree.remove ? 'text-danger' : undefined}>
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
    <InlineConfirm
      text={text}
      yesLabel="Delete for good"
      tone="danger"
      busy={busy}
      onYes={onYes}
      onNo={onNo}
      testId="trash-confirm"
    />
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
          className="text-xs text-ink-faint hover:text-ink"
          onClick={onBack}
          data-testid="trash-reader-back"
        >
          ← Trash
        </button>
        <span className="min-w-0 truncate text-sm text-ink">{session.name}</span>
        <span className="ml-auto shrink-0 text-2xs text-ink-faint">read-only</span>
      </div>
      {error && <p className="mt-2 text-sm text-ink">Could not read it: {error}</p>}
      {more && oldest !== null && (
        <button
          type="button"
          className="mt-2 text-xs text-ink-faint hover:text-ink"
          onClick={() => page(oldest)}
          data-testid="trash-reader-older"
        >
          Load earlier messages
        </button>
      )}
      <ol className="mt-2 space-y-2" data-testid="trash-reader-messages">
        {items?.length === 0 && <li className="text-sm text-ink-faint">Nothing was said in this session</li>}
        {items?.map((it, i) => <ReaderItem key={`${it.storedSeq ?? 'x'}-${i}`} item={it} />)}
      </ol>
    </section>
  )
}
