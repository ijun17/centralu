import { useStore } from '../../store/store.js'
import type { KeptDraft } from '../../store/state/conversation.js'
import { Button } from '../../components/Button.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'

/** What the card says of a draft whose session is gone (#378 review) */
export function keptDraftLine(d: KeptDraft): string {
  return d.name ? `"${d.name}" was deleted. Your draft is kept here.` : 'A session was deleted. Your draft is kept here.'
}

/**
 * A draft whose session left the window (`keptDrafts`), oldest first, one at a time. It stays until copied or put
 * away: the toast's few seconds are the wrong length for words the person wrote.
 */
export function KeptDraftCard() {
  const kept = useStore((s) => s.keptDrafts[0])
  const dismiss = useStore((s) => s.dismissKeptDraft)
  const setToast = useStore((s) => s.setToast)
  if (!kept) return null
  const copy = () => {
    const write = navigator.clipboard?.writeText(kept.text)
    if (!write) {
      setToast('Could not copy: this window has no clipboard access')
      return
    }
    void write.then(
      () => {
        dismiss(kept.sessionId)
        setToast('Draft copied')
      },
      (e: Error) => setToast(`Could not copy: ${e.message}`),
    )
  }
  return (
    <div
      className="absolute bottom-16 left-1/2 z-30 flex max-w-[min(32rem,90%)] -translate-x-1/2 flex-col gap-1.5 rounded-md border border-line bg-surface-raised py-2 pl-3 pr-1.5 text-sm text-ink shadow-(--shadow-popover)"
      data-testid="kept-draft"
      role="status"
    >
      <div className="flex items-center gap-2">
        <span>{keptDraftLine(kept)}</span>
        <Button size="sm" className="ml-auto shrink-0" onClick={copy} data-testid="kept-draft-copy">
          Copy
        </Button>
        <IconButton label="Dismiss (the draft is not kept)" onClick={() => dismiss(kept.sessionId)} testId="kept-draft-dismiss" placement="top" align="right">
          <CloseIcon size={11} />
        </IconButton>
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap pr-1.5 text-xs text-ink-faint" data-testid="kept-draft-text">
        {kept.text}
      </p>
    </div>
  )
}
