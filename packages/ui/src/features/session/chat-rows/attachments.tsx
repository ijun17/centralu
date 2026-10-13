import { memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { type ChatAttachment } from '../../../store/store.js'
import { CloseIcon } from '../../../components/icons.jsx'
import { ZoomableImage } from '../ZoomableImage.jsx'

/*
 * What a person attached, drawn in the sent bubble and in the composer before sending (#284).
 * Both sides decide "thumbnail or chip" by the same rule (`AttachmentThumb`).
 */

/**
 * An attachment shown as itself when it can be: an image with bytes becomes a zoomable thumbnail,
 * anything else — a file, an image whose bytes are gone (cleaned up past the 500MB cap after a
 * restart), or bytes the browser cannot decode — becomes `chip`.
 *
 * Shared by the sent bubble and the composer (#284), so that what is about to be sent and what was
 * sent are decided by the same rule: an image that would show as a chip in the bubble shows as a
 * chip in the composer too. `frame` wraps the thumbnail; each side adds its own surroundings (the
 * composer's remove button).
 *
 * The data URL is memoised. The composer re-renders on every keystroke, and building a string the
 * size of a screenshot for each one would hand React a new multi-megabyte `src` to compare every
 * time; the same string object compares by identity.
 */
function AttachmentThumb({
  att,
  thumbClassName,
  chip,
  frame,
}: {
  att: ChatAttachment
  thumbClassName: string
  chip: ReactNode
  frame: (img: ReactNode) => ReactNode
}) {
  const [broken, setBroken] = useState(false)
  const src = useMemo(() => (att.data ? `data:${att.mime};base64,${att.data}` : null), [att.mime, att.data])
  if (att.kind !== 'image' || !src || broken) return <>{chip}</>
  return frame(<ZoomableImage src={src} alt={att.name} thumbClassName={thumbClassName} onError={() => setBroken(true)} />)
}

/**
 * What an attachment's chip says: a short kind label and the name.
 *
 * No emoji here — they look different across OS and font, and most are in color, which
 * immediately breaks the rule "color belongs only to the diff body". A short text label has
 * neither problem.
 */
function AttachmentLabel({ att }: { att: ChatAttachment }) {
  return (
    <>
      <span className="readout text-2xs text-ink-faint" title={att.kind === 'image' ? 'Image' : 'File'}>
        {att.kind === 'image' ? 'IMG' : 'DOC'}
      </span>
      <span className="max-w-40 truncate">{att.name}</span>
    </>
  )
}

/**
 * A single attachment the person sent along with a message.
 *
 * An image stands as a real thumbnail; anything that cannot (see AttachmentThumb) falls back to
 * the same notation as the composer's chip (IMG/DOC plus a name) — what was sent has to remain
 * visible even once the bytes are gone.
 */
export function UserAttachment({ att }: { att: ChatAttachment }) {
  return (
    <AttachmentThumb
      att={att}
      /* Sits next to a message bubble, so its cap is set lower than an agent image's */
      thumbClassName="max-h-48 max-w-full rounded-lg border border-ink-faint/40"
      chip={
        <span
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-ink-muted"
          data-testid="msg-user-attachment"
          title={att.name}
        >
          <AttachmentLabel att={att} />
        </span>
      }
      frame={(img) => <span data-testid="msg-user-attachment">{img}</span>}
    />
  )
}

/**
 * The composer's attachments, before sending (#284).
 *
 * An image shows as a small thumbnail rather than an `IMG` chip: a pasted screenshot's name is
 * generated, so the chip said nothing about which image it was, and the person found out only
 * after sending. A file keeps its chip, and so does an image that cannot be drawn (AttachmentThumb).
 *
 * **Every item sits in a row of one fixed height** (`h-12`, the thumbnail's height). Items of
 * different heights would make the strip, and with it the composer, grow and shrink as a thumbnail
 * is added, removed or falls back to a chip — the composer jumping under the hand while typing,
 * and the measured card height (composerH) shifting the conversation's bottom margin each time.
 * With one row height the strip only changes height when it wraps to another row, and several
 * thumbnails wrap into even rows.
 *
 * Memoised: the strip's props do not change on a keystroke (the draft's attachment array keeps its
 * identity when only the text changes), so typing does not re-render the thumbnails.
 */
export const AttachmentStrip = memo(function AttachmentStrip({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: ChatAttachment[]
  uploading: number
  onRemove: (index: number) => void
}) {
  return (
    <ul className="mb-1.5 flex flex-wrap items-center gap-1.5" data-testid="attachment-list">
      {uploading > 0 && (
        <li className="flex h-12 items-center">
          <span
            className="flex items-center gap-1.5 rounded-md border border-dashed border-line px-2 py-1 text-xs text-ink-faint"
            data-testid="attachment-uploading"
          >
            Attaching {uploading === 1 ? 'a file' : `${uploading} files`}…
          </span>
        </li>
      )}
      {attachments.map((a, i) => {
        const remove = (
          <button
            type="button"
            className="text-ink-faint transition-colors hover:text-ink"
            onClick={() => onRemove(i)}
            aria-label={`Remove attachment ${a.name}`}
          >
            <CloseIcon size={11} />
          </button>
        )
        return (
          <li key={`${a.path}-${i}`} className="flex h-12 items-center" data-testid="attachment-item">
            <AttachmentThumb
              att={a}
              /*
               * The row's height, a width between square and twice that, cropped to fill — a
               * wide screenshot and a tall one take a similar, bounded footprint. Clicking it
               * opens the same zoom as the sent bubble's thumbnail.
               */
              thumbClassName="h-12 w-auto min-w-12 max-w-24 rounded-md border border-line object-cover"
              chip={
                <span
                  className="flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-ink-muted"
                  data-testid="attachment-chip"
                  title={a.name}
                >
                  <AttachmentLabel att={a} />
                  {remove}
                </span>
              }
              frame={(img) => (
                /*
                 * The remove button sits on the thumbnail's corner over a dimmed backing, so it
                 * reads on a light screenshot as well as a dark one without adding a color.
                 */
                <span className="relative block" data-testid="attachment-thumb">
                  {img}
                  <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-md bg-surface-floor/80">
                    {remove}
                  </span>
                </span>
              )}
            />
          </li>
        )
      })}
    </ul>
  )
})
