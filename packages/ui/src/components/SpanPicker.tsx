import { useEffect, useRef, useState, type RefObject } from 'react'
import { isPlainEscape } from '../app/keys.js'
import { createPortal } from 'react-dom'
import { GRID_SPAN_MAX, type GridSpan } from '@cc/protocol'
import { useAnchoredPlacement } from './anchored.js'

/**
 * Picking an app panel's span on the grid, in cells (#306) — the panel's top bar and Settings → Apps use the same
 * control, so the two never describe a size differently.
 *
 * A small button that says the span ("2×1") and opens a matrix of cells, GRID_SPAN_MAX by GRID_SPAN_MAX: pointing at a
 * cell shows the rectangle from the top-left corner to it, and picking it sets that span. Cells past what the grid has
 * room for at the window's size are drawn dashed and can still be picked — the span is kept and the panel stands at
 * the largest size that fits until there is room (core's `packGrid`). A last line goes back to the default, naming it.
 *
 * Rendered into `document.body` and placed `fixed`, like the background-task list (anchored.ts): a grid panel is
 * overflow-hidden, and the app's view is laid over the panel from outside it, so a popover hung under the button would
 * be clipped by the one and covered by the other.
 */

export const spanLabel = (s: GridSpan): string => `${s.cols}×${s.rows}`
const spanWords = (s: GridSpan): string => `${s.cols} × ${s.rows}`

export function SpanButton({
  value,
  chosen,
  fallback,
  room,
  clamped = false,
  shown,
  onPick,
  testId,
  title,
}: {
  /** The span asked for — what the button says */
  value: GridSpan
  /** The span was chosen at this level (bright), not inherited from the one below it (faint) */
  chosen: boolean
  /** What picking "default" falls back to, and in whose words: "from Settings", "the app's", … */
  fallback: { span: GridSpan; label: string }
  /** The largest span the grid has room for now — cells past it are dashed. Absent in Settings, where no grid is measured */
  room?: GridSpan
  /** The panel stands smaller than `value` asks, because the window has no room for it */
  clamped?: boolean
  /** The span it stands at, when clamped */
  shown?: GridSpan
  onPick: (span: GridSpan | null) => void
  testId: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  /*
   * Closes on an outside click, Esc, or the window losing focus — a click into an app's view never reaches this
   * document as a mousedown, but it takes focus out of it.
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!buttonRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    const onBlur = () => setOpen(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const hint = clamped && shown ? `This window fits ${spanWords(shown)}, so it stands at that until there is room` : null
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // A plain mousedown on the button must not start the header's drag (the header is draggable)
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        title={hint ? `${title}: ${spanWords(value)}. ${hint}` : `${title}: ${spanWords(value)}`}
        data-testid={testId}
        data-span={spanLabel(value)}
        data-chosen={chosen || undefined}
        data-clamped={clamped || undefined}
        className={`readout shrink-0 rounded-md border px-1.5 text-2xs transition-colors hover:border-line-strong hover:text-ink ${
          clamped ? 'border-dashed border-line-strong' : 'border-line'
        } ${chosen ? 'text-ink-muted' : 'text-ink-faint'}`}
      >
        {spanLabel(value)}
      </button>
      {open &&
        createPortal(
          <SpanPopover
            anchorRef={buttonRef}
            popRef={popRef}
            value={value}
            chosen={chosen}
            fallback={fallback}
            room={room}
            hint={hint}
            title={title}
            testId={testId}
            onPick={(s) => {
              setOpen(false)
              onPick(s)
            }}
          />,
          document.body,
        )}
    </>
  )
}

function SpanPopover({
  anchorRef,
  popRef,
  value,
  chosen,
  fallback,
  room,
  hint,
  title,
  testId,
  onPick,
}: {
  anchorRef: RefObject<HTMLElement | null>
  popRef: RefObject<HTMLDivElement | null>
  value: GridSpan
  chosen: boolean
  fallback: { span: GridSpan; label: string }
  room?: GridSpan
  hint: string | null
  title: string
  testId: string
  onPick: (span: GridSpan | null) => void
}) {
  const at = useAnchoredPlacement(anchorRef, popRef, true)
  const [hover, setHover] = useState<GridSpan | null>(null)
  const shownSpan = hover ?? value
  const past = (s: GridSpan) => !!room && (s.cols > room.cols || s.rows > room.rows)
  const sides = Array.from({ length: GRID_SPAN_MAX }, (_, i) => i + 1)
  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label={title}
      data-testid={`${testId}-picker`}
      className="fixed z-50 w-max overflow-y-auto rounded-md border border-line bg-surface-raised p-2.5 shadow-(--shadow-popover)"
      style={{
        top: at?.top ?? 0,
        left: at?.left ?? 0,
        maxHeight: at ? `${at.maxHeight}px` : undefined,
        visibility: at ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">{title}</span>
        <span className="readout text-2xs text-ink" data-testid={`${testId}-readout`}>
          {spanWords(shownSpan)}
        </span>
      </div>
      <div
        className="mt-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${GRID_SPAN_MAX}, 1.25rem)` }}
        onMouseLeave={() => setHover(null)}
      >
        {sides.flatMap((rows) =>
          sides.map((cols) => {
            const s = { cols, rows }
            const lit = cols <= shownSpan.cols && rows <= shownSpan.rows
            return (
              <button
                key={`${cols}x${rows}`}
                type="button"
                aria-label={spanWords(s)}
                aria-pressed={cols === value.cols && rows === value.rows}
                onMouseEnter={() => setHover(s)}
                onFocus={() => setHover(s)}
                onClick={() => onPick(s)}
                data-testid={`${testId}-cell-${cols}x${rows}`}
                className={`size-5 rounded-sm border transition-colors ${past(s) ? 'border-dashed' : ''} ${
                  lit ? 'border-ink-muted bg-ink-muted/40' : 'border-line-strong bg-surface-floor hover:bg-surface-hover'
                }`}
              />
            )
          }),
        )}
      </div>
      {room && past(shownSpan) && (
        <p className="mt-2 max-w-48 text-2xs leading-body text-ink-faint" data-testid={`${testId}-room`}>
          This window fits up to {spanWords(room)}. A larger panel stands at that until there is room.
        </p>
      )}
      {hint && !past(shownSpan) && (
        <p className="mt-2 max-w-48 text-2xs leading-body text-ink-faint" data-testid={`${testId}-hint`}>
          {hint}.
        </p>
      )}
      <button
        type="button"
        disabled={!chosen}
        onClick={() => onPick(null)}
        data-testid={`${testId}-default`}
        className="mt-2 block w-full rounded-md px-1.5 py-1 text-left text-xs text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink disabled:pointer-events-none disabled:opacity-50"
      >
        Use the default: {spanWords(fallback.span)}, {fallback.label}
      </button>
    </div>
  )
}
