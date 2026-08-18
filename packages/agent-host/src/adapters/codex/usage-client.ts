import { homedir } from 'node:os'
import { CLIENT_INFO } from '@cc/protocol'
import type { UsageSnapshot } from '@cc/protocol'
import { CodexClient } from './client.js'
import { toSnapshot } from './usage.js'

/**
 * 사용량 조회용 단명 클라이언트.
 *
 * 계정 정보라 프로젝트와 무관하므로 홈에서 띄운다.
 * 대화 중인 스레드에 조회 트래픽을 얹지 않는다 — 그쪽이 느려지고,
 * 실패했을 때 어느 쪽이 죽은 건지 구분이 안 된다.
 */
export async function readCodexUsage(command: string): Promise<UsageSnapshot> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd: homedir(), command },
  )
  try {
    await client.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    client.notify('initialized')
    const [rateLimits, usage] = await Promise.all([
      client.request<unknown>('account/rateLimits/read', undefined as never),
      // 일별 토큰은 없어도 한도는 보여줄 수 있다 — 하나가 실패해도 나머지는 살린다
      client.request<unknown>('account/usage/read', undefined as never).catch(() => null),
    ])
    return toSnapshot(rateLimits, usage)
  } finally {
    await client.dispose().catch(() => {})
  }
}
