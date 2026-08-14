import { createContext, useContext, type ReactNode } from 'react'
import type { Platform, PlatformCapabilities } from '@cc/platform/ports'

/** ui가 Platform을 받는 유일한 통로 (docs/platform-abstraction.md §4) */
const PlatformContext = createContext<Platform | null>(null)

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

export function usePlatform(): Platform {
  const p = useContext(PlatformContext)
  if (!p) throw new Error('PlatformProvider 밖에서 usePlatform을 호출했습니다')
  return p
}

export function useCapability(k: keyof PlatformCapabilities): boolean {
  return usePlatform().capabilities[k]
}
