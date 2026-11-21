import { useEffect } from 'react'
import { isPlainEscape } from '../../app/keys.js'
import { evidenceProjectOf, useStore } from '../../store/store.js'
import { isCovered, type CoveringLayers } from '../../store/layers.js'
import { Kbd } from '../../components/primitives.jsx'
import { Button } from '../../components/Button.jsx'
import { useFocusReturn } from '../../components/focusReturn.js'
import { lazyComponent } from '../../components/lazy.jsx'

// Both load when the overlay first opens (components/lazy.tsx)
const CodeViewer = lazyComponent(() => import('../viewer/CodeViewer.jsx').then((m) => m.CodeViewer))
const GitPanel = lazyComponent(() => import('../git/GitPanel.jsx').then((m) => m.GitPanel))

/**
 * The wide surface over the conversation (docs/architecture.md "The viewer is a wide overlay"). It leaves the evidence lane
 * visible: that list opens the next file, and a unified diff loses only line width (#15). The lane it is mounted in (Body in
 * App.tsx) decides what `inset-0` covers.
 */
export function Overlay() {
  const overlay = useStore((s) => s.overlay)
  // Esc gives the keyboard back to where it was, the composer included (#115)
  useFocusReturn(overlay !== null)
  const close = useStore((s) => s.closeOverlay)
  // A project stated by the opener wins (the grid's cross-panel link, #182)
  const projectId = useStore((s) =>
    s.overlay?.kind === 'viewer' && s.viewerProjectId ? s.viewerProjectId : evidenceProjectOf(s),
  )
  // The session a file link named, whose folder (its worktree) the file is read from (#1209); only with its project
  const sessionId = useStore((s) => (s.overlay?.kind === 'viewer' && s.viewerProjectId ? s.viewerSessionId : null))

  // Esc in the capture phase, so it closes even from an input; `overlayTakesEscape` keeps it from a layer above and from
  // the terminal beside it (vim, less) (#181).
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return
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
      {/* The panel's header height, so the two header lines meet across the window */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-chrome bg-surface-side px-3">
        <span className="text-sm text-ink-muted">{overlay.kind === 'git' ? 'Git' : 'Files'}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto flex items-center gap-1.5"
          onClick={close}
          data-testid="overlay-close"
        >
          <Kbd>esc</Kbd> Back to chat
        </Button>
      </header>
      {overlay.kind === 'viewer' ? (
        <CodeViewer projectId={projectId} sessionId={sessionId} />
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

/** Not when a layer above is open (modal, palette, settings…), nor for a key from the evidence panel beside it (#181) */
export function overlayTakesEscape(st: CoveringLayers, target: EventTarget | null): boolean {
  if (isCovered(st, 'overlay')) return false
  const el = target as Element | null
  return !(el && typeof el.closest === 'function' && el.closest('[data-testid="evidence-panel"]'))
}
