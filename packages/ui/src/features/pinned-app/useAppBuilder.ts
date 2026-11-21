import { errorMessage } from '@cc/protocol/client'
import { useCallback, useEffect, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * This app's builder session (M4 C-2, C-5), for the input row and the Builder panel. Asked of the host (`apps.builder`):
 * a session's `appId` does not tell, as an agent an app asked for stands under it too (D-1). Asked again when the
 * session count changes (deleted, or started elsewhere such as create_app); one light round trip.
 */
export type AppBuilder = {
  /** The builder session's id — undefined while still being asked, null if there is none */
  id: string | null | undefined
  /** Started by the person when there is none (`apps.createBuilder`; the host chooses the tool) */
  start(): Promise<void>
  starting: boolean
  /** Why it could not start, in the host's words */
  error: string | null
}

/** `machine`: a linked machine's user-folder app (#82), whose builder is found and started on that machine */
export function useAppBuilder(projectId: string | null, appId: string, machine?: string | null): AppBuilder {
  const platform = usePlatform()
  const sessionCount = useStore((s) => Object.keys(s.sessions).length)
  const [id, setId] = useState<string | null | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    platform.apps
      .builder(appId, projectId, machine ?? undefined)
      .then((b) => alive && setId(b?.id ?? null))
      // A failed ask reads as none: on start the host returns the existing one (one per app)
      .catch(() => alive && setId(null))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, machine, sessionCount])

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const b = await platform.apps.createBuilder(appId, projectId, undefined, machine ?? undefined)
      // As the host's session_created; arriving twice counts once
      useStore.getState().dispatchEvent({ type: 'session_created', sessionId: b.id, session: b })
      setId(b.id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }, [platform, appId, projectId, machine])

  return { id, start, starting, error }
}
