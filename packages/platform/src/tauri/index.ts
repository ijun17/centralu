import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
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

/**
 * 사이드카가 준비될 때까지 기다린다. 앱은 host보다 먼저 뜬다.
 *
 * **순서가 중요하다:** 이벤트를 먼저 구독하고 그다음 현재 상태를 묻는다.
 * 반대로 하면 그 사이에 준비가 끝났을 때 신호를 놓쳐 타임아웃까지 멈춘다
 * (host가 1초 만에 뜨게 되면서 실제로 겪었다). 폴링까지 두어 삼중으로 막는다.
 */
async function waitForHost(timeoutMs = 30_000): Promise<HostInfo> {
  return new Promise<HostInfo>((resolve, reject) => {
    let done = false
    const finish = (info: HostInfo) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      resolve(info)
    }
    const fail = (message: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(poll)
      reject(new Error(message))
    }

    const timer = setTimeout(() => {
      void invoke<string | null>('host_error')
        .catch(() => null)
        .then((err) => fail(err ?? 'agent-host가 시간 안에 준비되지 않았습니다'))
    }, timeoutMs)

    // ① 먼저 구독한다
    void listen<HostStatus>('host-status', (e) => {
      const p = e.payload
      if (typeof p !== 'object' || p === null) return
      if (p.state === 'ready') finish({ port: p.port, token: p.token })
      else if (p.state === 'failed') fail(p.message)
    })

    // ② 이미 준비돼 있었는지 확인한다 (구독 전에 끝난 경우)
    void invoke<HostInfo | null>('host_info')
      .then((info) => info?.token && finish(info))
      .catch(() => {})

    // ③ 이벤트를 놓쳐도 결국 붙는다
    const poll = setInterval(() => {
      void invoke<HostInfo | null>('host_info')
        .then((info) => info?.token && finish(info))
        .catch(() => {})
    }, 400)
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

  async pickDirectory(): Promise<string | null> {
    return pickDirectory()
  }

  async startWindowDrag(): Promise<void> {
    await getCurrentWindow().startDragging()
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

  // 수퍼바이저가 host를 되살리면 포트·토큰이 바뀐다 → 새 주소로 갈아타야 한다.
  // 이 구독이 없으면 사이드카가 크래시한 뒤 앱이 '연결 끊김'에 머문다 (L4-2 실측).
  const base = createWebPlatform({
    hostUrl: `ws://127.0.0.1:${port}`,
    token,
    onEndpointChange: (cb) => {
      const un = listen<HostStatus>('host-status', (e) => {
        const p = e.payload
        if (typeof p === 'object' && p !== null && p.state === 'ready') cb({ port: p.port, token: p.token })
      })
      return () => void un.then((f) => f())
    },
  })

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
