import { useCallback, useEffect, useState } from 'react'
import type { TrashedRun } from '@cc/protocol'
import { messagesToChat, type ChatItem } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { formatBytes, formatDay, formatDuration } from '../../app/format.js'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { Markdown } from '../session/Markdown.jsx'
import { ReaderItem } from './ArchiveReaderItem.jsx'

/** One app's records, in the order the session archive lists them (most recently kept first) */
type RunGroup = { key: string; name: string; projectName: string | null; runs: TrashedRun[] }

/** The records grouped by app (#378): an app that called run_agent a few dozen times reads as one heading, not a wall */
export function groupRuns(runs: readonly TrashedRun[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const r of runs) {
    // A linked machine's project ids name it already; its user-folder apps are told from the hub's by the machine (#378 review)
    const key = `${r.app.projectId ?? (r.machine ? `${r.machine}._user` : '_user')}/${r.app.id}`
    const g = groups.get(key) ?? { key, name: r.app.name, projectName: r.app.projectName, runs: [] }
    g.runs.push(r)
    groups.set(key, g)
  }
  return [...groups.values()]
}

/**
 * The records of deleted app-agent sessions in Settings → Archive (#378). A session an app stood up with run_agent goes
 * once its run ends cleanly; what it did waits here: the app's request, the answer, the whole conversation. Each can
 * be read and deleted for good, one at a time or an app's all at once. There is no restore: the record is the run,
 * not a session to talk to again.
 */
