import { useEffect } from 'react'
import { useStore } from '../../store/store.js'
import { CodeViewer } from '../viewer/CodeViewer.jsx'
import { GitPanel } from '../git/GitPanel.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * The wide surface — it covers the conversation, and nothing else.
 *
 * Why not inside the right-hand panel: what the viewer is really for here is checking a
 * diff an agent just wrote, and a diff is unreadable at 340px.
 *
 * Why it no longer covers that panel as well: the sentence above got read as "so take the
 * panel's width too", which does not follow from it. The overlay competes with the
 * *conversation* for room, not with the panel. Covering the panel took away the file tree
 * and the change list — the thing you use to open the next file — so the shape of the work
 * became: click a file, watch the tree disappear, press escape, click the next one. Giving
 * up ~340px of diff to stop that is cheap, because the diff is unified: the loss is line
 * width, not a whole column (issue #15). It applies to both kinds, and the `git` kind is
 * the worse of the two to cover, since the list it was opened from is the list you are
 * working down.
 *
 * Why it covers the conversation rather than replacing it: reading code is deep but
 * **short**. Draw the cover back and the conversation is exactly as you left it, scroll
 * position included — the most expensive resource in this app is a person's attention, and
 * making them find their place again on the way back spends it.
 *
 * `inset-0` does not decide **what** gets covered; the parent does. So which lane this
 * component is mounted inside *is* the answer to that question — see Body in App.tsx.
 */
export function Overlay() {
  const overlay = useStore((s) => s.overlay)
  const close = useStore((s) => s.closeOverlay)
  const projectId = useStore((s) => {
    // If whatever opened it stated a project, that is the answer — the grid's cross-panel link (#182)
    if (s.overlay?.kind === 'viewer' && s.viewerProjectId) return s.viewerProjectId
    // A session with no project (the foreman) does not fall back to the last project — same rule as EvidencePanel
    const sess = s.focusedSessionId ? s.sessions[s.focusedSessionId] : null
    return sess ? sess.projectId : s.focusedProjectId
  })

  /*
   * Dismissed with Esc. It has to dismiss even when pressed inside an input field — the person must
   * not get trapped behind the cover.
   *
   * **But only when this layer is on top and the key actually came from this layer** (#181).
   * Intercepting it in the window's capture phase means it arrives before every other element, so
   * Esc meant for the terminal (vim, less) in the evidence panel visible right next to it never
   * reached the terminal, and the overlay closed instead. It was also intercepting Esc meant for a
   * settings dialog or a modal open above it, closing the hidden overlay underneath and leaving the
   * settings dialog needing a second press to close.
   */
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!overlayTakesEscape(useStore.getState(), e.target)) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [overlay, close])

  if (!overlay || !projectId) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface-floor" data-testid="overlay">
      <header className="flex items-center gap-2 border-b border-line bg-surface-side px-3 py-1.5">
        <span className="text-[11px] uppercase text-ink-faint">
          {overlay.kind === 'git' ? 'Git' : 'Files'}
        </span>
        <button
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
          onClick={close}
          data-testid="overlay-close"
        >
          <Kbd>esc</Kbd> back to chat
        </button>
      </header>
      {overlay.kind === 'viewer' ? (
        <CodeViewer projectId={projectId} />
      ) : (
        <GitPanel
          projectId={projectId}
          initialPath={overlay.path}
          initialStaged={overlay.staged}
          initialSha={overlay.sha}
          initialSub={overlay.sub}
          pick={overlay.pick}
        />
      )}
    </div>
  )
}

/**
 * Does the overlay claim this Esc (#181)? If another layer (a modal, a command window, settings,
 * the palette, the inbox, usage) is open above it, the key belongs to that layer, and a key coming
 * from the evidence panel next to the overlay belongs to that panel instead (Esc inside the
 * terminal).
 */
export function overlayTakesEscape(
  st: { openLayers: number; settingsOpen: boolean; paletteOpen: boolean; inboxOpen: boolean; usageOpen: boolean },
  target: EventTarget | null,
): boolean {
  if (st.openLayers > 0 || st.settingsOpen || st.paletteOpen || st.inboxOpen || st.usageOpen) return false
  const el = target as Element | null
  return !(el && typeof el.closest === 'function' && el.closest('[data-testid="evidence-panel"]'))
}

