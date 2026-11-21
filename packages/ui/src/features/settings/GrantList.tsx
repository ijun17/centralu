import { errorMessage } from '@cc/protocol/client'
import { useEffect, useState, type ReactNode } from 'react'
import type { Load } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { formatDay } from '../../app/format.js'
import { Button } from '../../components/Button.jsx'
import { SettingsEmpty } from './SettingsLayout.jsx'

/**
 * Answers given once that can be taken back (#850 item 12), in Settings → Permissions: always-allow rules and project
 * consents. A refused take-back says why and the row stays; a taken-back row leaves at once and the list is re-read,
 * which then decides. A row's button takes no second press while its take-back runs.
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
  // A list read anew is the host's word, shown even under a key taken back earlier (revoked and granted again while
  // Settings stays open, #850)
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
      setError(errorMessage(e) || action.failed)
    } finally {
      setRunning((r) => r.filter((k) => k !== key))
    }
  }

  const list = load.data?.filter((item) => !gone.includes(keyOf(item)))
  // Rows of the settings card the caller puts this in (SettingsGroup): the card draws the frame and the hairlines
  return (
    <>
      {error && (
        <p className="px-4 py-2.5 text-sm text-ink-faint" role="alert" data-testid={testIds.error}>
          {error}
        </p>
      )}
      {/* Beside the last list when a refresh failed, in its place when there is none */}
      {load.error !== null && (
        <div className="px-4 py-3">
          <LoadFailed what={what} error={load.error} onRetry={() => void load.reload()} testId={testIds.failed} />
        </div>
      )}
      {list === undefined ? (
        load.error === null && (
          <div className="px-4 py-3">
            <SkeletonLines lines={2} />
          </div>
        )
      ) : list.length === 0 ? (
        <SettingsEmpty testId={testIds.empty}>{empty}</SettingsEmpty>
      ) : (
        <ul className="divide-y divide-line" data-testid={testIds.list}>
          {list.map((item) => (
            <li key={keyOf(item)} className="flex items-center gap-2 px-4 py-2.5" data-testid={testIds.row?.(item)}>
              {row(item)}
              <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">{formatDay(dateOf(item))}</span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                data-testid={action.testId(item)}
                disabled={running.includes(keyOf(item))}
                onClick={() => void takeBack(item)}
              >
                {action.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
