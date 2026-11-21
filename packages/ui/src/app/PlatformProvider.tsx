import { createContext, useContext, type ReactNode } from 'react'
import type { Platform, PlatformCapabilities } from '@cc/platform/ports'

/** The only channel through which ui receives a Platform (docs/platform-abstraction.md §4) */
const PlatformContext = createContext<Platform | null>(null)

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

export function usePlatform(): Platform {
  const p = useContext(PlatformContext)
  if (!p) throw new Error('usePlatform was called outside of PlatformProvider')
  return p
}

// Generic over the key: not every capability is a yes/no (`windowControlsInset` is a width), and a cast in ui is
// how a platform detail leaks back in
export function useCapability<K extends keyof PlatformCapabilities>(k: K): PlatformCapabilities[K] {
  return usePlatform().capabilities[k]
}
