import { useLayoutEffect, useRef, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon, PlusIcon, SendIcon } from '../../components/icons.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { useStore, type ChatAttachment, type PinnedView } from '../../store/store.js'
import { isComposerSendKey } from '../session/composerKeys.js'
import type { AppBuilder } from './useAppBuilder.js'

/** The limit the input row grows to — about four lines. Beyond that it scrolls within its own box (it does not push the view down) */
const MAX_H = 96

/**
 * The "fix this" row (M4 C-5) — a thin input row below the pinned view. What is written here goes
 * to this app's builder session.
 *
 * **The person never leaves the app.** After sending, the view stays exactly as it was, and only a
 * one-line "sent" note and a way to open that conversation beside it ("Show") remain. Which app and
 * which view it came from is attached by the host as a header (`apps.askBuilder`) — this row does
 * not write that itself and send it. If the app is stopped or its last run failed, the host attaches
 * that fact too: "this button does not work" has to travel together with that failure.
 *
 * A pasted screenshot attaches through **the same path** as the composer (`attachFile` → the builder
 * session's attachment folder). Capturing the app's own view directly is a later step (plan C-5:
 * WKWebView does not open that path).
 *
 * When there is no builder session (a hand-created app, a deleted session, or a session that failed
 * to start when created), that fact and a button to start one take the place of the input row.
 * Nothing at all is shown for an app in an untrusted project, since one cannot be started there.
 */
export function FixBar({
  app,
  pv,
  builder,
  onShowBuilder,
}: {
  app: ExternalCatalogApp | undefined
  pv: PinnedView
  builder: AppBuilder
  onShowBuilder: () => void
}) {
  const platform = usePlatform()
  const attachFile = useStore((s) => s.attachFile)
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const builderName = useStore((s) => (builder.id ? s.sessions[builder.id]?.name : undefined))
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [busy, setBusy] = useState(false)
  /** Where it was just sent to — cleared once typing starts again */
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The height follows the value (the same rule as the composer — sending and clearing also restores the height)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`
  }, [text])

  if (!app || !app.info.trusted || builder.id === undefined) return null

  if (builder.id === null) {
    return (
      <div className="mt-2 flex items-center gap-3 rounded-md border border-dashed border-line px-3 py-1.5 text-sm" data-testid="fix-bar-no-builder">
        <p className="min-w-0 flex-1 text-ink-muted">
          {app.title} has no builder session, so there is no one to ask for changes.
          {builder.error && (
            <span className="block whitespace-pre-wrap break-words text-ink-faint" role="alert" data-testid="fix-bar-error">
              {builder.error}
            </span>
          )}
        </p>
        <button
          type="button"
          className="shrink-0 rounded-md border border-line bg-surface-floor px-2.5 py-0.5 text-ink transition-colors hover:border-line-strong disabled:opacity-40"
          onClick={() => void builder.start()}
          disabled={builder.starting}
          data-testid="fix-bar-start-builder"
        >
          {builder.starting ? 'Starting…' : 'Start builder'}
        </button>
      </div>
    )
  }

  const builderId = builder.id
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      const att = await attachFile(builderId, f)
      if (att) setAttachments((prev) => [...prev, att])
    }
  }
  const canSend = !busy && (text.trim() !== '' || attachments.length > 0)
  const submit = async () => {
    if (!canSend) return
    setBusy(true)
    setError(null)
    try {
      // The raw bytes (data) exist only for this row's own thumbnail — only the stored path is sent to the host (same as the composer)
      const files = attachments.map(({ data: _data, ...a }) => a)
      await platform.apps.askBuilder({
        appId: app.appId,
        projectId: app.projectId,
        text,
        ...(files.length ? { attachments: files } : {}),
        ...(pv.instanceId ? { instanceId: pv.instanceId } : {}),
      })
      setText('')
      setAttachments([])
      setSent(builderName ?? 'the builder')
    } catch (e) {
      // Exactly the host's own wording — the typed text and attachments are kept (so it can be sent again)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="mt-2 shrink-0"
      data-testid="fix-bar"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {attachments.length > 0 && (
        <ul className="mb-1 flex flex-wrap gap-1.5" data-testid="fix-bar-attachments">
          {attachments.map((a, i) => (
            <li key={`${a.path}-${i}`} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-0.5 text-xs text-ink-muted">
              <span className="readout text-2xs text-ink-faint">{a.kind === 'image' ? 'IMG' : 'DOC'}</span>
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                className="text-ink-faint transition-colors hover:text-ink"
                onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                aria-label={`Remove attachment ${a.name}`}
              >
                <CloseIcon size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-1.5 rounded-md border border-line bg-surface-raised px-2.5 py-1 transition-colors focus-within:border-line-strong">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSent(null)
          }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || e.key === 'Process'
            const key = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing }
            if (isComposerSendKey(key, sendWithModifierEnter)) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length === 0) return
            e.preventDefault()
            setSent(null)
            void takeFiles(files)
          }}
          placeholder={`Ask ${builderName ?? 'the builder'} to change this app…`}
          aria-label={`Ask the builder of ${app.title} to change it`}
          className="max-h-24 min-h-[20px] flex-1 resize-none bg-transparent py-0.5 text-sm leading-body text-ink placeholder:text-ink-faint focus:outline-none"
          data-testid="fix-bar-input"
        />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void takeFiles(e.target.files)} />
        <IconButton label="Attach a screenshot" onClick={() => fileRef.current?.click()} testId="fix-bar-attach" placement="top" className="shrink-0">
          <PlusIcon size={13} />
        </IconButton>
        <IconButton type="submit" label="Send to the builder" disabled={!canSend} testId="fix-bar-send" placement="top" align="right" className="shrink-0">
          <SendIcon size={14} />
        </IconButton>
      </div>
      {sent && !error && (
        <p className="mt-1 flex items-center gap-2 text-xs text-ink-faint" role="status" data-testid="fix-bar-sent">
          <span className="truncate">Sent to {sent}.</span>
          <button type="button" className="shrink-0 text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={onShowBuilder} data-testid="fix-bar-show-builder">
            Show the conversation
          </button>
        </p>
      )}
      {error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-muted" role="alert" data-testid="fix-bar-error">
          {error}
        </p>
      )}
    </form>
  )
}
