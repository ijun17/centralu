import type { ReactNode } from 'react'
import { Pill } from '../../components/Pill.jsx'

/**
 * The shell of every card that waits on the person (owner, 2026-10-18): the conversation's 14px corner, a white border
 * all round as the inbox capsule's for an approval (white is what waits on the person), the kind as a capsule with a
 * line of what it is beside it, and the answers on a plain footer (`WaitFooter`) below a hairline. The approvals
 * (ApprovalCard), the agent's questions (QuestionCard) and a program's call (HostRequestCards) are all drawn in it.
 */
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
  /** `data-kind`: which sort of approval this is */
  kind?: string
  /** `data-keys`: whether the card's answer keys are shown for the composer or for a bare card */
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

/** The row of answers at the foot of a `WaitCard`. A question's is a little wider apart and its hairline a little stronger */
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
