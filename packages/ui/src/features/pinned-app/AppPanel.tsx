import { useLayoutEffect, useRef, type DragEvent } from 'react'
import type { GridSpan } from '@cc/protocol/client'
import type { GridSpanSource } from '@cc/core'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { SpanButton } from '../../components/SpanPicker.jsx'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { registerSlot } from './slots.js'
import { DragShield } from './dragShield.jsx'

// An app's panel on the project screen (#203) or grid (#288): a header that moves it, and a slot its view is laid over
// (slots.ts) and covered during drags (dragShield.tsx). The view's side panels need room, so Open goes to the app view.
// Status in words, as the sidebar; why it cannot run is the view's to say. The grid adds the span picker (#306).

/** Where a grid panel's span comes from, in the words the picker's "default" line uses */
const FROM_WORDS: Record<Exclude<GridSpanSource, 'placement'>, string> = {
  setting: 'from Settings',
  app: 'as the app recommends',
  default: 'one cell',
}

export type PanelSpan = {
  /** The span this panel asks for, and who decided it */
  asked: GridSpan
  from: GridSpanSource
  /** The cells it stands on now */
  shown: GridSpan
  /** It stands smaller than it asks, because the window has no room */
  clamped: boolean
  /** The largest span the grid has room for now */
  room: GridSpan
  /** What it falls back to without a choice of its own: the person's setting for the app, the app's, or 1 × 1 */
  fallback: { span: GridSpan; from: GridSpanSource }
  onPick: (span: GridSpan | null) => void
  testId: string
}
export function AppPanel({
  app,
  appId,
  viewKey,
  dragged,
  onDragStart,
  onOpen,
  remove,
  slotTestId,
  openTestId,
  span,
}: {
  /** The app as the list has it — undefined for a moment while the list is read again */
  app: ExternalCatalogApp | undefined
  appId: string
  /** The key of the view laid over this panel's slot: the app's pinned view, or its grid view */
  viewKey: string
  dragged: boolean
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onOpen: () => void
  remove: { label: string; testId: string; onClick: () => void }
  slotTestId: string
  openTestId: string
  /** The grid panel's span and its picker (#306); absent on the project screen */
  span?: PanelSpan
}) {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = slot.current
    if (!el) return
    return registerSlot(viewKey, el)
  }, [viewKey])
  const title = app?.title ?? appId
  return (
    <>
      <div
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line-chrome px-4 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
        data-testid="pane-header"
      >
        <span className="text-ink-muted">
          <AppIcon />
        </span>
        <span
          className="truncate text-md font-medium tracking-tight text-ink"
          data-testid="app-panel-title"
        >
          {title}
        </span>
        {app && (
          <span className="readout shrink-0 text-2xs text-ink-faint" data-testid="app-panel-status">
            {app.status.label}
          </span>
        )}
        {span && (
          <span className="ml-auto flex shrink-0 items-center">
            <SpanButton
              value={span.asked}
              chosen={span.from === 'placement'}
              fallback={{
                span: span.fallback.span,
                label: FROM_WORDS[span.fallback.from === 'placement' ? 'default' : span.fallback.from],
              }}
              room={span.room}
              clamped={span.clamped}
              shown={span.shown}
              onPick={span.onPick}
              testId={span.testId}
              title="Panel size in grid cells"
            />
          </span>
        )}
        <button
          type="button"
          className={`${span ? '' : 'ml-auto '}shrink-0 rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink`}
          onClick={onOpen}
          title="Open this app on its own, with its runs, secrets and versions"
          data-testid={openTestId}
        >
          Open
        </button>
        <IconButton label={remove.label} onClick={remove.onClick} testId={remove.testId} align="right">
          <CloseIcon size={14} />
        </IconButton>
      </div>
      {/* Focusable: the view's place in the Tab order,
          handing focus on to it (slots.ts) */}
      <div
        ref={slot}
        className="min-h-0 flex-1 outline-none"
        tabIndex={0}
        aria-label={`${title} view`}
        data-testid={slotTestId}
      />
      <DragShield viewKey={viewKey} dimmed={dragged} />
    </>
  )
}
