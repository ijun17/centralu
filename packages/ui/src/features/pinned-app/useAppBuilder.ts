import { useCallback, useEffect, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * 이 앱의 만드는 세션 (M4 C-2·C-5) — 고정 화면의 입력줄과 "Builder" 판이 함께 쓴다.
 *
 * **host에게 묻는다.** 세션의 앱 칸(`appId`)만 보고 고르면 안 된다: 앱 아래에 서는 세션은 만드는 세션 하나가 아니다
 * (앱이 부른 에이전트도 그 앱 아래에 선다, D-1). 어느 것이 만드는 세션인지는 host의 명부가 정한다(`apps.builder`).
 *
 * 다시 묻는 때: 세션이 생기거나 사라질 때(수가 바뀔 때). 만드는 세션을 지웠거나 다른 곳(오케스트레이터의 create_app,
 * 다른 창)에서 세웠을 수 있다. 물을 때마다 가벼운 한 번의 왕복이다.
 */
export type AppBuilder = {
  /** 만드는 세션의 id — 아직 묻는 중이면 undefined, 없으면 null */
  id: string | null | undefined
  /** 없을 때 사람이 세운다(`apps.createBuilder`, 도구는 host가 고른다) */
  start(): Promise<void>
  starting: boolean
  /** 세우지 못한 까닭 — host의 말 그대로 */
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
      // 못 물었으면 없는 것으로 둔다 — 세우기를 누르면 host가 이미 있는 것을 돌려준다(앱마다 하나)
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
      // host의 session_created와 같은 길로 등록한다 — 두 번 와도 한 번이다
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
