import { useState } from 'react'
import type { ProjectConsent } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { formatDay } from '../../app/format.js'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'

const KIND_LABEL: Record<ProjectConsent['kind'], string> = {
  delegate: 'may ask',
  apps: 'may use the apps of',
  // Its sessions starting agents in itself (#561): the row names the project once
  agents: 'sessions may start agents',
}

/**
 * The projects allowed to reach other projects (#371) — every "always for this pair" the person gave on a consent
 * card, from either kind: asking another project to do a task (ask_project) or using its apps. Revoking one makes
 * the next reach ask again; a delegation already running is left to finish.
 *
 * It sits under Permissions next to the always-allow rules because it is the same kind of thing: an answer the
 * person gave once, kept so it is not asked again, and undone here.
 */
export function ProjectConsentsSection() {
  const platform = usePlatform()
  const version = useStore((s) => s.projectConsentsVersion)
  // Read again whenever a consent is given or revoked elsewhere (`projectConsentsVersion`)
  const read = useLoad(() => platform.consents.list(), [platform], [version])
  // Revoked here since the last read: gone from the list without waiting for it
  const [revoked, setRevoked] = useState<ProjectConsent[]>([])
  const [error, setError] = useState<string | null>(null)
  const list = read.data?.filter((c) => !revoked.includes(c))

  return (
    <section className="mt-6 border-t border-line pt-4" data-testid="project-consents">
      <h3 className="text-sm font-medium text-ink">Projects reaching other projects</h3>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        When a session asks another project for something, Centralu asks you first. Each pair you allowed always is
        listed here; revoke it and the next request asks again.
      </p>
      {error && <p className="mt-2 text-sm text-ink-faint">{error}</p>}
      {read.error !== null && (
        <LoadFailed
          what="the list"
          error={read.error}
          onRetry={() => void read.reload()}
          className="mt-2"
          testId="project-consents-failed"
        />
      )}
      {list === undefined ? (
        read.error === null && <p className="mt-2 text-sm text-ink-faint">Loading…</p>
      ) : list.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint" data-testid="project-consents-empty">
          No project may reach another yet
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line/60 rounded-md border border-line" data-testid="project-consents-list">
          {list.map((c) => {
            const key = `${c.fromProjectId}>${c.toProjectId}>${c.kind}`
            return (
              <li key={key} className="flex items-center gap-2 px-2.5 py-1.5" data-testid={`project-consent-${key}`}>
                <span className="min-w-0 truncate text-sm text-ink">
                  {c.fromName} <span className="text-ink-faint">{KIND_LABEL[c.kind]}</span>
                  {c.kind === 'agents' ? null : ` ${c.toName}`}
                </span>
                <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">
                  {formatDay(c.decidedAt)}
                </span>
                <button
                  className="shrink-0 text-xs text-ink-faint hover:text-ink"
                  data-testid={`revoke-consent-${key}`}
                  onClick={async () => {
                    try {
                      await platform.consents.revoke(c.fromProjectId, c.toProjectId, c.kind)
                      setRevoked((r) => [...r, c])
                    } catch (e) {
                      setError((e as Error).message || 'Could not revoke it')
                    }
                  }}
                >
                  Revoke
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
