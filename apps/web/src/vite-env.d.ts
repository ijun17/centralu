/// <reference types="vite/client" />

import type { createMockPlatform } from '@cc/platform/mock'
import type { useStore } from '@cc/ui'

declare global {
  interface ImportMetaEnv {
    readonly VITE_HOST_TOKEN?: string
    readonly VITE_HOST_URL?: string
  }

  interface Window {
    __mock?: ReturnType<typeof createMockPlatform>
    __store?: typeof useStore
  }
}

export {}
