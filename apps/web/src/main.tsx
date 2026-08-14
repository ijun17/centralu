import { createRoot } from 'react-dom/client'
import { App } from '@cc/ui'
import { createWebPlatform } from '@cc/platform/web'
import { createMockPlatform } from '@cc/platform/mock'
import type { Platform } from '@cc/platform/ports'
import '../../../packages/ui/src/styles/index.css'

/**
 * 구현체를 아는 유일한 곳 (docs/platform-abstraction.md §4).
 * ?mock=1 이면 인메모리 구현으로 뜬다 — Playwright는 이 경로를 쓴다.
 */
const params = new URLSearchParams(location.search)

const platform: Platform = params.has('mock')
  ? seedMock()
  : createWebPlatform({
      hostUrl: import.meta.env.VITE_HOST_URL ?? 'ws://127.0.0.1:5175',
      token: import.meta.env.VITE_HOST_TOKEN ?? 'dev-token',
    })

function seedMock(): Platform {
  const mock = createMockPlatform()
  // E2E가 조작할 수 있게 노출 (mock 모드에서만)
  ;(window as unknown as { __mock: unknown }).__mock = mock
  return mock
}

createRoot(document.getElementById('root')!).render(<App platform={platform} />)
