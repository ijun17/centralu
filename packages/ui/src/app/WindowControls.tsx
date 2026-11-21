import { errorMessage } from '@cc/protocol/client'
import { useStore } from '../store/store.js'
import { WindowCloseIcon, WindowMaxIcon, WindowMinIcon } from '../components/icons.jsx'
import type { WindowAction } from '@cc/platform/ports'

/**
 * Where the OS draws no title bar (Windows, owner 2026-10-18), as the capability `windowControls` says. Shaped as the
 * OS draws them (46px, full bar height, flush right, close red on hover); outside the drag region, so a press is a press.
 */
export function WindowControls() {
  const act = (action: WindowAction) => {
    const platform = useStore.getState().platform
    void platform?.system.windowAction(action).catch((e: unknown) => useStore.getState().setToast(errorMessage(e)))
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
