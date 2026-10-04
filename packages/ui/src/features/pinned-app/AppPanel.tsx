import { useLayoutEffect, useRef, type DragEvent } from 'react'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppIcon, CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { registerSlot } from './slots.js'

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
 */
export function AppPanel({
  app,
  appId,
  viewKey,
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
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-edge px-4 active:cursor-grabbing"
        draggable
        onDragStart={onDragStart}
        data-testid="pane-header"
      >
        <span className="text-ash">
          <AppIcon />
        </span>
        <span
          className="truncate text-[13px] font-medium tracking-tight text-chalk"
          data-testid="app-panel-title"
        >
          {title}
        </span>
        {app && (
          <span className="readout shrink-0 text-[10px] text-slate" data-testid="app-panel-status">
            {app.status.label}
          </span>
        )}
        <button
          type="button"
          className="ml-auto shrink-0 rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
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
      <div ref={slot} className="min-h-0 flex-1" data-testid={slotTestId} />
    </>
  )
}
