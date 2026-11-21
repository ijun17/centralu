import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolName, ToolSetup, ToolStatus } from '@cc/protocol/client'
import type { MachineRef } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { loadErrorText } from '../../app/useLoad.js'
import { useWhileVisible } from '../../app/useWhileVisible.js'
import { useStore } from '../../store/store.js'
import { setupStates, withLiveSetups } from './setupLine.js'

/** `withLiveSetups` for a list read on this computer; a linked machine's list is returned as read */
export function useLiveTools(tools: ToolStatus[] | null, machine?: MachineRef | null): ToolStatus[] | null {
  // Keyed by states: install progress (a reading every MiB) must not make a new list, which readers re-ask capabilities for
  const states = useStore((s) => setupStates(s.toolSetups))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `states` is the key: the setups are read at that moment, not on every reading
  return useMemo(() => (tools && !machine ? withLiveSetups(tools, useStore.getState().toolSetups) : tools), [tools, states, machine])
}

/** How often a linked machine's install is asked about while it runs: its `tool_setup` events do not reach this window */
const LINKED_POLL_MS = 1500

/**
 * A setup line's install, sign-in and cancels. Each answers with the setup as it stands, taken in without waiting for
 * the event (into the store here; re-asked, and polled while installing, for a linked machine). A refusal sets `error`.
 */
export function useToolSetupActions(tool: ToolName, machine: MachineRef | null | undefined, installing: boolean, redetect?: () => void) {
  const platform = usePlatform()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const linked = !!machine

  const run = useCallback(
    async (act: () => Promise<ToolSetup>) => {
      setBusy(true)
      setError(null)
      const before = useStore.getState().toolSetups[tool]
      try {
        const setup = await act()
        // Taken in only if no event came meanwhile: an event is the host's later word than this answer
        if (!linked && useStore.getState().toolSetups[tool] === before) useStore.setState((s) => ({ toolSetups: { ...s.toolSetups, [tool]: setup } }))
        else redetect?.()
      } catch (e) {
        setError(loadErrorText(e))
      } finally {
        setBusy(false)
      }
    },
    [linked, redetect, tool],
  )

  // Not while the window is hidden, and asked at once when it is shown again
  useWhileVisible(() => redetect?.(), LINKED_POLL_MS, { onReturn: 'always', enabled: linked && installing && !!redetect }, [redetect])

  return {
    busy,
    error,
    install: () => run(() => platform.agents.installTool(tool, machine ?? undefined)),
    cancelInstall: () => run(() => platform.agents.cancelInstallTool(tool, machine ?? undefined)),
    signIn: () => run(() => platform.agents.signInTool(tool)),
    cancelSignIn: () => run(() => platform.agents.cancelSignInTool(tool)),
    openVerify: (uri: string) => void platform.system.openUrl(uri).catch((e: unknown) => setError(loadErrorText(e))),
  }
}

/** Reads the tools again when the host comes back: an install or sign-in read before the drop may be stale */
export function useReloadOnReconnect(reload: () => Promise<void>): void {
  const connection = useStore((s) => s.connection)
  const was = useRef(connection)
  useEffect(() => {
    if (connection === 'connected' && was.current !== 'connected') void reload()
    was.current = connection
  }, [connection, reload])
}
