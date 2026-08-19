import { createContext, useContext, type ReactNode } from 'react'
import type { Platform, PlatformCapabilities } from '@cc/platform/ports'

/** ui가 Platform을 받는 유일한 통로 (docs/platform-abstraction.md §4) */
const PlatformContext = createContext<Platform | null>(null)

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

export function usePlatform(): Platform {
  const p = useContext(PlatformContext)
  if (!p) throw new Error('usePlatform was called outside of PlatformProvider')
  return p
}

// Generic over the key because not every capability is a yes/no: `windowControlsInset`
// is a width. Pinning the return type to boolean would have forced ui to cast, and a
// cast here is how a platform detail starts leaking back into ui.
export function useCapability<K extends keyof PlatformCapabilities>(k: K): PlatformCapabilities[K] {
  return usePlatform().capabilities[k]
}