export function ArchiveRuns({
  runs,
  busy,
  confirming,
  onConfirming,
  onRead,
  onPurge,
}: {
  runs: readonly TrashedRun[]
  busy: boolean
  /** The confirmation open on this list: a record by its id, or a whole app's by its group key. The screen holds it, so only one confirmation is open across all of its lists */
  confirming: string | null
  onConfirming: (key: string | null) => void
  onRead: (run: TrashedRun) => void
  /** Deletes these for good; `at` is the row or app a refusal is shown next to */
  onPurge: (runs: readonly TrashedRun[], at: string) => Promise<void>
}) {
  if (runs.length === 0) return null
  return (
    <div className="space-y-3" data-testid="trash-runs">
      <div className="px-1">
        <h3 className="text-xs font-medium text-ink-muted">App agent runs</h3>
        <p className="mt-0.5 text-xs leading-body text-ink-faint">
          A session an app started for its request is deleted once the run ends cleanly; what it did is kept here for 30
          days.
        </p>
      </div>
      {groupRuns(runs).map((g) => (
        <div key={g.key} className="divide-y divide-line/70 rounded-lg border border-line bg-surface-raised" data-testid={`trash-runs-app-${g.key}`}>
          <div className="flex items-baseline gap-2 px-4 py-2.5">
            <span className="min-w-0 truncate text-sm text-ink">{g.name}</span>
            <span className="min-w-0 shrink truncate text-2xs text-ink-muted">{g.projectName ?? 'Your apps'}</span>
            <span className="readout text-2xs text-ink-faint">
              {g.runs.length} {g.runs.length === 1 ? 'run' : 'runs'}
            </span>
            <button
              type="button"
              className="ml-auto rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-danger disabled:opacity-40"
              disabled={busy}
              onClick={() => onConfirming(g.key)}
              data-testid={`trash-runs-purge-app-${g.key}`}
            >
              Delete all…
            </button>
          </div>
          {confirming === g.key && (
            <div className="px-4 pb-3">
              <InlineConfirm
                text={`Delete all ${g.runs.length} kept ${g.runs.length === 1 ? 'run' : 'runs'} of ${g.name} for good? Their requests, answers and conversations leave this machine; the app's run log keeps only their status and time. This cannot be undone.`}
                yesLabel="Delete for good"
                tone="danger"
                busy={busy}
                onYes={() => void onPurge(g.runs, g.key).finally(() => onConfirming(null))}
                onNo={() => onConfirming(null)}
                testId="trash-confirm"
              />
            </div>
          )}
          <ul className="divide-y divide-line/70">
            {g.runs.map((r) => (
              <li key={r.runId} className="px-4 py-3" data-testid={`trash-run-${r.runId}`}>
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm text-ink">{r.sessionName}</span>
                  <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">{formatDay(r.startedAt)}</span>
                </div>
                <div className="mt-0.5 truncate text-2xs text-ink-muted" data-testid={`trash-run-request-${r.runId}`}>
                  {r.requestPreview}
                </div>
                <div className="mt-0.5 text-2xs text-ink-faint" data-testid={`trash-run-holds-${r.runId}`}>
                  {r.messages} {r.messages === 1 ? 'message' : 'messages'} · {formatBytes(r.bytes)}
                  {r.durationMs !== null && ` · ${formatDuration(r.durationMs)}`}
                  {r.tokens && ` · ${r.tokens.input.toLocaleString()} in / ${r.tokens.output.toLocaleString()} out tokens`}
                </div>
                <div className="mt-1.5 flex gap-3 text-xs">
                  <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onRead(r)} data-testid={`trash-run-read-${r.runId}`}>
                    Read
                  </button>
                  <button
                    type="button"
                    className="text-ink-faint hover:text-danger disabled:opacity-40"
                    disabled={busy}
                    onClick={() => onConfirming(r.runId)}
                    data-testid={`trash-run-purge-${r.runId}`}
                  >
                    Delete for good…
                  </button>
                </div>
                {confirming === r.runId && (
                  <InlineConfirm
                    text={`Delete this run of ${g.name} for good? Its request, answer and conversation leave this machine. This cannot be undone.`}
                    yesLabel="Delete for good"
                    tone="danger"
                    busy={busy}
                    onYes={() => void onPurge([r], r.runId).finally(() => onConfirming(null))}
                    onNo={() => onConfirming(null)}
                    testId="trash-confirm"
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

const PAGE = 200

/** A kept run, read-only (#378): what the app asked, what the agent answered, and the conversation in between */
export function ArchiveRunReader({ run, onBack }: { run: TrashedRun; onBack: () => void }) {
  const platform = usePlatform()
  const [head, setHead] = useState<{ request: string; answer: string; output?: unknown } | null>(null)
  const [items, setItems] = useState<ChatItem[] | null>(null)
  const [oldest, setOldest] = useState<number | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const page = useCallback(
    (beforeSeq?: number) => {
      platform.trash
        .readRun(run.runId, PAGE, beforeSeq, run.machine)
        .then((r) => {
          if (beforeSeq === undefined) setHead({ request: r.request, answer: r.answer, ...(r.output !== undefined ? { output: r.output } : {}) })
          setItems((cur) => [...messagesToChat(r.messages), ...(beforeSeq === undefined ? [] : (cur ?? []))])
          setOldest(r.messages[0]?.seq ?? null)
          setMore(r.messages.length >= PAGE)
        })
        .catch((e: Error) => setError(e.message))
    },
    [platform, run.runId, run.machine],
  )
  useEffect(() => page(), [page])

  return (
    <section data-testid="trash-run-reader">
      <div className="flex items-baseline gap-2">
        <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={onBack} data-testid="trash-reader-back">
          ← Archive
        </button>
        <span className="min-w-0 truncate text-sm text-ink">{run.sessionName}</span>
        <span className="ml-auto shrink-0 text-2xs text-ink-faint">read-only</span>
      </div>
      {error && <p className="mt-2 text-sm text-ink">Could not read it: {error}</p>}
      {head && (
        <dl className="mt-2 space-y-1.5 text-sm" data-testid="trash-run-head">
          <dt className="text-2xs text-ink-faint">{run.app.name} asked</dt>
          <dd className="rounded-md bg-surface-raised px-2.5 py-1.5 whitespace-pre-wrap text-ink" data-testid="trash-run-asked">
            {head.request}
          </dd>
          <dt className="text-2xs text-ink-faint">The answer</dt>
          <dd data-testid="trash-run-answer">
            {head.answer ? <Markdown text={head.answer} projectRoot={null} /> : <span className="text-ink-faint">No text</span>}
          </dd>
          {head.output !== undefined && (
            <>
              <dt className="text-2xs text-ink-faint">Structured output</dt>
              <dd className="font-mono text-2xs whitespace-pre-wrap text-ink-muted" data-testid="trash-run-output">
                {JSON.stringify(head.output, null, 2)}
              </dd>
            </>
          )}
        </dl>
      )}
      <p className="mt-3 border-t border-line/60 pt-2 text-2xs text-ink-faint">The conversation</p>
      {more && oldest !== null && (
        <button type="button" className="mt-2 text-xs text-ink-faint hover:text-ink" onClick={() => page(oldest)} data-testid="trash-reader-older">
          Load earlier messages
        </button>
      )}
      <ol className="mt-2 space-y-2" data-testid="trash-reader-messages">
        {items?.length === 0 && <li className="text-sm text-ink-faint">Nothing was said in this run</li>}
        {items?.map((it, i) => <ReaderItem key={`${it.storedSeq ?? 'x'}-${i}`} item={it} />)}
      </ol>
    </section>
  )
}
