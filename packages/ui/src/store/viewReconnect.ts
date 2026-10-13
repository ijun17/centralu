import type { Platform } from '@cc/platform/ports'

/** Only for idempotent view operations, never for an app tool or a message. */
export async function viewReconnect<T>(
  platform: Platform,
  call: () => Promise<T>,
  reconnecting?: () => void,
): Promise<T> {
  let generation = 0
  let connected = true
  let wake: (() => void) | null = null
  // Subscribe before calling: the reconnect/resync can precede the dropped call's rejection.
  const unsubscribe = platform.agents.onConnectionChange((state) => {
    connected = state === 'connected' || state === 'resync_required'
    if (connected) generation += 1
    wake?.()
  })
  try {
    for (let retries = 0; ; retries++) {
      const started = generation
      try {
        return await call()
      } catch (e) {
        if ((e as { code?: string }).code !== 'connection_lost') throw e
        if (retries === 3)
          throw new Error(
            'The host kept disconnecting while opening this screen. Try again when it is connected.',
          )
        reconnecting?.()
        if (connected && generation > started) continue
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = null
            reject(
              new Error(
                'The host did not reconnect in time to open this screen. Try again when it is connected.',
              ),
            )
          }, 30_000)
          wake = () => {
            if (!connected || generation <= started) return
            clearTimeout(timer)
            wake = null
            resolve()
          }
          wake()
        })
      }
    }
  } finally {
    unsubscribe()
  }
}
