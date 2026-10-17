import type { ProjectConsent } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { GrantList } from './GrantList.jsx'

const KIND_LABEL: Record<ProjectConsent['kind'], string> = {
  delegate: 'may ask',
  apps: 'may use the apps of',
  // Its sessions starting agents in itself (#561): the row names the project once
  agents: 'sessions may start agents',
}

/** What a consent row says it allows; a kind a newer host added (#844) is said by its own word rather than as a gap */
export function consentKindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string | undefined>)[kind] ?? `may ${kind}`
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
  const keyOf = (c: ProjectConsent) => `${c.fromProjectId}>${c.toProjectId}>${c.kind}`

  return (
    <section className="mt-6 border-t border-line pt-4" data-testid="project-consents">
      <h3 className="text-sm font-medium text-ink">Projects reaching other projects</h3>
      <p className="mt-1 text-xs leading-body text-ink-faint">
        When a session asks another project for something, Centralu asks you first. Each pair you allowed always is
        listed here; revoke it and the next request asks again.
      </p>
      <GrantList
        load={read}
        keyOf={keyOf}
        row={(c) => (
          <span className="min-w-0 truncate text-sm text-ink">
            {c.fromName} <span className="text-ink-faint">{consentKindLabel(c.kind)}</span>
            {c.kind === 'agents' ? null : ` ${c.toName}`}
          </span>
        )}
        dateOf={(c) => c.decidedAt}
        action={{
          label: 'Revoke',
          failed: 'Could not revoke it',
          testId: (c) => `revoke-consent-${keyOf(c)}`,
          run: (c) => platform.consents.revoke(c.fromProjectId, c.toProjectId, c.kind),
        }}
        what="the list"
        empty="No project may reach another yet"
        testIds={{
          list: 'project-consents-list',
          empty: 'project-consents-empty',
          failed: 'project-consents-failed',
          error: 'project-consents-error',
          row: (c) => `project-consent-${keyOf(c)}`,
        }}
      />
    </section>
  )
}
