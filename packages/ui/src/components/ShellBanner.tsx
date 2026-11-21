import type { ReactNode } from 'react'

/**
 * The one-line strip in App's `banner` slot, between the top bar and the lanes. In the flow, never `fixed` (#326): laid
 * over the window it would sit under the macOS traffic lights and over the header's controls. Not positioned, so the
 * top bar's dropdowns paint over it. A fixed height, content truncating: with padding alone it was 35.5px with its
 * bordered button and 29.5px without, and every lane would jump 6px when a switch starts (measured in WebKit).
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
      className="flex h-8 min-w-0 shrink-0 items-center gap-3 border-b border-line-chrome bg-surface-side px-4 text-xs text-ink-muted"
      data-testid={testId}
      role={role}
    >
      {children}
    </div>
  )
}
