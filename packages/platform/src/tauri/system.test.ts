import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const { TauriSystemPort } = await import('./index.js')

/**
 * 데스크톱 system 포트와 러스트 커맨드 사이의 이음매 (#159).
 *
 * 웹뷰 없이는 설치본의 동작을 볼 수 없으므로, 여기서는 **무엇을 부르고 실패를 어떤 모양으로
 * 돌려주는지**만 본다. 실제로 브라우저와 VS Code가 열리는지는 설치본에서 손으로 확인한다.
 */
describe('TauriSystemPort', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('링크는 opener 플러그인의 open_url로 연다 — window.open은 데스크톱 웹뷰에서 아무것도 열지 않는다', async () => {
    invoke.mockResolvedValue(undefined)
    await new TauriSystemPort().openUrl('https://example.com/')
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://example.com/' })
  })

  it('Open in IDE의 실패는 러스트가 준 이유를 메시지로 가진 Error다 — "undefined"가 아니다', async () => {
    invoke.mockRejectedValue("VS Code's `code` command was not found (looked in: /usr/bin/code)")
    const err = await new TauriSystemPort().openInIde('/tmp/a.ts', 3).catch((e: unknown) => e)
    expect(invoke).toHaveBeenCalledWith('open_in_ide', { path: '/tmp/a.ts', line: 3 })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("VS Code's `code` command was not found (looked in: /usr/bin/code)")
  })

  it('링크를 못 열었을 때도 이유가 실린 Error로 던진다', async () => {
    invoke.mockRejectedValue('Not allowed to open url file:///etc/passwd')
    const err = await new TauriSystemPort().openUrl('file:///etc/passwd').catch((e: unknown) => e)
    expect((err as Error).message).toBe('Not allowed to open url file:///etc/passwd')
  })
})
