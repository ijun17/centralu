import { useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import { Button } from '../../components/Button.jsx'
import { useProjectApps, usesLines } from '../../store/app-catalog.js'
import { useStore } from '../../store/store.js'

/**
 * The question "Trust this project?", with what trusting covers (#1141).
 *
 * Trust follows the project, with no switch per app (owner, 2026-10-18): trusting it lets its apps run, lets them reach
 * the orchestrator and the person's other projects where an app may (the project's own root app), and lets its settings
 * apply. So the card lists each of the project's apps, its root app and those in `.centralu/apps` alike: its name, its
 * whole description, and what its manifest declares it may ask for, in plain words. A long list scrolls inside the card.
 *
 * One card for every place that asks: under the project's row (`TrustAsk`, after registration and from the project
 * menu) and wherever a "Trust this project…" button stands (an untrusted app's screen, its Settings row, the New app
 * dialog, `TrustProjectButton`).
 */
/** The test ids of one card's parts: the sidebar's keep the names they had before the list came (`trust-ask-yes-<name>`) */
export type TrustCardIds = { card: string; yes: string; no: string; title: string; apps: string; app: (key: string) => string }

export const trustCardIds = (testId: string): TrustCardIds => ({
  card: testId,
  yes: `${testId}-yes`,
  no: `${testId}-no`,
  title: `${testId}-apps-title`,
  apps: `${testId}-apps`,
  app: (key) => `${testId}-app-${key}`,
})

/**
 * What stays off in a project that is not trusted (#1512), said by the card, the project row and the notice in a session.
 * The repository's own instruction files are the part nothing said before: an untrusted project's `CLAUDE.md` and
 * `AGENTS.md`, hooks and commands are not read (the session reads only the person's own settings), and starting
 * agents and worktrees are refused there.
 */
export const UNTRUSTED_OFF =
  "its CLAUDE.md and AGENTS.md, hooks and commands are ignored, its apps don't run, and its sessions can't start agents or use worktrees"

export function TrustCard({ project, onAnswer, ids }: { project: ProjectInfo; onAnswer: (trust: boolean) => void; ids: TrustCardIds }) {
  const apps = useProjectApps(project.id)
  return (
    <div className="rounded-md border border-line bg-surface-raised px-2.5 py-2" role="group" aria-label={`Trust ${project.name}?`} data-testid={ids.card}>
      <p className="text-sm text-ink">Trust this project?</p>
      <p className="mt-1 text-xs leading-body text-ink-muted">
        Trusting lets this project&apos;s apps run and its settings apply. Until then {UNTRUSTED_OFF}. Trust it only if
        you trust the code in this folder.
      </p>
      {apps.length > 0 && (
        <>
          <p className="mt-2 text-xs leading-body text-ink-muted" data-testid={ids.title}>
            {apps.length === 1 ? 'Its app:' : `Its ${apps.length} apps:`}
          </p>
          <ul className="mt-1 max-h-48 space-y-2 overflow-y-auto pr-1" data-testid={ids.apps} aria-label={`Apps of ${project.name}`} tabIndex={0}>
            {apps.map((a) => {
              const asks = a.info.uses ? usesLines(a.info.uses) : []
              const description = (a.info.description ?? '').trim()
              return (
                <li key={a.key} className="text-xs leading-body" data-testid={ids.app(a.key)}>
                  <p className="text-ink">{a.title}</p>
                  {description && <p className="whitespace-pre-wrap break-words text-ink-muted" data-testid="trust-card-app-description">{description}</p>}
                  {a.info.root && (
                    <p className="text-ink-muted" data-testid="trust-ask-app-reach">
                      This project is this app: the orchestrator and your other projects can use it.
                    </p>
                  )}
                  {asks.length > 0 ? (
                    <ul className="text-ink-faint" data-testid="trust-ask-app-uses">
                      {asks.map((line) => (
                        <li key={line}>May ask to: {line.charAt(0).toLowerCase() + line.slice(1)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ink-faint" data-testid="trust-ask-app-uses">
                      Asks for nothing beyond its own tools.
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="subtle" size="sm" onClick={() => onAnswer(false)} data-testid={ids.no}>
          Not now
        </Button>
        <Button variant="primary" onRaised size="sm" onClick={() => onAnswer(true)} data-testid={ids.yes}>
          Trust
        </Button>
      </div>
    </div>
  )
}

/**
 * "Trust this project…" where an untrusted project's app stands (its screen, its Settings row, the New app dialog): it
 * opens the same card in place, so trusting is decided with the project's apps in view (#1141), never in one press.
 */
export function TrustProjectButton({ projectId, testId, className = '' }: { projectId: string; testId: string; className?: string }) {
  const project = useStore((s) => s.projects[projectId])
  const trust = useStore((s) => s.setProjectTrusted)
  const [open, setOpen] = useState(false)
  if (!project) return null
  return open ? (
    <div className={className}>
      <TrustCard
        project={project}
        ids={trustCardIds(`${testId}-card`)}
        onAnswer={(yes) => {
          setOpen(false)
          if (yes) void trust(projectId, true)
        }}
      />
    </div>
  ) : (
    <Button variant="primary" onRaised size="sm" className={className} onClick={() => setOpen(true)} data-testid={testId}>
      Trust this project…
    </Button>
  )
}
