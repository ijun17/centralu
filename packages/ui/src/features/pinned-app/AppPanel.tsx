import { useLayoutEffect, useRef, type DragEvent } from 'react'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { registerSlot } from './slots.js'
import { DragShield } from './dragShield.jsx'

/**
 * An app's panel, on the project screen (#203) or the grid (#288): a header that moves the panel,
 * and a slot its view is laid over (slots.ts) — the view itself stands in PinnedApps, because an
 * iframe that moves loses its document.
 *
 * The pinned view's own header (Runs, Secrets, Versions, Builder, close) is not drawn in a panel —
 * each of those opens a side panel a slot has no room for. "Open" goes to the app view, where they
 * are.
 *
 * The header says the app's name and its status in words (`app.status.label`: running, stopped,
 * untrusted…), as the sidebar row does; why an app cannot run is said by the view itself in the
 * slot, with its reason and its button, never a blank frame.
 *
 * While anything is dragged the panel lays a transparent cover over its view (dragShield.tsx), so a drag over the view
 * is the panel's to hear, not the frame's. The view stays in sight; the dragged panel's own view is dimmed with it.
 */
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
}: {
  /** The app as the list has it — undefined for a moment while the list is read again */
  app: ExternalCatalogApp | undefined
  appId: string
  /** The key of the view laid over this panel's slot: the app's pinned view, or its grid view */
  viewKey: string
  /** This panel is the one being dragged */
  dragged: boolean
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onOpen: () => void
  remove: { label: string; testId: string; onClick: () => void }
  slotTestId: string
  openTestId: string
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
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line px-4 active:cursor-grabbing"
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
        <button
          type="button"
          className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink"
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
      {/*
        Focusable: the view laid over it is after every panel in the document, so this is where Tab from the header
        reaches it — focus is handed on to the view (slots.ts).
      */}
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
