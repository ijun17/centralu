import { describe, expect, it } from 'vitest'
import { APP_VERSION, type UpdateStatus } from '@cc/protocol'
import { UpdateService, type LatestResult } from './updates.js'

/**
 * 앱 업데이트 확인·설치 (이슈 #43).
 *
 * **여기서 레지스트리에 나가거나 `npm i -g`를 도는 테스트는 하나도 없다.** 둘 다
 * 주입된 자리로만 지나가고, 그게 이 파일이 이 기계를 고칠 수 없다는 보장이다.
 */
function make(opts: { registry?: string | null; run?: (file: string, args: string[]) => Promise<void> } = {}) {
  const published: UpdateStatus[] = []
  const calls: [string, string[]][] = []
  let registry = opts.registry ?? null
  let fetches = 0
  const svc = new UpdateService((s) => published.push(s), {
    fetchLatest: async (): Promise<LatestResult> => {
      fetches++
      return registry === null ? { ok: false, reason: 'Could not reach the registry' } : { ok: true, version: registry }
    },
    run: async (file, args) => {
      calls.push([file, args])
      await (opts.run?.(file, args) ?? Promise.resolve())
    },
  })
  return {
    svc,
    published,
    calls,
    get fetches() {
      return fetches
    },
    offer: (v: string | null) => {
      registry = v
    },
  }
}

/** 상태가 그 모양이 될 때까지 기다린다 — 설치는 답을 준 뒤에 끝난다 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('UpdateService', () => {
  /**
   * 지금 도는 것이 무엇인지는 **빌드 상수**가 답한다.
   *
   * 워크스페이스 루트의 package.json이 아니다 — 그건 private이고 아무도 설치하지 않는
   * 버전이라, 틀려도 아무 일이 일어나지 않은 채로 남는다. `APP_VERSION`은
   * `tooling/brand.test.ts`가 발행되는 패키지들과 같은지 지킨다.
   */
  it('현재 버전은 빌드가 들고 있는 그 값이다', () => {
    expect(make().svc.current().current).toBe(APP_VERSION)
  })

  it('레지스트리가 더 새것을 들고 있으면 알린다 (설치는 하지 않는다)', async () => {
    const h = make({ registry: '9999.0.0' })
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    // 알아낸 것만으로는 아무 일도 일어나지 않는다
    expect(s.phase).toBe('idle')
    expect(h.calls).toEqual([])
  })

  it('프리릴리스끼리도 비교한다 — #42가 여기서 다시 나면 안 된다', async () => {
    const h = make({ registry: '0.1.0-beta.99' })
    expect((await h.svc.check(true)).newer).toBe(true)
  })

  /**
   * 못 닿은 것은 **'최신이다'가 아니다.**
   *
   * 그리고 지난번에 알아낸 것을 지우지 않는다. 지우면 네트워크가 한 번 깜빡일 때마다
   * 확인이 자기 발견을 스스로 되돌리고, 화면은 아무 일도 없었던 것처럼 보인다.
   */
  it('레지스트리에 못 닿아도 던지지 않고, 알던 답을 지우지 않는다', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.offer(null)
    const s = await h.svc.check(true)
    expect(s.latest).toBe('9999.0.0')
    expect(s.newer).toBe(true)
    expect(s.error).toMatch(/registry/i)
  })

  /**
   * 꺼 두면 **아무 데도 안 묻는다.**
   *
   * 화면은 앱을 열 때마다 `check(false)`를 부른다. 그 자리에 가드가 없으면 이 설정은
   * 주기 요청만 막고 기동 때 한 번은 그대로 내보내는, 절반만 지키는 약속이 된다.
   */
  it('자동 확인이 꺼져 있으면 자동 호출은 레지스트리에 닿지 않는다', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.setAuto(false)
    const before = h.fetches
    await h.svc.check(false)
    expect(h.fetches).toBe(before)
    // 사람이 누른 것은 여전히 통한다
    await h.svc.check(true)
    expect(h.fetches).toBe(before + 1)
  })

  /**
   * 설치는 **정확한 버전을 지목한다.**
   *
   * `centralu update`를 부르면 한 줄로 끝나지만, 그 판단을 하는 것은 사용자 기계에 이미
   * 깔린 실행기이고 그 사본의 비교가 틀려 있을 수 있다 (#42) — "이미 최신입니다"라고
   * 답하며 아무것도 안 하는 것이 정확히 그 결함의 증상이다. 찾아낸 버전을 이름으로
   * 넘기면 그 판단을 아예 거치지 않는다.
   */
  it('찾아낸 버전을 그대로 지목해 설치한다 (실행기의 판단을 거치지 않는다)', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    expect(h.svc.apply().phase).toBe('updating')
    await settle()
    expect(h.calls[0]).toEqual(['npm', ['i', '-g', 'centralu@9999.0.0']])
    expect(h.svc.current().phase).toBe('restart_required')
  })

  it('설치가 실패하면 이유를 남긴다 (조용히 원래대로 돌아가지 않는다)', async () => {
    const h = make({
      registry: '9999.0.0',
      run: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect(h.svc.current().phase).toBe('failed')
    expect(h.svc.current().error).toMatch(/EACCES/)
  })

  it('올릴 것이 없는데 부르면 그렇게 말한다 (아무 일도 안 하는 대신)', async () => {
    const h = make({ registry: null })
    const s = h.svc.apply()
    expect(s.phase).toBe('failed')
    expect(h.calls).toEqual([])
  })

  /**
   * 설치가 끝난 뒤의 주기 확인이 "다시 시작하세요"를 지우면 안 된다.
   *
   * 디스크에는 새 버전이 있고 도는 프로세스는 옛것이라, 여섯 시간 뒤의 확인은 방금 깐
   * 바로 그 버전을 '새것'으로 다시 찾아낸다 — 이미 업데이트한 사람에게 업데이트하라고
   * 말하는 셈이다.
   */
  it('다시 시작 대기 중에는 확인이 그 상태를 덮지 않는다', async () => {
    const h = make({ registry: '9999.0.0' })
    await h.svc.check(true)
    h.svc.apply()
    await settle()
    expect((await h.svc.check(true)).phase).toBe('restart_required')
  })
})
