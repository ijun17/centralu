import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Stop이 남기는 것 (#168). CLI는 끊긴 턴을 `error_during_execution` result로 닫는다 — 그 result가 실패 표식이 되면
 * 사람이 멈춘 턴이 "Turn failed"로 기록된다. 글을 쓰는 도중에 멈추면 그 덩어리의 assistant 메시지가 오지 않는데,
 * 그때 켜진 "본문이 델타로 나갔다" 표식이 다음 턴의 통짜 응답을 버리게 해서도 안 된다.
 *
 * SDK를 가짜로 바꿔 끼우고, 테스트가 CLI의 메시지를 하나씩 밀어 넣어 어댑터의 루프를 통째로 지난다.
 */
const cli = vi.hoisted(() => {
  const inbox: unknown[] = []
  let wake: (() => void) | null = null
  return {
    push(m: unknown) {
      inbox.push(m)
      wake?.()
      wake = null
    },
    async *stream() {
      for (;;) {
        while (inbox.length > 0) yield inbox.shift()
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    [Symbol.asyncIterator]: () => cli.stream(),
    interrupt: async () => {},
    close: () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => undefined,
  }),
}))

const { ClaudeAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 5))
const delta = (text: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})
const interrupted = { type: 'result', subtype: 'error_during_execution', is_error: true, modelUsage: {} }

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession(
    { sessionId: 's1', cwd: '/tmp', permissionPreset: 'auto' },
    (e) => events.push(e),
  )
  return { handle, events, errors: () => events.filter((e) => e.type === 'error') }
}

describe('Claude에서 턴을 멈추면 (#168)', () => {
  it('끊긴 턴의 error_during_execution은 실패로 남지 않는다 — 다른 이유의 같은 결말은 지금처럼 실패다', async () => {
    const { handle, events, errors } = await session()
    handle.send('긴 일을 해 줘')
    cli.push(delta('하는 중'))
    await tick()
    handle.interrupt()
    cli.push(interrupted)
    await tick()

    expect(errors()).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })

    // 멈추지 않은 턴의 같은 결말은 실패다 — 표시는 한 번만 쓰인다
    handle.send('다시')
    cli.push(interrupted)
    await tick()
    expect(errors()).toHaveLength(1)
    await handle.dispose()
  })

  it('쉬는 세션에서 누른 Stop은 다음 턴의 진짜 실패를 삼키지 않는다', async () => {
    const { handle, errors } = await session()
    handle.interrupt()
    handle.send('해 줘')
    cli.push(interrupted)
    await tick()
    expect(errors()).toHaveLength(1)
    await handle.dispose()
  })

  it('글을 쓰는 도중에 멈춰도 다음 턴의 통짜 응답은 화면에 나온다', async () => {
    const { handle, events } = await session()
    handle.send('길게 써 줘')
    cli.push(delta('반쯤 쓴 글'))
    await tick()
    handle.interrupt()
    cli.push(interrupted) // 부분 블록의 assistant 메시지는 오지 않는다
    await tick()

    // 델타 없이 오는 통짜 응답 (/usage 같은 로컬 응답)
    handle.send('/usage')
    cli.push({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '사용량 42%' }] } })
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && e.text === '사용량 42%')).toBe(true)
    await handle.dispose()
  })
})
