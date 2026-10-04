import type { ReactNode } from 'react'

/**
 * The strip a shell puts in App's `banner` slot — one line, between the top bar and the lanes.
 *
 * It is a block in the flow, never `fixed` (#326). Laid over the window at top 0, the desktop's
 * "other build" bar put its text under the macOS traffic lights and its button over the header's
 * controls. In the flow, the lanes below give up its height instead and nothing is covered.
 *
 * Not positioned either: the top bar's dropdowns (the waiting list) are positioned, so they paint
 * over a non-positioned strip that comes later in the document, as a dropdown should.
 *
 * One line of a fixed height, whatever it holds: the content is expected to truncate
 * (`min-w-0 truncate`) rather than wrap, and the height does not follow the content. With
 * padding alone the bar was 35.5px with its bordered button and 29.5px without (the switch
 * progress), so every lane below jumped 6px when a switch started (measured in WebKit).
 */
export function ShellBanner({
  children,
  role,
  testId,
}: {
  children: ReactNode
  role?: 'status' | 'alert'
  testId?: string
}) {
  return (
    <div
      className="flex h-8 min-w-0 shrink-0 items-center gap-3 border-b border-line bg-surface-side px-4 text-xs text-ink-muted"
      data-testid={testId}
      role={role}
    >
      {children}
    </div>
  )
}
