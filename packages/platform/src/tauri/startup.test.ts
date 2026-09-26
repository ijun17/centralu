import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const handlers = new Map<string, (e: { payload: unknown }) => void>()
const unlistened: string[] = []
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb)
    return () => unlistened.push(name)
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const { createTauriPlatform, listenForQuit } = await import('./index.js')

/**
 * host가 뜨지 못한 순간의 데스크톱 (#184). 웹뷰 없이 셸과의 이음매만 본다 — 실제로 ⌘Q가 먹는지,
 * Retry가 host를 다시 띄우는지는 설치본에서 손으로 확인한다.
 */
beforeEach(() => {
  invoke.mockReset()
  handlers.clear()
  unlistened.length = 0
})

describe('종료 요청의 받는 곳', () => {
  it('물을 곳이 없으면(기동 중·기동 실패 화면) 바로 끄고, 서 있으면 그쪽에 넘긴다', async () => {
    const setAsker = listenForQuit()
    await vi.waitFor(() => expect(handlers.has('quit-requested')).toBe(true))
    const quit = handlers.get('quit-requested')!

    quit({ payload: null })
    expect(invoke).toHaveBeenCalledWith('quit_app')

    invoke.mockClear()
    const ask = vi.fn()
    setAsker(ask)
    quit({ payload: null })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()

    setAsker(null)
    quit({ payload: null })
    expect(invoke).toHaveBeenCalledWith('quit_app')
  })
})

describe('host를 기다리기', () => {
  it('이벤트를 놓쳐도 수퍼바이저가 남긴 실패 문장을 곧바로 읽어 실패한다 — 30초를 기다리지 않는다', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'host_info') return null
      if (cmd === 'host_error') return 'Node.js를 찾지 못했습니다'
      return null
    })
    await expect(createTauriPlatform()).rejects.toThrow('Node.js를 찾지 못했습니다')
    // 다시 시도할 때마다 구독이 쌓이지 않는다
    await vi.waitFor(() => expect(unlistened).toContain('host-status'))
  })
})
