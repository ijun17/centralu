import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoredMessage, SubagentStepsHeld, TrashedRun, TrashedSession, TrashedSubagentSteps } from '@cc/protocol'
import { messagesToChat, useStore } from '../../store/store.js'
import { mergeBySeq } from '../../store/historyPages.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { formatBytes, formatDay } from '../../app/format.js'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { useToolMeta } from '../../store/selectors.js'
import { ReaderItem } from './ArchiveReaderItem.jsx'
import { ArchiveRunReader, ArchiveRuns } from './ArchiveRuns.jsx'
import { SubagentStepsHeldList, TrashedSubagentStepsRow, stepsCount } from './SubagentStepsArchive.jsx'
import { SettingsCard, SettingsEmpty, SettingsPage, SettingsRow } from './SettingsLayout.jsx'

/**
 * Settings → Archive (#204): the way out of a deleted session, built in the same change as the way in.
 *
 * The retired archive (FR-20) is why this screen exists at all: it hid sessions with a keystroke and had no exit, so
 * a record that sat intact in the store was, to the person, gone. Here every session in the session archive can be read,
 * restored, or deleted for good, and the screen says what each one still takes on this machine and what else goes
 * with it — a store that keeps everything anyone ever pasted into a chat should not keep it out of sight.
 *
 * Deleting for good is only here. Nothing empties the session archive on its own, which is why the total is in the first line.
 */
/**
 * The linked machines whose trash was not read (#841 item 4): without this line the list read as the whole trash,
 * and what a machine still holds looked deleted
 */
export function ArchiveUnreached({ unreached }: { unreached?: readonly { name: string }[] }) {
  if (!unreached?.length) return null
  return (
    <p className="mt-2 text-sm text-ink" data-testid="trash-unreached">
      Not listed: the session archive on {unreached.map((m) => m.name).join(', ')}, which could not be reached just now.
    </p>
  )
}

