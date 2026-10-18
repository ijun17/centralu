import { useStore } from '../store/store.js'
import { WindowCloseIcon, WindowMaxIcon, WindowMinIcon } from '../components/icons.jsx'
import type { WindowAction } from '@cc/platform/ports'

/**
 * Minimize, maximize and close, at the right end of the top bar, where the OS draws no title bar of its own (Windows,
 * owner 2026-10-18: one strip, as on macOS). The capability `windowControls` says when; the UI never asks the OS.
 *
 * Shaped as the OS draws them, so a hand finds them where it expects: 46px wide, the bar's full height, flush with the
 * window's right edge, the close turning red on hover. Not part of the drag region, so a press is a press.
 */
export function WindowControls() {
  const act = (action: WindowAction) => {
    const platform = useStore.getState().platform
    void platform?.system.windowAction(action).catch((e: Error) => useStore.getState().setToast(e.message))
  }
  const base = 'flex h-full w-[46px] items-center justify-center text-ink-muted transition-colors'
  return (
    <span className="-mr-4 flex h-full self-stretch" data-testid="window-controls">
      <button type="button" className={`${base} hover:bg-surface-hover/70 hover:text-ink`} onClick={() => act('minimize')} aria-label="Minimize" title="Minimize" data-testid="window-minimize">
        <WindowMinIcon />
      </button>
      <button type="button" className={`${base} hover:bg-surface-hover/70 hover:text-ink`} onClick={() => act('toggleMaximize')} aria-label="Maximize" title="Maximize" data-testid="window-maximize">
        <WindowMaxIcon />
      </button>
      <button type="button" className={`${base} hover:bg-[#c42b1c] hover:text-white`} onClick={() => act('close')} aria-label="Close" title="Close" data-testid="window-close">
        <WindowCloseIcon />
      </button>
    </span>
  )
}
