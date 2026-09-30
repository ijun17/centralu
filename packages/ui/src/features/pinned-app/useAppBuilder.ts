import { useCallback, useEffect, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * This app's builder session (M4 C-2, C-5) — shared by the pinned view's input row and the
 * "Builder" panel.
 *
 * **This asks the host.** It must not pick a session by looking only at its app field (`appId`):
 * the builder session is not the only session standing under an app (an agent an app asked for
 * stands under that app too, D-1). Which one is the builder session is decided by the host's own
 * registry (`apps.builder`).
 *
 * When it asks again: whenever a session appears or disappears (the count changes). The builder
 * session may have been deleted, or one may have been started somewhere else (the orchestrator's
 * create_app, another dialog). Each ask is one lightweight round trip.
 */
export type AppBuilder = {
  /** The builder session's id — undefined while still being asked, null if there is none */
  id: string | null | undefined
  /** Started by the person when there is none (`apps.createBuilder`; the host chooses the tool) */
  start(): Promise<void>
  starting: boolean
  /** The reason it could not be started — exactly the host's own wording */
  error: string | null
}

export function useAppBuilder(projectId: string | null, appId: string): AppBuilder {
  const platform = usePlatform()
  const sessionCount = useStore((s) => Object.keys(s.sessions).length)
  const [id, setId] = useState<string | null | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    platform.apps
      .builder(appId, projectId)
      .then((b) => alive && setId(b?.id ?? null))
      // If asking fails, it is treated as none existing — pressing start, the host returns the existing one if there already is one (one per app)
      .catch(() => alive && setId(null))
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, sessionCount])

  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const b = await platform.apps.createBuilder(appId, projectId)
      // Registered through the same path as the host's session_created — arriving twice still counts once
      useStore.getState().dispatchEvent({ type: 'session_created', sessionId: b.id, session: b })
      setId(b.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }, [platform, appId, projectId])

  return { id, start, starting, error }
}