export function ArchiveSection() {
  const platform = usePlatform()
  const restoreFromTrash = useStore((s) => s.restoreFromTrash)
  const trashSubagentSteps = useStore((s) => s.trashSubagentSteps)
  const restoreSubagentSteps = useStore((s) => s.restoreSubagentSteps)
  // The session archive list is read by `useLoad`: a failure is an error beside an empty box (with a retry), never "Loading…"
  // for good, and an answer to an older read cannot overwrite a newer one
  const list = useLoad(() => platform.trash.list(), [platform])
  const trash = list.data ?? null
  const [reading, setReading] = useState<TrashedSession | null>(null)
  /** A kept app-agent run being read (#378) */
  const [readingRun, setReadingRun] = useState<TrashedRun | null>(null)
  const [busy, setBusy] = useState(false)
  /** A refusal stays next to the row it is about — a toast is gone before it is read */
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)
  const [emptyReport, setEmptyReport] = useState<string | null>(null)
  /**
   * The one confirmation open on the whole screen: `all` for the whole trash, `session:<id>` for a archived session,
   * `steps:<id>` for a session's steps in the session archive and `held:<id>` for moving them there (#418), `runs:<key>` for a
   * kept app run or an app's runs (#378). One state, so a second "Delete for good…" closes the first
   */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [held, setHeld] = useState<{ sessions: SubagentStepsHeld[]; unreached?: { machineId: string; name: string }[] } | null | undefined>(null)
  const [heldError, setHeldError] = useState<string | null>(null)

  const loadHeld = useCallback(() => {
    platform.trash
      .subagentUsage()
      .then((h) => {
        setHeld(h)
        setHeldError(null)
      })
      .catch((e: Error) => {
        // A host before #418 has no such list: nothing to show, rather than a failure to read it
        if (e.message.startsWith('Unknown method: subagents.usage')) setHeld(undefined)
        else setHeldError(e.message)
      })
  }, [platform])
  const { reload } = list
  const load = useCallback(() => {
    void reload()
    loadHeld()
  }, [reload, loadHeld])

  useEffect(loadHeld, [loadHeld])

  if (reading) return <ArchiveReader session={reading} onBack={() => setReading(null)} />
  if (readingRun) return <ArchiveRunReader run={readingRun} onBack={() => setReadingRun(null)} />

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
  const errorOf = (id: string) => (rowError?.id === id ? rowError.text : null)
  /*
   * A session's subagent steps in the session archive (#418), deleted up to the `deletedAt` this screen listed: steps moved there
   * after it read the session archive (another window, a machine not reached then) are not deleted unseen
   */
  const purgeStepsOf = (t: TrashedSubagentSteps) => platform.trash.purgeSubagentSteps(t.sessionId, t.deletedAt)
  const purgeSteps = (t: TrashedSubagentSteps) =>
    act(`steps:${t.sessionId}`, () =>
      purgeStepsOf(t).then(
        () => null,
        (e: Error) => e.message,
      ),
    )
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
   * The sessions, then the run records and the subagent steps this screen listed (#378, #418): `trash.empty` leaves both
   * alone, so what a linked machine or another window put in the session archive since is never deleted unseen. A trash holding
   * only records or steps is emptied too: `trash.empty` is asked only when there are sessions
   */
  const emptyAll = () =>
    act(null, async () => {
      const listed = trash?.runs ?? []
      const listedSteps = trash?.subagentSteps ?? []
      const failed: string[] = []
      if (sessions.length) {
        await platform.trash.empty().then(
          (r) => {
            if (r.failed.length) failed.push(`${r.failed.length} stayed in the session archive: ${r.failed.map((f) => `${f.name} — ${f.error}`).join('; ')}`)
          },
          (e: Error) => failed.push(e.message),
        )
      }
      if (listed.length) await purgeRunsOf(listed).catch((e: Error) => failed.push(`The app runs stayed: ${e.message}`))
      for (const t of listedSteps) {
        await purgeStepsOf(t).catch((e: Error) => failed.push(`The subagent steps of ${t.name} stayed: ${e.message}`))
      }
      return failed.length ? failed.join(' ') : null
    })

  const sessions = trash?.sessions ?? []
  const runs = trash?.runs ?? []
  const steps = trash?.subagentSteps ?? []
  const nothing = sessions.length === 0 && runs.length === 0 && steps.length === 0
  return (
    <SettingsPage
      testId="settings-trash"
      title="Archive"
      lead="Deleted sessions wait here with their conversations. Nothing is emptied on its own — a conversation leaves this machine only when you delete it for good here."
    >
      {(list.error || trash?.unreached?.length) && (
        <div>
          {list.error && <LoadFailed what="the archive" error={list.error} onRetry={load} testId="trash-load-error" />}
          <ArchiveUnreached unreached={trash?.unreached} />
        </div>
      )}

      <SettingsCard>
        <SettingsRow
          label={
            <span className="readout text-ink-muted" data-testid="trash-total">
              {trash === null
                ? list.error
                  ? 'Not read'
                  : 'Loading…'
                : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}${runs.length ? ` · ${runs.length} app ${runs.length === 1 ? 'run' : 'runs'}` : ''}${
                    steps.length ? ` · subagent steps of ${stepsCount(steps.length, 'session', 'sessions')}` : ''
                  } · ${formatBytes(trash.bytes)}`}
            </span>
          }
          control={
            <button
              type="button"
              className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-danger disabled:opacity-50 disabled:hover:text-ink-faint"
              disabled={nothing || busy}
              onClick={() => setConfirming('all')}
              data-testid="trash-empty"
            >
              Delete all archived sessions…
            </button>
          }
        >
          {confirming === 'all' && (
            <Confirm
              text={`Delete all ${sessions.length + runs.length + steps.length} for good? Their conversations, attachments and handoff notes leave this machine, with the tool files and worktrees marked below${runs.length ? ', and the kept app runs' : ''}${
                steps.length ? ', and the subagent steps listed' : ''
              }. This cannot be undone.`}
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
        </SettingsRow>

        {trash !== null && nothing ? (
          <SettingsEmpty testId="trash-list-empty">The session archive is empty</SettingsEmpty>
        ) : sessions.length === 0 ? null : (
          <ul className="divide-y divide-line/70" data-testid="trash-list">
            {sessions.map((s) => (
              <li key={s.id} className="px-4 py-3" data-testid={`trash-row-${s.id}`}>
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
                    className="text-ink-faint hover:text-ink disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void act(s.id, () => restoreFromTrash(s.id))}
                    data-testid={`trash-restore-${s.id}`}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="text-ink-faint hover:text-danger disabled:opacity-50"
                    disabled={busy}
                    onClick={() => setConfirming(`session:${s.id}`)}
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
                {confirming === `session:${s.id}` && (
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
        {steps.length > 0 && (
          <ul className="divide-y divide-line/70" data-testid="trash-steps-list">
            {steps.map((t) => (
              <TrashedSubagentStepsRow
                key={`${t.machine ?? ''}/${t.sessionId}`}
                entry={t}
                busy={busy}
                confirming={confirming === `steps:${t.sessionId}`}
                error={errorOf(`steps:${t.sessionId}`)}
                onRestore={() => void act(`steps:${t.sessionId}`, () => restoreSubagentSteps(t.sessionId))}
                onAskPurge={() => setConfirming(`steps:${t.sessionId}`)}
                onPurge={() => void purgeSteps(t)}
                onCancel={() => setConfirming(null)}
              />
            ))}
          </ul>
        )}
      </SettingsCard>

      {runs.length > 0 && (
        <div>
          <ArchiveRuns
            runs={runs}
            busy={busy}
            confirming={confirming?.startsWith('runs:') ? confirming.slice(5) : null}
            onConfirming={(key) => setConfirming(key === null ? null : `runs:${key}`)}
            onRead={setReadingRun}
            onPurge={purgeRuns}
          />
          {rowError && runs.some((r) => r.runId === rowError.id || `${r.app.projectId ?? '_user'}/${r.app.id}` === rowError.id) && (
            <p className="mt-1.5 px-1 text-xs leading-body text-ink" data-testid="trash-runs-error">
              {rowError.text}
            </p>
          )}
        </div>
      )}

      {held !== undefined && (
        <SubagentStepsHeldList
          sessions={held?.sessions ?? null}
          unreached={held?.unreached ?? []}
          error={heldError}
          onRetry={load}
          row={(id) => ({ busy, confirming: confirming === `held:${id}`, error: errorOf(`held:${id}`) })}
          onAsk={(id) => setConfirming(`held:${id}`)}
          onMove={(h) => void act(`held:${h.sessionId}`, () => trashSubagentSteps(h.sessionId))}
          onCancel={() => setConfirming(null)}
        />
      )}
    </SettingsPage>
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
 * A archived conversation, read-only. It is drawn plainly — the words, the tool calls by name, the boundaries —
 * because it is here to be recognised before it is restored or deleted, not worked in: nothing in it can be
 * answered, opened or run.
 */
function ArchiveReader({ session, onBack }: { session: TrashedSession; onBack: () => void }) {
  const platform = usePlatform()
  /** The stored messages read so far, one per `seq`, oldest first: a page that overlaps the rows held is not drawn twice */
  const [msgs, setMsgs] = useState<StoredMessage[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A page is on its way: pressing "Load earlier messages" again would ask for the same page */
  const inFlight = useRef(false)
  const oldest = msgs?.[0]?.seq ?? null
  const items = useMemo(() => (msgs ? messagesToChat(msgs) : null), [msgs])

  const page = useCallback(
    (beforeSeq?: number) => {
      if (inFlight.current) return
      inFlight.current = true
      platform.trash
        .read(session.id, PAGE, beforeSeq)
        .then((got) => {
          setMsgs((cur) => mergeBySeq(cur ?? [], got))
          setMore(got.length >= PAGE)
          setError(null)
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => {
          inFlight.current = false
        })
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
          ← Archive
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
