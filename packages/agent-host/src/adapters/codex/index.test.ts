import { describe, expect, it, vi } from 'vitest'

/**
 * 준비(핸드셰이크)에 실패한 세션은 핸들이 밖으로 나가지 않아 dispose를 불러줄 사람이 없다.
 * 그런데 app-server는 생성자에서 이미 떠 있다 — 여기서 거두지 않으면 실패할 때마다
 * 자식 프로세스가 하나씩 조용히 샜다. 클라이언트를 가짜로 갈아 끼워 그 계약만 본다.
 */
const state = vi.hoisted(() => ({
  instances: [] as { disposed: boolean }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    disposed = false
    constructor() {
      state.instances.push(this)
    }
    request(method: string): Promise<never> {
      return Promise.reject(new Error(`connection refused during ${method}`))
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {
      this.disposed = true
    }
  },
}))

const { CodexAdapter } = await import('./index.js')

describe('codex 세션 준비 실패', () => {
  it('핸드셰이크가 실패하면 띄워 둔 app-server를 거둔다 (실패당 자식 하나 누수 방지)', async () => {
    const adapter = new CodexAdapter()

    await expect(
      adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {}),
    ).rejects.toThrow(/connection refused/)

    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]!.disposed).toBe(true)
  })
})
