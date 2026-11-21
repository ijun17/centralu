import { errorMessage } from '@cc/protocol/client'
import { Terminal as Xterm, type ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Platform } from '@cc/platform/ports'
import { useStore } from '../store/store.js'
import { registerTerminalHttpLinks } from './terminalLinks.js'
import { followTheme, terminalStyle } from './terminalTheme.js'

/** What `attach` returns: how the owner hears the terminal's size and what it tears down */
type XtermAttachment = {
  /** Called only when the size changed, never for a degenerate size */
  onSize?: (cols: number, rows: number) => void
  /** Runs after the resize observer is stopped and before the terminal itself goes away */
  dispose?: () => void
}

export type XtermAttach = (term: Xterm, fit: () => void) => XtermAttachment

/**
 * What the three xterms (a shell, a command's log in the terminal panel, the run dialog's log) share: theme colours and
 * font, fit, theme changes, `http(s)` links to the system browser, and the size reported on resize. It is the body of a
 * `useEffect`; return what it returns.
 *
 * The same size is never reported twice: a pty resize redraws the prompt, `fit()` wakes the ResizeObserver again, and
 * the loop would grow the prompt line endlessly.
 *
 * @param attach runs once the terminal is open and fitted; it may call `fit` itself (a shell does before writing its
 * history, so the history lands at the right size)
 * @returns tears everything down
 */
export function mountXterm(
  el: HTMLElement,
  platform: Platform,
  kind: 'shell' | 'log',
  options: ITerminalOptions,
  attach: XtermAttach,
): () => void {
  const term = new Xterm({
    ...terminalStyle(el, kind),
    ...options,
    allowProposedApi: true,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(el)

  const fit = () => {
    try {
      fitAddon.fit()
    } catch {
      // No layout yet: fitted on the next opportunity
    }
  }
  // Filled in once `attach` has run; a resize that comes sooner has nobody to tell yet
  let attachment: XtermAttachment = {}
  const lastDims = { cols: 0, rows: 0 }
  const syncSize = () => {
    fit()
    const { cols, rows } = term
    if (cols < 2 || rows < 2) return
    if (cols === lastDims.cols && rows === lastDims.rows) return
    lastDims.cols = cols
    lastDims.rows = rows
    attachment.onSize?.(cols, rows)
  }

  const unfollow = followTheme(term, el, kind, syncSize)
  const links = registerTerminalHttpLinks(term, (url) => {
    void platform.system
      .openUrl(url)
      .catch((e) => useStore.getState().setToast(`Could not open ${url}: ${errorMessage(e)}`))
  })

  attachment = attach(term, fit)
  // A new xterm starts at its default size: the owner is told once, whatever it was before
  syncSize()

  // Untold of a resize, the shell wraps lines wrongly; one frame's delay coalesces rapid changes
  let pending = 0
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(pending)
    pending = requestAnimationFrame(syncSize)
  })
  ro.observe(el)

  return () => {
    cancelAnimationFrame(pending)
    ro.disconnect()
    attachment.dispose?.()
    unfollow()
    links.dispose()
    term.dispose()
  }
}
