import { useState } from 'react'
import type { ExternalSession } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useLoad } from '../../app/useLoad.js'
import { RelativeAge } from '../../components/RelativeAge.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'

/**
 * A new session's empty screen offers the project's past conversations of this tool.
 *
 * Writing in the composer goes on as the new session it is. Picking a past conversation instead
 * starts a session that resumes it (with its history on screen, as the new-session dialog's "Load"
 * does) and removes this empty one, which held nothing yet. A conversation already open in Centralu
 * is a jump to that session, never a second copy.
 *
 * It took the place of the sidebar's second button (the chevron that opened the dialog only to
 * offer this list): the choice now sits where the person already is when they start.
 */
export function PastConversations({ sessionId, projectId, tool }: { sessionId: string; projectId: string; tool: string }) {
  const platform = useStore((s) => s.platform)
  const createSession = useStore((s) => s.createSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const focusSession = useStore((s) => s.focusSession)
  const askComposerFocus = useStore((s) => s.askComposerFocus)
  const setToast = useStore((s) => s.setToast)
  const [busy, setBusy] = useState<string | null>(null)
  const listed = useLoad(
    () => (platform ? platform.agents.listExternalSessions(projectId, tool) : Promise.resolve(null)),
    [platform, projectId, tool],
  )
  const sessions = listed.data?.supported ? listed.data.sessions : []
  // Read again for each tool the empty screen switches to: the list's shape stands there meanwhile
  if (listed.loading && !listed.data) return <PastSkeleton />
  if (sessions.length === 0) return null

  const pick = async (s: ExternalSession) => {
    if (busy) return
    if (s.importedAs) {
      focusSession(s.importedAs)
      askComposerFocus(s.importedAs)
      void deleteSession(sessionId).catch(() => {})
      return
    }
    setBusy(s.externalId)
    try {
      const created = await createSession(projectId, { tool, resumeExternalId: s.externalId, importHistory: true })
      askComposerFocus(created.id)
      // The empty session held nothing: no message, no turn. Removing it keeps the sidebar to the one the person chose
      void deleteSession(sessionId).catch(() => {})
    } catch (e) {
      setToast(`Could not load that conversation: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-5" data-testid="past-conversations">
      <p className="mb-1.5 text-xs text-ink-faint">Or continue a past conversation</p>
      <div className="max-h-72 overflow-y-auto rounded-md border border-line bg-surface-raised">
        {sessions.map((s) => (
          <button
            key={s.externalId}
            type="button"
            disabled={busy !== null}
            onClick={() => void pick(s)}
            data-testid={`past-conversation-${s.externalId}`}
            className="flex w-full flex-col gap-0.5 border-l-2 border-l-transparent px-2.5 py-1.5 text-left text-ink-muted transition-colors hover:bg-surface-hover/20 hover:text-ink disabled:opacity-60"
          >
            <span className="truncate text-sm leading-tight">{busy === s.externalId ? 'Loading…' : s.title}</span>
            <span className="readout truncate text-2xs text-ink-faint">
              last <RelativeAge when={s.updatedAt} />
              {s.branch && ` · ${s.branch}`}
              {s.importedAs && ' · Already open · click to jump'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** The list while it is read: the heading as it will stand, and three rows of a title over a dim line */
function PastSkeleton() {
  return (
    <div className="mt-5" data-testid="past-conversations-loading">
      <p className="mb-1.5 text-xs text-ink-faint">Or continue a past conversation</p>
      <div className="rounded-md border border-line bg-surface-raised">
        {[0, 1, 2].map((i) => (
          <SkeletonLines key={i} lines={2} className="px-2.5 py-2" label="Looking for past conversations" />
        ))}
      </div>
    </div>
  )
}
