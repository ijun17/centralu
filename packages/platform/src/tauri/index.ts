import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { Platform, SystemPort } from '../ports/index.js'
import { createWebPlatform } from '../web/index.js'

/**
 * Tauri 구현 (docs/platform-abstraction.md §5 마이그레이션 플레이북 2~3단계).
 *
 * agents/projects는 **web 구현을 그대로 재사용**한다 — 둘 다 같은 WS로 host에 위임하므로
 * 새로 쓸 코드가 없다. Tauri가 다르게 하는 것은 두 가지뿐:
 *   1. host의 포트·토큰을 사이드카 수퍼바이저에게서 받는다 (사람이 터미널을 띄우지 않는다)
 *   2. system 포트가 진짜 OS 기능이 된다 (알림·뱃지·IDE 열기)
 */

type HostInfo = { port: number; token: string }

type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; port: number; token: string }
  | { state: 'restarting'; attempt: number }
  | { state: 'failed'; message: string }

/** 사이드카가 준비될 때까지 기다린다. 앱은 host보다 먼저 뜬다. */
async function waitForHost(timeoutMs = 30_000): Promise<HostInfo> {
  const existing = await invoke<HostInfo | null>('host_info')
  if (existing?.token) return existing

  return new Promise<HostInfo>((resolve, reject) => {
    let done = false
    const timer = setTimeout(async () => {
      if (done) return
      done = true
      const err = await invoke<string | null>('host_error').catch(() => null)
      reject(new Error(err ?? 'agent-host가 시간 안에 준비되지 않았습니다'))
    }, timeoutMs)

    void listen<HostStatus>('host-status', (e) => {
      const p = e.payload
      if (done || typeof p !== 'object' || p === null) return
      if (p.state === 'ready') {
        done = true
        clearTimeout(timer)
        resolve({ port: p.port, token: p.token })
      } else if (p.state === 'failed') {
        done = true
        clearTimeout(timer)
        reject(new Error(p.message))
      }
    })
  })
}

class TauriSystemPort implements SystemPort {
  private granted: boolean | null = null

  async notify(title: string, body: string): Promise<void> {
    if (this.granted === null) {
      this.granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
    }
    if (!this.granted) return
    sendNotification({ title, body })
  }

  async setBadge(count: number): Promise<void> {
    await invoke('set_badge', { count: Math.max(0, Math.trunc(count)) })
  }

  async openInIde(path: string, line?: number): Promise<void> {
    await invoke('open_in_ide', { path, line })
  }
}

/** 창을 앞으로 (알림 클릭·전역 단축키) */
export async function focusWindow(): Promise<void> {
  await invoke('focus_window')
}

/** 디렉토리 선택 — 웹 dev의 경로 타이핑을 대체한다 (FR-19) */
export async function pickDirectory(): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false, title: '프로젝트 디렉토리 선택' })
  return typeof picked === 'string' ? picked : null
}

export async function createTauriPlatform(): Promise<Platform> {
  const { port, token } = await waitForHost()
  const base = createWebPlatform({ hostUrl: `ws://127.0.0.1:${port}`, token })

  return {
    ...base,
    system: new TauriSystemPort(),
    capabilities: {
      osNotifications: true,
      dockBadge: true,
      globalShortcuts: true,
      processSupervision: true,
      openInIde: true,
    },
  }
}

export type { HostStatus }
