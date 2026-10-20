import { useEffect, useState, type ReactNode } from 'react'
import type { Load } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { formatDay } from '../../app/format.js'

/**
 * A list of answers the person gave once and can take back (#850 item 12): the always-allow rules and the projects
 * allowed to reach other projects, under Settings → Permissions.
 *
 * The two lists were written twice, and the rules' copy had no error handling: a delete the host refused was an
 * unhandled rejection, and the row stayed with nothing said. Here a refused take-back says why and the row stays; one
 * taken back leaves at once and the list is read again, which then decides what is shown. A row's button takes no second press while its take-back runs.
 */
export function GrantList<T>({
  load,
  keyOf,
  row,
  dateOf,
  action,
  what,
  empty,
  testIds,
}: {
  load: Load<T[]>
  keyOf: (item: T) => string
  /** What the row says, before its date */
  row: (item: T) => ReactNode
  dateOf: (item: T) => number
  action: { label: string; failed: string; testId: (item: T) => string; run: (item: T) => Promise<unknown> }
  /** What was being read, as it ends "Could not read …" */
  what: string
  empty: string
  testIds: { list: string; empty: string; failed: string; error: string; row?: (item: T) => string }
}) {
  /** Taken back here and not yet gone from a re-read list: hidden at once instead of after the read */
  const [gone, setGone] = useState<string[]>([])
  /*
   * A list read anew is the host's word: what it holds is shown, even under a key taken back earlier (a consent revoked
   * and granted again while Settings stays open, #850 review).
   */
  useEffect(() => setGone([]), [load.data])
  const [running, setRunning] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const takeBack = async (item: T) => {
    const key = keyOf(item)
    if (running.includes(key)) return
    setRunning((r) => [...r, key])
    setError(null)
    try {
      await action.run(item)
      setGone((g) => [...g, key])
      void load.reload()
    } catch (e) {
      setError((e as Error).message || action.failed)
    } finally {
      setRunning((r) => r.filter((k) => k !== key))
    }
  }

  const list = load.data?.filter((item) => !gone.includes(keyOf(item)))
  return (
    <>
      {error && (
        <p className="mt-2 text-sm text-ink-faint" role="alert" data-testid={testIds.error}>
          {error}
        </p>
      )}
      {/* Beside the last list when a refresh failed, in its place when there is none */}
      {load.error !== null && (
        <LoadFailed what={what} error={load.error} onRetry={() => void load.reload()} className="mt-2" testId={testIds.failed} />
      )}
      {list === undefined ? (
        load.error === null && <SkeletonLines lines={2} className="mt-2" />
      ) : list.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint" data-testid={testIds.empty}>
          {empty}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line/60 rounded-md border border-line" data-testid={testIds.list}>
          {list.map((item) => (
            <li key={keyOf(item)} className="flex items-center gap-2 px-2.5 py-1.5" data-testid={testIds.row?.(item)}>
              {row(item)}
              <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">{formatDay(dateOf(item))}</span>
              <button
                className="shrink-0 text-xs text-ink-faint hover:text-ink"
                data-testid={action.testId(item)}
                disabled={running.includes(keyOf(item))}
                onClick={() => void takeBack(item)}
              >
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
