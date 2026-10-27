import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolName, ToolSetup, ToolStatus } from '@cc/protocol/client'
import type { MachineRef } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { loadErrorText } from '../../app/useLoad.js'
import { useStore } from '../../store/store.js'
import { setupStates, withLiveSetups } from './setupLine.js'

/**
 * The detection with this computer's live setups over it (`withLiveSetups`), for a list read on this computer; a linked
 * machine's list is its own and is returned as read.
 */
export function useLiveTools(tools: ToolStatus[] | null, machine?: MachineRef | null): ToolStatus[] | null {
  // Keyed by the states, not the setups: an install's progress (a reading every MiB) must not make a new list, which every reader would ask capabilities for again
  const states = useStore((s) => setupStates(s.toolSetups))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `states` is the key: the setups are read at that moment, not on every reading
  return useMemo(() => (tools && !machine ? withLiveSetups(tools, useStore.getState().toolSetups) : tools), [tools, states, machine])
}

/** How often a linked machine's install is asked about while it runs: its `tool_setup` events do not reach this window */
const LINKED_POLL_MS = 1500

/**
 * The actions of a tool's setup line: Centralu's install and sign-in (`agents.installTool`, `agents.signIn`) and their
 * cancels. Each answers at once with the setup as it stands, which is taken in without waiting for the event (this
 * computer: into the store, where the event writes too; a linked machine: asked again, and again while it installs).
 * An action that is refused or fails to reach the host says why (`error`) and leaves the setup as it was.
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

  useEffect(() => {
    if (!linked || !installing || !redetect) return
    const t = setInterval(redetect, LINKED_POLL_MS)
    return () => clearInterval(t)
  }, [linked, installing, redetect])

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

/**
 * Reads the list of tools again when the host comes back after a drop: a list read before it (an install that was
 * running, a sign-in that was waiting) may be another process's story now.
 */
export function useReloadOnReconnect(reload: () => Promise<void>): void {
  const connection = useStore((s) => s.connection)
  const was = useRef(connection)
  useEffect(() => {
    if (connection === 'connected' && was.current !== 'connected') void reload()
    was.current = connection
  }, [connection, reload])
}
