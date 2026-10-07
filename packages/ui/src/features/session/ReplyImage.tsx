import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageImage } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { loadReplyImage } from './localImages.js'
import { ZoomableImage } from './ZoomableImage.jsx'

type Shown = { kind: 'waiting' } | { kind: 'answer'; answer: MessageImage } | { kind: 'failed'; message: string }

/**
 * A local image an agent wrote into its reply, read by the session's host (`messages.image`).
 *
 * Asked only once the row is near the screen: the conversation is a virtual list, so a row far away is not even
 * mounted, but one long reply can name a dozen screenshots, and the bytes of the ones below the fold need not cross
 * the socket until someone scrolls to them.
 *
 * When the host does not send a picture, the reason stands where the picture would have been, with the path the reply
 * wrote and the alt text, rather than the browser's broken-image mark: the person can tell a picture the agent never
 * saved from one that is too large or not a picture at all, and reveal the file in the file manager when it is on
 * this computer.
 */
export function ReplyImage({ path, alt, sessionId }: { path: string; alt: string; sessionId: string }) {
  const platform = useStore((s) => s.platform)
  const [shown, setShown] = useState<Shown>({ kind: 'waiting' })
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  const box = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (near) return
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  useEffect(() => {
    if (!near || !platform) return
    let live = true
    loadReplyImage((sid, p) => platform.agents.messageImage(sid, p), sessionId, path).then(
      (answer) => live && setShown({ kind: 'answer', answer }),
      (e: unknown) => live && setShown({ kind: 'failed', message: `Could not ask for this image: ${(e as Error).message}` }),
    )
    return () => {
      live = false
    }
  }, [near, platform, sessionId, path])

  const answer = shown.kind === 'answer' ? shown.answer : null
  const src = useMemo(() => (answer?.ok ? `data:${answer.mime};base64,${answer.data}` : null), [answer])
  const [undrawable, setUndrawable] = useState(false)

  if (src && !undrawable) {
    return (
      <span className="my-1 block min-w-0" data-testid="reply-image" data-path={path}>
        <ZoomableImage src={src} alt={alt || path} thumbClassName="max-h-80 max-w-full rounded-lg border border-line" onError={() => setUndrawable(true)} />
      </span>
    )
  }
  if (shown.kind === 'waiting') {
    return (
      <span
        ref={box}
        className="my-1 block h-20 w-full max-w-60 rounded-lg border border-line bg-surface-raised"
        data-testid="reply-image-waiting"
        data-path={path}
        aria-label={alt ? `Loading the image ${alt}` : 'Loading an image'}
      />
    )
  }
  const refused = answer && !answer.ok ? answer : null
  const message = undrawable ? 'The window could not draw this image' : shown.kind === 'failed' ? shown.message : (refused?.message ?? '')
  return (
    <ImageNotShown
      alt={alt}
      path={path}
      reason={undrawable ? 'undrawable' : (refused?.reason ?? 'failed')}
      message={message}
      file={answer?.file}
      sessionId={sessionId}
    />
  )
}

/** In place of a picture: what it was meant to be, where it was, why it is not here, and a way to go and look */
function ImageNotShown({
  alt,
  path,
  reason,
  message,
  file,
  sessionId,
}: {
  alt: string
  path: string
  reason: string
  message: string
  file: string | undefined
  sessionId: string
}) {
  const platform = useStore((s) => s.platform)
  const setToast = useStore((s) => s.setToast)
  // The file manager is this computer's; a session on a linked machine has its file there (#82). The hub drops the
  // path from such an answer already, so this is the second of two locks, and the one that says why
  const remote = useStore((s) => !!s.sessions[sessionId]?.machine)
  const reveal = file && !remote && platform ? file : null
  return (
    <span
      className="my-1 block max-w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink-faint"
      data-testid="reply-image-refused"
      data-reason={reason}
    >
      <span className="block text-ink-muted">{alt ? `Image not shown: ${alt}` : 'Image not shown'}</span>
      <span className="readout block truncate text-xs" title={path} data-testid="reply-image-path">
        {path}
      </span>
      {message && (
        <span className="block text-xs" data-testid="reply-image-reason">
          {message}
        </span>
      )}
      {reveal && platform && (
        <button
          type="button"
          className="readout mt-1 text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
          data-testid="reply-image-reveal"
          onClick={() => {
            platform.fs.revealMessageImage(reveal).then(
              (res) => {
                if (!res.supported) setToast(res.reason ?? 'Showing files is not available here')
              },
              (e: unknown) => setToast(`Could not show ${reveal}: ${(e as Error).message}`),
            )
          }}
        >
          Reveal in {platform.capabilities.fileManagerName}
        </button>
      )}
    </span>
  )
}
