import { describe, expect, it } from 'vitest'
import { CodexClient } from './client.js'

/**
 * **우리가 닫은 것과 저쪽이 죽은 것은 다르다.**
 *
 * 이 구분이 없어서 조사 하루를 통째로 잃었다. 잠긴 대화를 이어가려다 실패하면
 * 매니저가 세션을 정리하는데(dispose), 그 **정상 종료**가 어댑터에서 다시
 * `adapter_crashed`로 올라가 화면에 "codex app-server exited"라고 찍혔다.
 * 진짜 이유("already has an active writer")는 그 아래 깔려 보이지 않았고,
 * 사람은 죽지도 않은 프로세스가 죽었다는 말을 들었다.
 *
 * 실제 프로세스를 띄워 확인한다 — 이 계약은 프로세스 수명주기 그 자체라
 * 목으로 흉내내면 정작 틀어지는 자리를 못 잡는다.
 */
const exitOf = (args: string[]) =>
  new Promise<{ code: number | null; expected: boolean }>((resolve) => {
    const client = new CodexClient(
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onExit: (code, expected) => resolve({ code, expected }),
      },
      { command: process.execPath, args },
    )
    // 살아 있는 프로세스만 우리가 닫을 수 있다 — 붙자마자 죽는 쪽은 아래 테스트가 본다
    if (args[1]?.includes('setTimeout')) setTimeout(() => void client.dispose(), 150)
  })

describe('codex app-server 종료 판정', () => {
  it('우리가 닫으면 expected=true — 죽었다고 말하지 않는다', async () => {
    const { expected } = await exitOf(['-e', 'setTimeout(() => {}, 60000)'])
    expect(expected).toBe(true)
  })

  it('저쪽이 스스로 끝나면 expected=false — 이때만 크래시다', async () => {
    const { expected, code } = await exitOf(['-e', 'process.exit(3)'])
    expect(expected).toBe(false)
    expect(code).toBe(3)
  })

  /*
   * spawn 실패(ENOENT — nvm 전환·codex 삭제로 경로가 어긋난 경우)는 'exit'이 아니라
   * 'error'로 온다. 리스너가 없으면 uncaughtException으로 올라가 host 전체가 죽고,
   * codex 하나 없다는 이유로 살아 있는 Claude 세션까지 전부 끊긴다.
   * 이 세션만 실패해야 한다: 기다리던 요청은 이유와 함께 거절되고, onExit은 한 번만 온다.
   */
  it('없는 명령이면 프로세스를 죽이지 않고 이 세션만 실패시킨다', async () => {
    let exits = 0
    const client = new CodexClient(
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onExit: () => {
          exits++
        },
      },
      { command: '/nonexistent/cc-no-such-codex' },
    )

    // 짧은 타임아웃: 거절은 spawn 'error'에서 오지만, 남는 타이머가 러너를 붙들지 않게
    await expect(client.request('initialize', {}, 1000)).rejects.toThrow(/failed to start/)
    // 'error'와 'exit'이 둘 다 와도 onExit은 한 번이다 (finished 표식)
    await new Promise((r) => setTimeout(r, 100))
    expect(exits).toBe(1)
    // 이미 끝난 클라이언트에 또 요청하면 조용히 매달리지 않고 바로 거절한다
    await expect(client.request('x')).rejects.toThrow(/already exited/)
  })
})
