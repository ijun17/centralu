import { createRoot } from 'react-dom/client'
import { App, useStore } from '@cc/ui'
import { createWebPlatform } from '@cc/platform/web'
import { createMockPlatform } from '@cc/platform/mock'
import type { Platform } from '@cc/platform/ports'
import { browserHostOptions, isMockMode } from './bootstrap.js'
import '../../../packages/ui/src/styles/index.css'

/**
 * 구현체를 아는 유일한 곳 (docs/platform-abstraction.md §4).
 * ?mock=1 이면 인메모리 구현으로 뜬다 — Playwright는 이 경로를 쓴다.
 */
const platform: Platform = isMockMode(location.search) ? seedMock() : createWebPlatform(browserHostOptions(import.meta.env))

function seedMock(): Platform {
  const mock = createMockPlatform()
  window.__mock = mock
  window.__store = useStore
  return mock
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
createRoot(rootElement).render(<App platform={platform} />)
