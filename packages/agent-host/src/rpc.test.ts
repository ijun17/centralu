import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'

/**
 * 설정 필드가 RPC 경계에서 조용히 사라지지 않는지 본다.
 *
 * effort를 추가했을 때 rpc.ts에서 필드를 하나씩 꺼내 쓰다가 그것만 빠뜨렸다.
 * UI는 보내는데 host에는 도착하지 않아 **오류 없이 아무 일도 안 일어났다** —
 * 화면에는 바뀐 것처럼 보이니 원인을 찾기 가장 나쁜 종류다.
 *
 * 그래서 "핸들러가 필드를 하나씩 꺼내지 않는다"를 못 박는다. 통째로 넘기면
 * 설정이 늘어나도 이 자리를 다시 고칠 일이 없다.
 */
describe('agents.updateSettings — 필드가 새지 않는다', () => {
  it('스키마가 아는 설정 필드', () => {
    const shape = Object.keys(RpcMethods['agents.updateSettings'].params.shape)
    expect(shape.sort()).toEqual(['effort', 'model', 'permissionPreset', 'serviceTier', 'sessionId', 'verbosity'])
  })

  it('핸들러가 sessionId만 떼고 나머지는 통째로 넘긴다', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./rpc.ts', import.meta.url), 'utf8'),
    )
    const handler = /'agents\.updateSettings':[\s\S]*?\n {4}\},/.exec(src)?.[0] ?? ''
    expect(handler, 'updateSettings 핸들러를 찾지 못했다').toBeTruthy()

    // 필드를 하나씩 나열하면 새 설정이 생길 때마다 여기서 조용히 빠진다
    expect(handler).toMatch(/\.\.\.settings/)
    expect(handler).not.toMatch(/\{\s*sessionId,\s*model,/)
  })
})
