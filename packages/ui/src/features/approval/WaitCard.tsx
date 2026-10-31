import type { ReactNode } from 'react'
import { Pill } from '../../components/Pill.jsx'

/** The shell of every card that waits on the person (owner, 2026-10-18): white border, kind capsule, answers on a footer */
export function WaitCard({
  pill = 'Awaiting approval',
  subtitle,
  subtitleTestId,
  testId,
  kind,
  keys,
  children,
}: {
  pill?: string
  subtitle: ReactNode
  subtitleTestId?: string
  testId?: string
  kind?: string
  keys?: 'composer' | 'bare'
  children: ReactNode
}) {
  return (
    <div
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid={testId}
      data-kind={kind}
      data-keys={keys}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          {pill}
        </Pill>
        <span className="text-xs text-ink-faint" data-testid={subtitleTestId}>
          {subtitle}
        </span>
      </div>
      {children}
    </div>
  )
}

/** The answers at the foot of a `WaitCard`; a question's is spaced and ruled a little wider */
export function WaitFooter({ question = false, children }: { question?: boolean; children: ReactNode }) {
  return (
    <div
      className={
        question
          ? 'mt-3 flex items-center gap-2 border-t border-line px-3 py-2'
          : 'mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2'
      }
    >
      {children}
    </div>
  )
}
