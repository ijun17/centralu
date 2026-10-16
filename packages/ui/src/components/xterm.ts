import { Terminal as Xterm, type ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Platform } from '@cc/platform/ports'
import { useStore } from '../store/store.js'
import { registerTerminalHttpLinks } from './terminalLinks.js'
import { followTheme, terminalStyle } from './terminalTheme.js'

/**
 * What the screen that owns an xterm hands to `mountXterm`: the `attach` step wires the terminal to
 * its stream (a shell, a command's log), and what it returns tells the shared part how big the
 * terminal is and what to tear down.
 */
export type XtermAttachment = {
  /** Called with the new size, **only when it actually changed** (never for a degenerate size) */
  onSize?: (cols: number, rows: number) => void
  /** Runs after the resize observer is stopped and before the terminal itself goes away */
  dispose?: () => void
}

export type XtermAttach = (term: Xterm, fit: () => void) => XtermAttachment

/**
 * The part the three xterms (a shell, a command's log in the terminal panel, the run dialog's log)
 * have in common: create it in the theme's colours and font, fit it to its element, keep it in step
 * with theme changes, open `http(s)` links in the system browser, and report the size to the owner
 * whenever the element is resized.
 *
 * It is the body of a `useEffect`: call it with the host element, return what it returns, and list
 * the owner's identity in that effect's dependencies.
 *
 * **The same size is never reported twice.** A pty resize makes the shell redraw its prompt, but
 * `fit()` touches the element's layout, which wakes the ResizeObserver again — without this guard a
 * feedback loop would keep running even when the size never changed, and on screen the prompt line
 * would grow endlessly (a finding from dogfooding).
 *
 * @param attach runs once the terminal is open and fitted; it may call `fit` itself (a shell does,
 * before writing its history, so the history lands in a terminal of the right size)
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
    // Colours, font and size come from the theme (styles/index.css, --color-term-*)
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
      // There are times layout does not exist yet — it gets fitted on the next opportunity
    }
  }
  // Filled in once `attach` has run; a resize that comes sooner has nobody to tell yet
  let attachment: XtermAttachment = {}
  const lastDims = { cols: 0, rows: 0 }
  /** Fits, then notifies the owner **only when the size has actually changed** */
  const syncSize = () => {
    fit()
    const { cols, rows } = term
    if (cols < 2 || rows < 2) return
    if (cols === lastDims.cols && rows === lastDims.rows) return
    lastDims.cols = cols
    lastDims.rows = rows
    attachment.onSize?.(cols, rows)
  }

  // A new code font changes the cell size: refit, and tell the owner its new size
  const unfollow = followTheme(term, el, kind, syncSize)
  const links = registerTerminalHttpLinks(term, (url) => {
    void platform.system
      .openUrl(url)
      .catch((e) => useStore.getState().setToast(`Could not open ${url}: ${(e as Error).message}`))
  })

  attachment = attach(term, fit)
  // A new xterm starts at its default size — the owner is told once, whatever it was before
  syncSize()

  // If the panel width or window size changes, the owner has to be told too, or line wrapping
  // breaks. The observer callback is deferred by one frame to coalesce rapid changes into one.
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
