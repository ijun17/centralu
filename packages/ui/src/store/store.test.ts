import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, NormalizedEvent, SessionInfo } from '@cc/protocol'
import { handoffFile, sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- 런타임 ui는 ports만 알지만, 테스트는 즉석 모킹 대신 MockPlatform을 쓰는 것이 계약이다 (platform/src/mock/index.ts 머리말)
import { MockPlatform } from '@cc/platform/mock'
import { externalAppKey, inlineViewsFromHistory, messagesToChat, registerPinnedFrame, useStore, type ChatItem } from './store.js'

/**
 * 스토어 회귀 테스트 — 포트는 MockPlatform으로 (즉석 모킹 금지, 계약이 흩어진다).
 * pendingEvents 보관함은 모듈 상태라 테스트 사이에 못 비운다 — 세션 id를 테스트마다 다르게 쓴다.
 */

/**
 * 전임자가 노트를 **파일로** 남긴 척한다 (#102) — 경로는 넘기는 세션의 id로 갈린다 (#104).
 * 목록에도 세우는 placeFile로 들어간다: 내용만 꽂아 두면 청소(trash)가 목에서만 거절당한다.
 */
function mockNote(mock: MockPlatform, sessionId: string, text: string): string {
  const path = handoffFile(sessionId)
  mock.placeFile(path, text)
  return path
}

function sessionInfo(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: true,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
    appId: null, ...sessionLiveDefaults(), ...over,
  }
}

const delta = (sessionId: string, text: string) =>
  ({ sessionId, type: 'message_delta', role: 'assistant', text }) as NormalizedEvent

/** 대화 한 줄을 사람이 읽는 글로 — 도구는 제목, 이미지는 종류 */
const line = (i: ChatItem): string =>
  i.kind === 'tool' ? i.title : i.kind === 'image' ? `image:${i.mime}` : i.kind === 'approval' ? i.summary : i.text

/**
 * 사람이 할 수 있는 만큼 거슬러 읽는다 — 기록이 선 뒤 '이전 대화'를 더 없을 때까지 (#79).
 * 커서가 틀리면 여기서 드러난다: 가운데가 빠지거나(커서가 너무 낮다) 같은 줄이 두 번 붙는다(너무 높다).
 */
async function readAll(id: string): Promise<string[]> {
  await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  for (let i = 0; i < 50 && useStore.getState().history[id]!.more; i++) await useStore.getState().loadOlder(id)
  return useStore.getState().chat[id]!.map(line)
}

beforeEach(() => {
  useStore.setState({
    platform: null,
    connection: 'connecting',
    projects: {},
    sessions: {},
    chat: {},
    drafts: {},
    stickToBottom: {},
    workingSince: {},
    expandedDirs: {},
    showIgnored: true,
    focusedSessionId: null,
    focusedProjectId: null,
    view: 'focus',
    history: {},
    resuming: {},
    wakeError: {},
    wakeLocked: {},
    notices: [],
    toast: null,
    approvalsInFlight: {},
    commandRuns: {},
    notifyPolicy: DEFAULT_NOTIFY_POLICY,
    externalAppChanges: {},
    externalAppRunChanges: {},
    externalAppChangedBy: {},
    externalApps: [],
    trustAsk: null,
    pinnedViews: [],
    focusedApp: null,
  })
})

describe('세션 등록 전에 도착한 이벤트 (U2)', () => {
  it('attach가 목록을 등록하면 보관해 둔 이벤트가 재생된다 — 앱을 켜기 전부터 돌던 세션', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u2-s1', sessionInfo('u2-s1'))

    // 등록 전에 이벤트가 먼저 도착했다 (host에서 이미 돌던 세션의 스트리밍)
    useStore.getState().dispatchEvent(delta('u2-s1', '먼저 온 출력'))
    expect(useStore.getState().chat['u2-s1']).toBeUndefined()

    await useStore.getState().attach(mock)

    const chat = useStore.getState().chat['u2-s1']
    expect(chat).toHaveLength(1)
    expect(chat![0]).toMatchObject({ kind: 'assistant', text: '먼저 온 출력' })
  })

  it('createSession 경로와 겹쳐도 이중 적용은 없다 (재생 전에 보관함에서 지운다)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u2-s2', sessionInfo('u2-s2'))
    useStore.getState().dispatchEvent(delta('u2-s2', 'once'))

    await useStore.getState().attach(mock)
    // 다른 세션을 만들며 replayPendingEvents가 또 돈다 — 이미 재생된 것은 다시 오면 안 된다
    const p = await useStore.getState().addProject('/tmp/u2')
    await useStore.getState().createSession(p.id)

    expect(useStore.getState().chat['u2-s2']!.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })
})

describe('resync_required 소비 (U3)', () => {
  it('연결된 것으로 표시하고 전체 재동기화를 돌린다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u3-s1', sessionInfo('u3-s1'))
    await useStore.getState().attach(mock)

    // 끊긴 사이 host에 세션이 생겼고, 이벤트 재전송은 불가능하다고 통보됐다
    mock.sessions.set('u3-s2', sessionInfo('u3-s2', { name: '끊긴 사이 생김' }))
    mock.setConnectionState('resync_required')

    // 라벨 로직은 connected가 아니면 전부 'Disconnected'로 그린다 — 그 값이 남으면 거짓말이다
    expect(useStore.getState().connection).toBe('connected')
    await vi.waitFor(() => expect(useStore.getState().sessions['u3-s2']).toBeDefined())
    expect(useStore.getState().sessions['u3-s2']!.name).toBe('끊긴 사이 생김')
  })

  it('재동기화는 보고 있던 대화를 저장소에서 다시 읽는다 (빈 구간의 이벤트는 다시 오지 않는다)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u3-s3', sessionInfo('u3-s3'))
    await useStore.getState().attach(mock)
    useStore.setState({ focusedSessionId: 'u3-s3' })

    const spy = vi.spyOn(useStore.getState(), 'loadHistory')
    mock.setConnectionState('resync_required')
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('u3-s3'))
  })
})

/**
 * 위로 거슬러 읽기 (도그푸딩 2026-09-09: "위에 대화가 안 불러와져").
 *
 * 화면이 든 대화와 기록 커서는 **함께 움직여야** 한다. 어긋나면 '이전 대화'가 화면과
 * 안 이어지는 구간을 앞에 붙이거나, 아예 불러올 길이 사라진다.
 */
describe('기록 커서', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `줄 ${i + 1}` }, ts: i + 1,
    }))

  it('세션을 떠나며 창을 줄이면 커서도 잘린 자리로 옮긴다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h1', sessionInfo('h1'))
    mock.sessions.set('h2', sessionInfo('h2'))
    mock.messages.set('h1', many('h1', 120))
    await useStore.getState().attach(mock)

    await useStore.getState().focusSession('h1')
    await vi.waitFor(() => expect(useStore.getState().chat['h1']?.length).toBe(100))

    await useStore.getState().focusSession('h2')

    const chat = useStore.getState().chat['h1']!
    const info = useStore.getState().history['h1']!
    expect(chat.length).toBe(50)
    // 커서가 화면 맨 위와 같은 자리다 — 그래야 다음 페이지가 이어 붙는다
    expect(info.oldestSeq).toBe(chat[0]!.seq)
    expect(info.more).toBe(true)
  })

  /*
   * 예전 단언은 `oldestSeq === chat[0].seq`였다. 결함이 있는 채로 통과했다: 그 seq가 렌더 키라서
   * 커서가 화면과 "같은 자리"여도 `loadOlder`는 엉뚱한 곳부터 읽었다 (#79). 그래서 결과를 본다.
   */
  it('이벤트로만 생긴 대화도 끝까지 거슬러 읽으면 저장된 줄이 빠짐없이 한 번씩 있다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h3', sessionInfo('h3'))
    mock.messages.set('h3', many('h3', 120))
    await useStore.getState().attach(mock)

    // 화면을 열기 전에 이벤트가 먼저 왔다 — chat만 생기고 커서는 없다
    mock.emit({ sessionId: 'h3', type: 'message_delta', role: 'assistant', text: '먼저 온 말' } as never)
    await vi.waitFor(() => expect(useStore.getState().chat['h3']).toBeDefined())
    expect(useStore.getState().history['h3']).toBeUndefined()

    await useStore.getState().focusSession('h3')

    expect(await readAll('h3')).toEqual([...Array.from({ length: 120 }, (_, i) => `줄 ${i + 1}`), '먼저 온 말'])
  })
})

/**
 * 기록 커서는 저장 번호로만 선다 (#79).
 *
 * 실시간 줄의 `seq`는 전 세션 공용 렌더 키고, 기록에서 읽은 줄의 `seq`는 host가 세션마다 매긴 번호다.
 * 이벤트가 화면보다 먼저 온 세션에서 커서가 렌더 키를 받으면: 키가 저장 번호보다 작으면 가운데가 빠지고(A),
 * 크면 최신 페이지가 한 번 더 붙는다(A2). 기록을 읽는 사이 이벤트가 오면 받아 온 페이지를 버렸다(B).
 * 실측(2026-09-25): 앱이 부탁한 에이전트의 세션을 처음 열자 프롬프트와 Read·Write 카드가 두 번 보였다.
 */
describe('기록보다 이벤트가 먼저 온 세션의 커서 (#79)', () => {
  const rows = (id: string, n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: from + i, role: 'user' as const, kind: 'text' as const,
      payload: { text: `L${from + i}` }, ts: from + i,
    }))
  const L = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`)

  /** 다른 세션의 큰 기록을 먼저 읽는다 — 렌더 키가 저장 번호보다 훨씬 커진다 (실측의 조건) */
  async function openBigFirst(mock: MockPlatform, id: string) {
    mock.sessions.set(id, sessionInfo(id))
    mock.messages.set(id, rows(id, 1000))
    useStore.getState().focusSession(id)
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  }

  it.each([
    ['첫 페이지', 50],
    ['더 오래된 페이지', 200],
  ])('A: 렌더 키가 저장 번호보다 작아도 가운데가 빠지지 않는다 — 키가 %s의 번호와 겹쳐도 보던 줄의 키는 그대로다', async (_where, over) => {
    const mock = new MockPlatform()
    mock.sessions.set('a79-probe', sessionInfo('a79-probe'))
    mock.sessions.set('a79', sessionInfo('a79'))
    await useStore.getState().attach(mock)
    // 다음 렌더 키가 몇인지 재고, 그보다 200줄 긴 세션을 만든다 — 키가 저장 번호의 한가운데에 떨어진다
    mock.emit({ sessionId: 'a79-probe', type: 'tool_call', callId: 'p', summary: { tool: 'Read', title: 'probe', readOnly: true } } as never)
    const n = useStore.getState().chat['a79-probe']![0]!.seq + over
    mock.messages.set('a79', rows('a79', n))

    mock.emit(delta('a79', 'LIVE-D'))
    const key = useStore.getState().chat['a79']![0]!.seq
    expect(key).toBeLessThan(n) // 조건이 섰다: 키가 저장 번호 안쪽이다
    useStore.getState().focusSession('a79')

    expect(await readAll('a79')).toEqual([...L(n), 'LIVE-D'])
    const chat = useStore.getState().chat['a79']!
    // 합치며 화면의 줄은 다시 그려지지 않는다(키가 같다) — 같은 번호의 저장된 줄이 비켜 간다
    expect(chat.find((i) => line(i) === 'LIVE-D')!.seq).toBe(key)
    expect(new Set(chat.map((i) => i.seq)).size).toBe(chat.length)
  })

  it('A2: 렌더 키가 저장 번호보다 커도 최신 페이지가 두 번 붙지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a2-79', sessionInfo('a2-79'))
    mock.messages.set('a2-79', rows('a2-79', 20))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'a2-big')

    mock.emit(delta('a2-79', 'LIVE-S'))
    expect(useStore.getState().chat['a2-79']![0]!.seq).toBeGreaterThan(21)
    useStore.getState().focusSession('a2-79')

    expect(await readAll('a2-79')).toEqual([...L(20), 'LIVE-S'])
  })

  it('B: 기록을 읽는 사이 도착한 말이 받아 온 페이지를 버리게 하지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('b79', sessionInfo('b79'))
    mock.messages.set('b79', rows('b79', 250))
    await useStore.getState().attach(mock)

    // host처럼: 요청을 받은 순간의 페이지를 읽고, 답은 그 뒤에 온 이벤트보다 늦게 도착한다
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('b79')
    mock.emit(delta('b79', 'LIVE'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('b79')).toEqual([...L(250), 'LIVE'])
  })

  it('앱이 부탁한 에이전트의 세션: 뒤에서 만들어져 일을 마친 뒤 처음 열어도 한 번씩만 보인다 (실측 재현)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'app79-big')

    // host가 뒤에서 세션을 만들고(D-1), 앱의 부탁이 첫 말로 들어가 에이전트가 읽고 쓰고 답한다
    const info = sessionInfo('app79', { appId: 'notes' })
    mock.sessions.set('app79', info)
    mock.emit({ type: 'session_created', sessionId: 'app79', session: info } as never)
    const fromApp = { appId: 'notes', projectId: 'p1', name: 'Notes' }
    mock.emit({ type: 'user_message', sessionId: 'app79', seq: 0, text: 'Make a note', fromApp } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'r', summary: { tool: 'Read', title: 'Read note.md', readOnly: true } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'r', ok: true, summary: 'empty' } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'w', summary: { tool: 'Write', title: 'Write note.md', readOnly: false } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'w', ok: true, summary: 'written' } as never)
    mock.emit(delta('app79', 'Done.'))
    mock.emit({ type: 'turn_complete', sessionId: 'app79' } as never)
    expect(useStore.getState().history['app79']).toBeUndefined()
    const key = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')!.seq

    useStore.getState().focusSession('app79')

    expect(await readAll('app79')).toEqual(['Make a note', 'Read note.md', 'Write note.md', 'Done.'])
    // 보던 카드는 기록과 합쳐져도 같은 키다 — 다시 그려지지 않고, 읽던 자리(scrollAnchor)가 그 키로 남는다
    const write = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')
    expect(write).toMatchObject({ seq: key, result: 'written', ok: true })
  })

  it('첫 연결이 재생한 이벤트가 페이지와 겹쳐도 한 번씩, 제자리에 선다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('r79', sessionInfo('r79'))
    const approval = { type: 'approval_request', sessionId: 'r79', seq: 30, requestId: 'old', detail: { kind: 'command', command: 'old command' } }
    const resolved = { type: 'approval_resolved', sessionId: 'r79', seq: 31, requestId: 'old', decision: 'allow' }
    const stored = rows('r79', 150).map((r) =>
      r.seq === 148 || r.seq === 150 ? { ...r, role: 'assistant' as const, payload: { text: `L${r.seq}` } }
      : r.seq === 30 || r.seq === 31 ? { ...r, role: 'system' as const, kind: 'approval' as const, payload: r.seq === 30 ? approval : resolved }
      : r,
    )
    mock.messages.set('r79', stored as never)

    // 새로 붙은 UI에 host가 버퍼를 재생한다 — 세션을 등록하기 전이라 보관됐다가 attach에서 재생된다.
    // 오래된 말(21), 페이지 안의 말들, 앞부분이 버퍼 밖으로 밀려난 마지막 답('150'만 남았다)
    // 기록은 승인 줄을 그리지 않는다 — 페이지보다 오래된 승인은 제자리를 찾을 수 없으니 남지 않는다
    const replay = [
      { type: 'user_message', sessionId: 'r79', seq: 21, text: 'L21' },
      approval,
      resolved,
      { type: 'message_delta', sessionId: 'r79', seq: 148, role: 'assistant', text: 'L148' },
      { type: 'user_message', sessionId: 'r79', seq: 149, text: 'L149' },
      { type: 'message_delta', sessionId: 'r79', seq: 150, role: 'assistant', text: '150' },
    ]
    for (const e of replay) useStore.getState().dispatchEvent(e as NormalizedEvent)
    await useStore.getState().attach(mock)
    expect(useStore.getState().chat['r79']!.map(line)).toEqual(['L21', 'old command', 'L148', 'L149', '150'])

    useStore.getState().focusSession('r79')

    expect(await readAll('r79')).toEqual(L(150).filter((t) => t !== 'L30' && t !== 'L31'))
  })

  it('기록이 먼저 섰고 같은 줄의 이벤트가 뒤따라도 두 번 그리지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('q79', sessionInfo('q79'))
    mock.messages.set('q79', [
      ...rows('q79', 8),
      { sessionId: 'q79', seq: 9, role: 'system', kind: 'tool_call', payload: { callId: 'c9', summary: { tool: 'Read', title: 'T9', readOnly: true } }, ts: 9 },
      { sessionId: 'q79', seq: 10, role: 'system', kind: 'marker', payload: { type: 'compaction', sessionId: 'q79', failed: false }, ts: 10 },
    ])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('q79')
    await vi.waitFor(() => expect(useStore.getState().history['q79']).toBeDefined())

    // 보관돼 있던 같은 줄의 이벤트가 페이지보다 늦게 재생됐다
    for (const e of [
      { type: 'user_message', sessionId: 'q79', seq: 8, text: 'L8' },
      { type: 'tool_call', sessionId: 'q79', seq: 9, callId: 'c9', summary: { tool: 'Read', title: 'T9', readOnly: true } },
      { type: 'compaction', sessionId: 'q79', seq: 10, failed: false },
    ]) useStore.getState().dispatchEvent(e as NormalizedEvent)

    expect(useStore.getState().chat['q79']!.map(line)).toEqual([...L(8), 'T9', 'Earlier messages were compacted here'])
  })

  it('흐르는 중인 말은 기록과 합쳐도 잘리지 않는다 — 화면 쪽이 저장된 본문보다 길다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('s79', sessionInfo('s79'))
    mock.messages.set('s79', rows('s79', 10))
    await useStore.getState().attach(mock)
    mock.emit(delta('s79', 'Hel'))

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('s79')
    // 페이지를 읽은 뒤에 도착한 조각 — 저장소의 그 말은 아직 'Hel'이다
    mock.emit(delta('s79', 'lo'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('s79')).toEqual([...L(10), 'Hello'])
  })

  it('번호 없는 꼬리(보낸 말·이미지·오류)는 기록에 이미 있으면 한 번만, 승인 줄은 제자리에 남는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('e79', sessionInfo('e79'))
    mock.sessions.set('e79-other', sessionInfo('e79-other'))
    mock.messages.set('e79', rows('e79', 5))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('e79-other')

    // 이 세션을 열기 전에: 승인을 거친 명령, 사람이 보낸 말(목은 확인을 보내지 않는다 — 번호가 없다),
    // 에이전트의 이미지(이벤트에는 번호가 없다), 실패한 턴(스키마가 번호를 지운다, #161)
    mock.emit({ type: 'approval_request', sessionId: 'e79', requestId: 'q1', detail: { kind: 'command', command: 'rm -rf build' } } as never)
    mock.emit({ type: 'approval_resolved', sessionId: 'e79', requestId: 'q1', decision: 'allow' } as never)
    await useStore.getState().send('e79', 'Hi')
    mock.emit({ type: 'message_image', sessionId: 'e79', mime: 'image/png', data: 'aWJs' } as never)
    const error = { type: 'error', sessionId: 'e79', error: { code: 'internal', message: 'boom', retryable: false } }
    mock.messages.get('e79')!.push({ sessionId: 'e79', seq: 10, role: 'system', kind: 'marker', payload: error, ts: 10 })
    useStore.getState().dispatchEvent(error as NormalizedEvent)
    expect(useStore.getState().chat['e79']!.map((i) => i.storedSeq)).toEqual([6, undefined, undefined, undefined])

    useStore.getState().focusSession('e79')

    expect(await readAll('e79')).toEqual([
      ...L(5), 'rm -rf build', 'Hi', 'image:image/png', 'The agent could not finish this turn — boom',
    ])
  })

  it('불러오기로 복원한 세션도 끝까지 거슬러 읽으면 한 번씩이다 — 화면에 있는 번호는 다시 붙이지 않는다', async () => {
    const mock = new MockPlatform()
    mock.externalHistory.set('ext-79', Array.from({ length: 150 }, (_, i) => ({ role: 'user' as const, text: `L${i + 1}` })))
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/imp79')
    const info = await useStore.getState().createSession(p.id, { resumeExternalId: 'ext-79', importHistory: true })

    expect(await readAll(info.id)).toEqual(L(150))
  })

  it('번호 없는 빈 조각으로 시작한 말도 뒤따른 조각의 저장 번호를 받는다 — 합칠 때 두 번 서지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('d79', sessionInfo('d79'))
    mock.messages.set('d79', rows('d79', 3))
    await useStore.getState().attach(mock)

    // host는 빈 조각을 저장하지 않고 번호 없이 보낸다(codex 끝의 ""). 그 뒤 조각이 4번 줄을 시작한다
    useStore.getState().dispatchEvent(delta('d79', ''))
    mock.emit(delta('d79', 'Answer'))
    useStore.getState().focusSession('d79')

    expect(await readAll('d79')).toEqual([...L(3), 'Answer'])
  })

  it('창을 자를 때 맨 위가 실시간 줄이어도 커서는 저장 번호다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('t79', sessionInfo('t79'))
    mock.sessions.set('t79-other', sessionInfo('t79-other'))
    mock.messages.set('t79', rows('t79', 120))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 't79-big')
    useStore.getState().focusSession('t79')
    await vi.waitFor(() => expect(useStore.getState().history['t79']).toBeDefined())

    // 보는 동안 도구 호출 60개가 이어진다 — 떠날 때 남는 50줄이 모두 실시간 줄이다
    for (let i = 121; i <= 180; i++) {
      mock.emit({ sessionId: 't79', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}`, readOnly: true } } as never)
    }
    useStore.getState().focusSession('t79-other')
    expect(useStore.getState().chat['t79']).toHaveLength(50)
    expect(useStore.getState().history['t79']!.oldestSeq).toBe(131)

    useStore.getState().focusSession('t79')
    expect(await readAll('t79')).toEqual(L(180))
  })
})

describe('재연결 시 세션 목록 병합 (U4)', () => {
  it('끊긴 사이 생기고·이름이 바뀌고·지워진 세션이 화면에 반영된다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s1', sessionInfo('u4-s1'))
    mock.sessions.set('u4-gone', sessionInfo('u4-gone'))
    await useStore.getState().attach(mock)

    // 끊긴 사이: 하나는 지워지고, 하나는 이름이 바뀌고, 하나는 새로 생겼다
    mock.sessions.delete('u4-gone')
    mock.sessions.get('u4-s1')!.name = '바뀐 이름'
    mock.sessions.set('u4-new', sessionInfo('u4-new'))

    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => {
      const s = useStore.getState().sessions
      expect(s['u4-new']).toBeDefined()
      expect(s['u4-gone']).toBeUndefined()
      expect(s['u4-s1']!.name).toBe('바뀐 이름')
    })
  })

  it('로컬 파생 상태(preview 등)는 병합에서 살아남는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s2', sessionInfo('u4-s2'))
    await useStore.getState().attach(mock)
    // 이벤트로 만들어진 로컬 파생 상태 — host 목록에는 없는 값이다
    useStore.getState().dispatchEvent(delta('u4-s2', '진행 중이던 답'))
    expect(useStore.getState().sessions['u4-s2']!.preview).not.toBe('')
    const preview = useStore.getState().sessions['u4-s2']!.preview

    mock.sessions.get('u4-s2')!.name = '병합 완료 표식'
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    // 이름 갱신이 곧 '병합이 실제로 돌았다'는 증거다 — 그 위에서 preview 보존을 확인한다
    await vi.waitFor(() => expect(useStore.getState().sessions['u4-s2']!.name).toBe('병합 완료 표식'))

    expect(useStore.getState().sessions['u4-s2']!.preview).toBe(preview)
  })

  it('지워진 세션이 포커스 중이었다면 포커스도 걷는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s3', sessionInfo('u4-s3'))
    await useStore.getState().attach(mock)
    useStore.setState({ focusedSessionId: 'u4-s3' })

    mock.sessions.delete('u4-s3')
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['u4-s3']).toBeUndefined())
    expect(useStore.getState().focusedSessionId).toBeNull()
  })
})

/*
 * 살아-있는-동안 사실(승인·질문·활동·한도·사용량)은 host 메모리가 원본이다.
 * 재연결·재시작 시 목록에 실려 온 값을 이어받지 않으면 state=waiting_approval인데
 * 카드 payload가 없어 승인이 화면에 영영 안 나타난다 (재시작 후 실측).
 */
describe('살아-있는-동안 사실 이어받기', () => {
  const approval = {
    requestId: 'req-9',
    detail: { kind: 'command' as const, command: 'rm -rf node_modules', cwd: '/tmp' },
  }

  it('attach가 host의 pendingApproval을 세션 요약으로 옮긴다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('lf-s1', sessionInfo('lf-s1', { state: 'waiting_approval', pendingApproval: approval }))

    await useStore.getState().attach(mock)

    const s = useStore.getState().sessions['lf-s1']!
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval).toEqual(approval)
  })

  it('재연결 병합은 host의 승인 상태를 원본으로 삼는다 — 끊긴 사이 풀렸으면 걷는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('lf-s2', sessionInfo('lf-s2', { state: 'waiting_approval', pendingApproval: approval }))
    await useStore.getState().attach(mock)
    expect(useStore.getState().sessions['lf-s2']!.pendingApproval).toEqual(approval)

    // 끊긴 사이 다른 창에서 승인이 풀렸다 — host 목록에는 더 이상 없다
    const resolved = { ...mock.sessions.get('lf-s2')!, state: 'idle' as const, pendingApproval: null }
    mock.sessions.set('lf-s2', resolved)
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['lf-s2']!.pendingApproval).toBeNull())
  })
})

/*
 * Settings survive a restart on screen, not only in the database (issue #37).
 *
 * Reported as "model, effort and permissions do not save": the database held the chosen
 * values the whole time and the host read them back, but the store's cold-start path took
 * only `effort` off the list and let initialSession's defaults fill the rest — so the button
 * under the composer said "Default · Normal" and every restart looked like a loss.
 * A stored value must come from the session, never from what the startup path bothered to
 * name, so this checks all of them at once.
 */
describe('저장된 세션 설정 이어받기 (이슈 #37)', () => {
  const stored = {
    model: 'claude-fable-5[1m]',
    effort: 'high',
    permissionPreset: 'auto' as const,
    worktree: { path: '/tmp/wt/feature', branch: 'feature' },
  }

  it('앱을 다시 켜면 host가 준 모델·강도·권한·워크트리가 그대로 남는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ss-s1', sessionInfo('ss-s1', stored))

    await useStore.getState().attach(mock)

    expect(useStore.getState().sessions['ss-s1']).toMatchObject(stored)
  })

  it('재연결 병합도 같은 값을 준다 — 두 경로가 같은 요약을 만든다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    // 끊긴 사이에 다른 창에서 만들어진 세션이다 — 병합이 처음 등록한다
    mock.sessions.set('ss-s2', sessionInfo('ss-s2', stored))
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['ss-s2']).toMatchObject(stored))
  })
})

/*
 * When the current turn started (issue #23).
 *
 * The "Waiting for response" line counted up from its own mount, so any remount put a
 * three-minute turn back at zero. The instant lives here now and the count is derived from
 * it — which only helps if the instant itself holds still while a turn streams, and is let
 * go when the turn ends. Both are what these check.
 *
 * It is deliberately not `waitingSince`: that one is when a session started waiting for a
 * *human*, and the reducer nulls it the moment a session goes back to working.
 */
describe('턴이 시작된 시각 (이슈 #23)', () => {
  it('스트리밍이 이어지는 동안 시각은 움직이지 않는다 — 경과는 여기서 파생된다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s1', sessionInfo('ws-s1'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s1', '첫 글자'))
    const started = useStore.getState().workingSince['ws-s1']
    expect(started).toBeDefined()
    expect(useStore.getState().sessions['ws-s1']!.state).toBe('working')

    useStore.getState().dispatchEvent(delta('ws-s1', ' 그리고 다음'))
    expect(useStore.getState().workingSince['ws-s1']).toBe(started)
  })

  it('턴이 끝나면 시각도 놓는다 — 다음 턴이 남의 시작을 물려받으면 안 된다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s2', sessionInfo('ws-s2'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s2', '답'))
    expect(useStore.getState().workingSince['ws-s2']).toBeDefined()

    useStore.getState().dispatchEvent({ sessionId: 'ws-s2', type: 'turn_complete' } as NormalizedEvent)
    expect(useStore.getState().sessions['ws-s2']!.state).toBe('waiting_input')
    expect(useStore.getState().workingSince['ws-s2']).toBeUndefined()
  })

  it('앱을 켜기 전부터 돌던 세션에도 시각이 찍힌다 — 없으면 화면이 셀 근거가 없다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s3', sessionInfo('ws-s3', { state: 'working' }))

    await useStore.getState().attach(mock)

    // 턴이 진짜 시작된 시각은 host가 안 알려준다 — 우리가 알게 된 순간이 가장 이른 정직한 답이다
    expect(useStore.getState().workingSince['ws-s3']).toBeDefined()
  })
})

describe('첫 프롬프트 이중 그리기 방지', () => {
  it('host의 user_message 확인이 낙관적 첫 프롬프트를 확정한다 — 두 번 그리지 않는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/ip')
    const info = await useStore.getState().createSession(p.id, { initialPrompt: '첫 지시' })

    // host도 첫 프롬프트를 저장하고 알린다 (manager.createSession의 user_message)
    useStore
      .getState()
      .dispatchEvent({ type: 'user_message', sessionId: info.id, seq: 1, text: '첫 지시' } as NormalizedEvent)

    const users = useStore.getState().chat[info.id]!.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect((users[0] as { pending?: boolean }).pending).toBe(false)
  })
})

describe('워크스페이스 스냅샷 단일 작성자 (U7)', () => {
  it('알림 정책을 바꾼 뒤 레이아웃을 저장해도 정책이 지워지지 않는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    const policy: NotifyPolicy = { ...DEFAULT_NOTIFY_POLICY, sound: !DEFAULT_NOTIFY_POLICY.sound }
    useStore.getState().setNotifyPolicy(policy)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy } | null)?.notifyPolicy).toEqual(policy)

    // 예전에는 이 저장이 notifyPolicy 없는 부분 스냅샷으로 통째로 덮었다 → 재시작 시 정책 초기화
    // (사건 당시의 예시는 treeHeight였다 — 그 설정은 스트립과 함께 떠났고, 규칙은 남는다)
    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    const snap = mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy; showIgnored?: boolean } | null
    expect(snap?.notifyPolicy).toEqual(policy)
    expect(snap?.showIgnored).toBe(false)
  })

  it('반대로 정책 저장이 레이아웃(showIgnored)을 지우지도 않는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    useStore.getState().setNotifyPolicy({ ...DEFAULT_NOTIFY_POLICY })
    await new Promise((r) => setTimeout(r, 0))

    expect((mock.workspaceSnapshot as { showIgnored?: boolean } | null)?.showIgnored).toBe(false)
  })

  /*
   * 글자 크기(5단계)도 보는 방식이다 — 스냅샷에 실리고, 재시작을 넘기고,
   * 다섯 단계 밖의 값(망가진 스냅샷·미래 버전)은 가장 가까운 단계로 접힌다.
   */
  it('글자 크기 단계가 저장되고, 범위 밖 값은 단계로 접힌다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setTextScale(4)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { textScale?: number } | null)?.textScale).toBe(4)

    useStore.getState().setTextScale(99)
    expect(useStore.getState().textScale).toBe(4)
    useStore.getState().setTextScale(-3)
    expect(useStore.getState().textScale).toBe(0)
  })

  it('저장된 글자 크기가 재시작(재연결) 후 되살아난다', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { textScale: 3 }
    await useStore.getState().attach(mock)
    expect(useStore.getState().textScale).toBe(3)
  })

  /*
   * "무시된 파일을 볼 수 없다"의 실제 내용은 "볼 수는 있는데 매번 잊는다"였다 (이슈 #17).
   * 스위치가 부품에 있어서 깃 탭으로 나갔다 오면 꺼져 있었다.
   *
   * The direction that matters is now *off*, since on is the default (#17 again). Turning
   * it off is the only version of this choice a person can make deliberately, so it is the
   * one that has to survive a relaunch — and it has to survive the default too.
   */
  it('무시된 파일 숨기기는 다음 실행에도 남는다 — 볼 방식은 사람의 것이다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s1', sessionInfo('si-s1'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('si-s1')

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { showIgnored?: boolean } | null)?.showIgnored).toBe(false)

    // 앱을 다시 켠 셈 — 기본값으로 돌아간 스토어에 같은 스냅샷을 물린다
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(false)
  })

  /*
   * A stored `false` outranks the default; an *absent* field must not. The two are only
   * distinguishable because the snapshot is read with a `typeof` check — read it as `??
   * false` or `!!snap.showIgnored` instead and every older snapshot suddenly claims someone
   * turned this off, so the default could never move again. That is what this pins.
   */
  it('스냅샷에 없던 설정은 기본값 그대로 둔다 — 안 고른 것과 끈 것은 다르다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s2', sessionInfo('si-s2'))
    // A snapshot from before this setting existed: it has layout, but no opinion on this
    mock.workspaceSnapshot = { focusedSessionId: 'si-s2', panelOpen: true, panelTab: 'git' }

    // 앱을 막 켠 셈 — 기본값(켜짐)에서 시작한다
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(true)
  })
})

/*
 * 이름 바꾸기가 실패했는데 화면만 성공하는 일이 없어야 한다 (이슈 #5).
 * 이 저장소가 반복해서 데인 버그라, 실패는 반드시 사람 눈에 닿는 자리(토스트)로 나와야 한다.
 */
describe('세션 이름 바꾸기 (이슈 #5)', () => {
  it('성공하면 이름이 바뀌고 자동 이름이 잠긴다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s1', sessionInfo('rn-s1'))
    await useStore.getState().attach(mock)

    await useStore.getState().rename('rn-s1', '  가드 MCP  ')

    expect(useStore.getState().sessions['rn-s1']).toMatchObject({ name: '가드 MCP', autoNamed: false })
    expect(useStore.getState().toast).toBeNull()
  })

  it('실패하면 이름을 그대로 두고 토스트로 알린다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s2', sessionInfo('rn-s2', { name: '옛 이름' }))
    await useStore.getState().attach(mock)
    // host가 거절하는 상황 — 세션이 사라진 뒤에 이름을 고치는 것이 실제 경로다
    mock.sessions.delete('rn-s2')

    await useStore.getState().rename('rn-s2', '새 이름')

    expect(useStore.getState().sessions['rn-s2']!.name).toBe('옛 이름')
    expect(useStore.getState().toast).toMatch(/Could not rename/)
  })

  it('빈 이름은 보내지 않고 그 자리에서 알린다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s3', sessionInfo('rn-s3', { name: '옛 이름' }))
    await useStore.getState().attach(mock)

    await useStore.getState().rename('rn-s3', '   ')

    expect(useStore.getState().sessions['rn-s3']!.name).toBe('옛 이름')
    expect(useStore.getState().toast).toMatch(/empty/i)
  })
})

describe('대화가 바닥에 서 있었는가 (이슈 #31)', () => {
  it('아무도 스크롤하지 않은 세션은 바닥에 있는 것으로 본다 — 대화는 최신 줄에서 시작한다', () => {
    expect(useStore.getState().stickToBottom['sb-s1']).toBeUndefined()
  })

  it('위로 올려 읽는 중이면 그 사실이 세션에 남는다', () => {
    useStore.getState().setStickToBottom('sb-s1', false)
    expect(useStore.getState().stickToBottom['sb-s1']).toBe(false)
  })

  /*
   * 기본값(바닥)은 **기록하지 않는 것으로** 기록한다. 그래야 스쳐 간 세션마다
   * 항목이 하나씩 쌓이지 않는다 — 쓰다 만 글이 빈 초안을 지우는 것과 같은 규칙이다.
   */
  it('바닥으로 돌아오면 항목 자체가 사라진다', () => {
    useStore.getState().setStickToBottom('sb-s2', false)
    useStore.getState().setStickToBottom('sb-s2', true)
    expect('sb-s2' in useStore.getState().stickToBottom).toBe(false)
  })

  /*
   * 스크롤 한 번에 이벤트가 수십 번 온다. 값이 그대로인데 새 객체를 만들면
   * 이 map을 보는 모든 구독자가 스크롤하는 내내 다시 그려진다.
   */
  it('값이 그대로면 새 상태를 만들지 않는다 — 스크롤은 초당 수십 번 부른다', () => {
    useStore.getState().setStickToBottom('sb-s3', false)
    const before = useStore.getState().stickToBottom
    useStore.getState().setStickToBottom('sb-s3', false)
    expect(useStore.getState().stickToBottom).toBe(before)
  })
})

/**
 * 업데이트 상태는 세션에 속하지 않는다 (이슈 #43).
 *
 * `dispatchEvent`의 첫 줄은 `if (!sessionId) return`이고, 그것이 이 파일에서 가장 넓은
 * 문이다. 앱 전역 사건을 그 뒤에 두면 host가 보낸 것이 도착은 하는데 아무 일도 일어나지
 * 않는다 — 통신도 정상이고 오류도 없어서, 원인을 찾을 실마리가 어디에도 안 남는 종류의
 * 결함이다. 순서가 곧 계약이라 여기서 못을 박는다.
 */
describe('업데이트 상태 (#43)', () => {
  const status = {
    current: '0.1.0-beta.2', latest: '9999.0.0', newer: true, auto: true,
    phase: 'idle' as const, error: null, checkedAt: 1,
  }

  it('세션이 없는 이벤트도 스토어에 도착한다', () => {
    useStore.getState().dispatchEvent({ type: 'update_status', status })
    expect(useStore.getState().update?.latest).toBe('9999.0.0')
  })

  /** 설치는 사람이 눌러야 시작한다 — 알아냈다는 것만으로는 아무 일도 안 일어난다 */
  it('새 버전을 알게 되는 것만으로는 아무것도 설치하지 않는다', async () => {
    const platform = new MockPlatform()
    platform.registryVersion = '9999.0.0'
    useStore.setState({ platform })
    await useStore.getState().checkUpdate(true)
    expect(useStore.getState().update?.newer).toBe(true)
    expect(useStore.getState().update?.phase).toBe('idle')
  })
})

/**
 * 입력창 포커스는 기존 wake()를 다시 부른다 — 그 wake가 지켜야 할 성질들.
 *
 * 사이드바에서 고르기(focusSession)와 그리드 칸·재시작 복원의 입력창 포커스가
 * 같은 문으로 들어온다. 실패는 wakeError에 남을 뿐 토스트로 소리치지 않고
 * (포커스는 행동이 아니다), 이미 살아 있으면 아무 데도 가지 않는다.
 */
describe('wake — 포커스 경로의 조용한 깨움', () => {
  it('잠든 세션을 깨우고 live로 표시한다', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    await useStore.getState().wake(s.id)
    expect(useStore.getState().sessions[s.id]?.live).toBe(true)
    expect(useStore.getState().toast).toBeNull()
  })

  it('깨우기 실패는 토스트가 아니라 wakeError로 남는다', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    platform.unresumable.add(s.id)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    await useStore.getState().wake(s.id)
    expect(useStore.getState().toast).toBeNull()
    expect(useStore.getState().sessions[s.id]?.live).toBe(false)
    expect(useStore.getState().wakeError[s.id]).toBeTruthy()
  })

  it('이미 살아 있으면 아무 데도 안 간다', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const spy = vi.spyOn(platform.agents, 'resumeSession')
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: true } as never } })

    await useStore.getState().wake(s.id)
    expect(spy).not.toHaveBeenCalled()
  })
})

/**
 * 보던 화면이 재시작을 넘어온다.
 *
 * 세션은 돌아오는데 **보는 방식**은 돌아오지 않았다 — 그리드에서 껐는데 포커스 뷰로
 * 켜졌다. 복원 순서가 함정이다: focusSession이 view를 focus로 강제하므로
 * (고른 세션은 보여야 하니까), 화면 복원은 그 **뒤**여야 한다.
 */
describe('화면(view) 복원', () => {
  it('그리드에서 껐으면 그리드로 켜진다 — 세션 복원이 덮어쓰지 못한다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('vw-s1', sessionInfo('vw-s1'))
    mock.workspaceSnapshot = { focusedSessionId: 'vw-s1', view: 'grid' }

    await useStore.getState().attach(mock)

    expect(useStore.getState().focusedSessionId).toBe('vw-s1')
    expect(useStore.getState().view).toBe('grid')
  })

  it('화면을 바꾸면 저장된다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setView('grid')
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { view?: string } | null)?.view).toBe('grid')
  })

  it('모르는 화면 이름은 무시한다 — 스냅샷은 파일이다', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { view: 'hologram' }

    await useStore.getState().attach(mock)
    expect(useStore.getState().view).toBe('focus')
  })
})

describe('messagesToChat — 도구 출력 복원', () => {
  /*
   * host는 호출과 결과를 각각 한 행으로 남긴다. 결과 분기가 없던 동안 세션을 다시 열면
   * 카드가 제목만 남고 출력이 사라졌다 — 라이브로 보던 사람에게만 있던 화면이다.
   */
  const call = (seq: number) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_call' as const,
    payload: { type: 'tool_call', summary: { tool: 'Bash', title: 'pnpm test', readOnly: true } },
    ts: 0,
  })
  const result = (seq: number, summary: string, ok = true) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_result' as const,
    payload: { type: 'tool_result', callId: 'c1', ok, summary },
    ts: 0,
  })

  it('결과 행은 아직 결과가 없는 도구 줄에 붙는다', () => {
    const items = messagesToChat([call(1), result(2, '3 passed')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', result: '3 passed', ok: true })
  })

  it('호출이 여럿이면 뱉은 순서대로 짝을 짓는다 — 둘이 서로 바뀌지 않는다', () => {
    const items = messagesToChat([call(1), call(2), result(3, '첫째'), result(4, '둘째', false)])
    expect(items.map((i) => (i.kind === 'tool' ? [i.result, i.ok] : null))).toEqual([
      ['첫째', true],
      ['둘째', false],
    ])
  })

  it('짝 없는 결과는 버린다 — 없던 줄을 만들지 않는다', () => {
    expect(messagesToChat([result(1, '주인 없는 출력')])).toEqual([])
  })
})

/**
 * 도구 줄은 callId로 제 결과·출력을 찾는다 (#98).
 *
 * 백그라운드 에이전트의 카드는 띄운 순간부터 끝날 때까지 열려 있고(어댑터가 띄운 결과를
 * 보류한다), 그동안 부모는 제 도구를 쓴다. 자리 규칙(가장 오래 열린 줄·마지막 열린 줄)은
 * 그 사이에서 주인을 바꿔 붙인다 — 부모의 Bash 결과가 에이전트 카드로, 에이전트의 걸음이
 * 부모의 Bash 카드로. 라이브와 복원 두 길을 같이 본다.
 */
describe('도구 줄은 callId로 짝을 찾는다 — 열린 에이전트 카드 옆에서 (#98)', () => {
  const agentCall = {
    type: 'tool_call', callId: 'toolu_agent',
    summary: { tool: 'Agent', title: 'Research the build', readOnly: false, paths: [] },
  }
  const bashCall = {
    type: 'tool_call', callId: 'toolu_bash',
    summary: { tool: 'Bash', title: 'git status', readOnly: false, paths: [] },
  }
  const bashDone = { type: 'tool_result', callId: 'toolu_bash', ok: true, summary: 'nothing to commit' }
  const agentDone = { type: 'tool_result', callId: 'toolu_agent', ok: true, summary: '3 tool uses · 2m 14s\n\nI checked all 13 items' }
  const tools = (items: ReturnType<typeof messagesToChat>) =>
    items.flatMap((i) => (i.kind === 'tool' ? [{ tool: i.tool, result: i.result, live: i.live }] : []))

  it('라이브: 부모의 결과는 부모의 카드로, 에이전트의 걸음은 에이전트의 카드로', async () => {
    const s = 'cid-live'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    const send = (e: object) => useStore.getState().dispatchEvent({ sessionId: s, ...e } as NormalizedEvent)

    send(agentCall)
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Running in the background\n' })
    send(bashCall)
    // 부모의 Bash가 열려 있는 동안 에이전트가 한 걸음 걷는다
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Grep: boundaries\n' })
    send(bashDone)

    expect(tools(useStore.getState().chat[s] ?? [])).toEqual([
      { tool: 'Agent', result: undefined, live: 'Running in the background\nGrep: boundaries\n' },
      { tool: 'Bash', result: 'nothing to commit', live: undefined },
    ])

    send(agentDone)
    expect(tools(useStore.getState().chat[s] ?? [])[0]).toEqual({
      tool: 'Agent', result: '3 tool uses · 2m 14s\n\nI checked all 13 items', live: undefined,
    })
  })

  it('복원: 저장된 순서가 호출 순서와 달라도 제 짝을 찾는다', () => {
    const row = (seq: number, kind: 'tool_call' | 'tool_result', payload: object) =>
      ({ sessionId: 's', seq, role: 'system' as const, kind, payload, ts: 0 })
    const items = messagesToChat([
      row(1, 'tool_call', agentCall),
      row(2, 'tool_call', bashCall),
      row(3, 'tool_result', bashDone),
      row(4, 'tool_result', agentDone),
    ])
    expect(tools(items).map((t) => [t.tool, t.result])).toEqual([
      ['Agent', '3 tool uses · 2m 14s\n\nI checked all 13 items'],
      ['Bash', 'nothing to commit'],
    ])
  })

  it('복원: 호출이 이 묶음 밖에 있는 결과는 열린 에이전트 카드를 집지 않는다', () => {
    const items = messagesToChat([
      { sessionId: 's', seq: 1, role: 'system', kind: 'tool_call', payload: agentCall, ts: 0 },
      { sessionId: 's', seq: 2, role: 'system', kind: 'tool_result', payload: { ...bashDone, callId: 'toolu_elsewhere' }, ts: 0 },
    ])
    expect(tools(items)).toEqual([{ tool: 'Agent', result: undefined, live: undefined }])
  })
})

/**
 * 실패한 턴은 **보여야 한다** (#107).
 *
 * 실사고: codex 롤아웃에는 `task_complete`에 400 전문이 실려 있었는데 앱에는 빈 답변이
 * 남고 상태는 `waiting_input`이었다. "사람을 기다리는 중"은 거짓말이다 — 기다려야 할
 * 것은 사람이 아니라 설명이었다. 두 반쪽을 함께 본다: 전사에 남는가, 상태가 정직한가.
 */
describe('실패한 턴은 화면에 닿는다 (#107)', () => {
  const boom = (sessionId: string, message: string) =>
    ({ type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }) as NormalizedEvent

  it('오류가 전사에 한 줄로 서고, 세션은 idle인 척하지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('err-1', sessionInfo('err-1'))
    await useStore.getState().attach(mock)

    mock.emit(boom('err-1', "The 'opus[1m]' model is not supported"))

    const last = (useStore.getState().chat['err-1'] ?? []).at(-1)
    expect(last?.kind).toBe('mark')
    expect((last as { text: string }).text).toContain("The 'opus[1m]' model is not supported")
    expect(useStore.getState().sessions['err-1']?.state).toBe('error')
  })

  it('다시 열어도 그 줄이 있다 — 오류는 마커로 저장된다', () => {
    const items = messagesToChat([
      {
        sessionId: 'err-2', seq: 4, role: 'system', kind: 'marker', ts: 1,
        payload: { type: 'error', sessionId: 'err-2', error: { code: 'internal', message: '400 invalid_request_error' } },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mark', seq: 4 })
    expect((items[0] as { text: string }).text).toContain('400 invalid_request_error')
  })
})

describe('messagesToChat — 이미지 행 (#40 2차)', () => {
  it('영속된 이미지가 대화로 되살아난다', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 1, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs', path: '/tmp/a.png' },
      },
    ])
    expect(items).toEqual([{ kind: 'image', seq: 1, storedSeq: 1, mime: 'image/png', data: 'aWJs', path: '/tmp/a.png', note: undefined }])
  })

  it('정리된 이미지는 이유를 들고 되살아난다 — 조용한 공백이 아니다', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 2, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: '', path: '/tmp/b.png', note: '이미지가 정리되어 더 이상 없습니다 (총량 상한)' },
      },
    ])
    expect(items[0]).toMatchObject({ kind: 'image', data: '', note: expect.stringContaining('정리') })
  })
})

/** 추론 요약 (#58) — 델타 행들이 한 덩어리로 되살아난다 (assistant와 같은 규칙) */
describe('messagesToChat — 추론 행', () => {
  it('연속된 reasoning 행이 하나로 합쳐진다', () => {
    const row = (seq: number, text: string) => ({
      sessionId: 's1', seq, role: 'assistant' as const, kind: 'reasoning' as const, ts: 1,
      payload: { type: 'reasoning_delta', sessionId: 's1', text },
    })
    const items = messagesToChat([row(1, '**경로'), row(2, ' 검토**'), {
      sessionId: 's1', seq: 3, role: 'assistant', kind: 'text', ts: 1,
      payload: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: '답' },
    }])
    expect(items).toEqual([
      { kind: 'reasoning', seq: 1, storedSeq: 1, text: '**경로 검토**' },
      { kind: 'assistant', seq: 3, storedSeq: 3, text: '답' },
    ])
  })
})

/**
 * 대화 항목의 **정체성(identity)** — 바뀐 줄만 새 객체가 된다.
 *
 * 화면 쪽 최적화가 이 규칙 위에 서 있다: ChatRow는 memo라, 항목 객체가 그대로면 다시
 * 그리지 않는다. 그래서 스트리밍 조각 하나가 도착할 때 다시 그려지는 말풍선은 **하나**다
 * (실측 1.0 렌더/조각). 리듀서가 어느 날 `items.map((i) => ({ ...i }))` 같은 걸 하면
 * 그 성질이 조용히 사라진다 — 화면은 똑같이 보이고 비용만 대화 길이에 비례해 자란다.
 * 렌더 수는 브라우저에서만 셀 수 있지만, 그 근거인 정체성은 여기서 못 박을 수 있다.
 */
describe('대화 항목의 정체성 — 바뀐 줄만 새 객체다', () => {
  const idOf = (sessionId: string) => useStore.getState().chat[sessionId] ?? []

  it('스트리밍 조각은 마지막 줄만 새로 만든다', async () => {
    const s = 'ident-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({ type: 'user_message', sessionId: s, seq: 1, text: '질문' } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, '답 '))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent(delta(s, '이어서'))
    const after = idOf(s)
    expect(after.length).toBe(2)
    expect(after[0]).toBe(before[0]) // 사람의 말은 손대지 않는다 — 같은 객체다
    expect(after[1]).not.toBe(before[1]) // 자라는 줄만 새 객체
  })

  it('도구 결과는 그 도구 줄만 새로 만든다 — 뒤에 온 말들은 그대로다', async () => {
    const s = 'ident-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({
      type: 'tool_call', sessionId: s, callId: 'c1',
      summary: { tool: 'Read', title: 'a.ts', readOnly: true, paths: [] },
    } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, '읽는 중'))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent({
      type: 'tool_result', sessionId: s, callId: 'c1', ok: true, summary: '12 lines',
    } as NormalizedEvent)
    const after = idOf(s)
    expect(after[0]).not.toBe(before[0]) // 결과가 붙은 도구 줄만
    expect(after[1]).toBe(before[1]) // 그 뒤의 말은 건드리지 않는다
  })
})

/**
 * 전송 실패 시 쓴 글 복원 (2026-09-02 유실 사고 후속).
 *
 * 입력창은 보내는 순간 비워진다(#38). 실패하면 말풍선을 걷어내는데, 그러면 문장이
 * **어디에도 없다** — 토스트는 실패를 알릴 뿐 글을 돌려주지 못한다. 실패한 문장은
 * 입력창으로 돌아와야 다시 보낼 수 있다.
 */
describe('전송 실패 시 쓴 글 복원', () => {
  it('실패하면 문장이 입력창으로 돌아온다', async () => {
    const s = 'sf-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s) // host가 거절하는 상황 (rename 실패 테스트와 같은 수법)

    await useStore.getState().send(s, '날아가면 안 되는 문장')

    expect(useStore.getState().drafts[s]?.text).toBe('날아가면 안 되는 문장')
    expect(useStore.getState().toast).toMatch(/Could not send/)
    // 보낸 것처럼 남는 말풍선은 여전히 없다 (기존 동작 유지)
    expect((useStore.getState().chat[s] ?? []).some((i) => i.kind === 'user')).toBe(false)
  })

  it('실패를 기다리는 사이 새로 쓴 글은 덮지 않는다 — 실패한 말이 앞에 붙는다', async () => {
    const s = 'sf-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s)

    const inFlight = useStore.getState().send(s, '먼저 보낸 문장')
    useStore.getState().setDraft(s, { text: '그새 쓴 문장', attachments: [] })
    await inFlight

    expect(useStore.getState().drafts[s]?.text).toBe('먼저 보낸 문장\n그새 쓴 문장')
  })

  it('성공하면 입력창을 건드리지 않는다', async () => {
    const s = 'sf-s3'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)

    await useStore.getState().send(s, '잘 가는 문장')

    expect(useStore.getState().drafts[s]).toBeUndefined()
  })
})

/**
 * 그리드 세션 예열 (도그푸딩: 메아 — codex 큰 스레드 되살리기가 실측 7~13초).
 * 줄일 수 없는 비용은 사람이 안 기다리는 시간으로 옮긴다: 그리드에 올려둔 세션은
 * 앱이 뜰 때 백그라운드에서 깨워 둔다. 실패해도 앱은 뜨고, 실패는 클릭해서 깨울
 * 때와 같은 자리(wakeError)에 남는다.
 */
describe('그리드 세션 예열', () => {
  it('attach가 그리드에 올려둔 잠든 세션을 미리 깨운다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('warm-a', sessionInfo('warm-a', { live: false }))
    mock.sessions.set('warm-b', sessionInfo('warm-b', { live: false }))
    await mock.agents.setGridView(['warm-a', 'warm-b'])
    await useStore.getState().attach(mock)

    await vi.waitFor(() => {
      expect(useStore.getState().sessions['warm-a']!.live).toBe(true)
      expect(useStore.getState().sessions['warm-b']!.live).toBe(true)
    })
  })

  it('깨우기 실패는 그 칸의 wakeError로 남는다 — 앱은 계속 뜬다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('warm-c', sessionInfo('warm-c', { live: false }))
    mock.unresumable.add('warm-c')
    await mock.agents.setGridView(['warm-c'])
    await useStore.getState().attach(mock)

    await vi.waitFor(() => {
      expect(useStore.getState().wakeError['warm-c']).toBeTruthy()
    })
    expect(useStore.getState().connection).toBe('connected')
    expect(useStore.getState().sessions['warm-c']!.live).toBe(false)
  })
})

/**
 * 인수인계하고 새로 시작 (도그푸딩 요청 — 늙은 스레드의 되살리기 7~13초 문제의 출구).
 * 죽는 세션이 쓴 글이 새 세션의 첫 메시지가 되고, 이름·설정이 이어지고,
 * 기존 세션은 원본까지 지워진다. 파괴는 맨 끝 — 실패하면 아무것도 안 지워진다.
 */
/**
 * 앱 상태 (#81): 스토어는 앱 목록을 모른다 — 항목은 ensure(첫 사용)와
 * app_state_changed 방송으로만 생긴다. 문서의 의미는 앱만 안다.
 */
describe('앱 상태 (#81)', () => {
  it('ensure가 불러오고, 방송이 다시 읽게 하고, setAppDoc은 화면 먼저다', async () => {
    const mock = new MockPlatform()
    mock.appDocs.set('control', { notifies: [{ id: 'n1', text: '첫 알림', ts: 1 }] })
    await useStore.getState().attach(mock)

    // 첫 사용: ensure가 채운다
    await useStore.getState().ensureAppState('control')
    expect((useStore.getState().apps['control']?.doc as { notifies: unknown[] }).notifies).toHaveLength(1)

    // host 쪽 변경은 방송으로 온다 — 스토어는 다시 읽는다
    mock.appDocs.set('control', { notifies: [] })
    mock.emit({ type: 'app_state_changed', appId: 'control' } as NormalizedEvent)
    await vi.waitFor(() => {
      expect((useStore.getState().apps['control']?.doc as { notifies: unknown[] }).notifies).toHaveLength(0)
    })

    // UI 쪽 변경은 화면 먼저, 저장이 뒤따른다
    await useStore.getState().setAppDoc('control', { notifies: [], metrics: { replies: 1 } })
    expect(mock.appDocs.get('control')).toMatchObject({ metrics: { replies: 1 } })

    // 토글도 같은 창구
    await useStore.getState().setAppEnabled('control', false)
    expect(useStore.getState().apps['control']?.enabled).toBe(false)
    expect(mock.appDisabled.has('control')).toBe(true)
  })

  /*
   * 읽지 못한 문서 위에 쓰지 않는다 (#178). 첫 읽기가 실패하면 레일의 `doc`은 null이고, 줄 하나를
   * 누르면 `{ metrics }`만 든 문서가 host로 가서 업무·감시·알림을 통째로 덮었다.
   */
  it('문서를 아직 못 읽었으면 setAppDoc은 쓰지 않고 다시 읽는다 (#178)', async () => {
    useStore.setState({ apps: {} })
    const mock = new MockPlatform()
    const full = { tasks: [{ id: 't1', title: 'T' }], watches: [{ id: 'w', pattern: 'git push' }], metrics: { inlineReplies: 7 } }
    mock.appDocs.set('control', full)
    await useStore.getState().attach(mock)
    const read = vi.spyOn(mock.apps, 'state').mockRejectedValueOnce(new Error('offline'))
    await useStore.getState().ensureAppState('control')
    expect(useStore.getState().apps['control']).toBeUndefined()

    await useStore.getState().setAppDoc('control', { metrics: { inlineReplies: 1 } })
    expect(mock.appDocs.get('control')).toEqual(full)
    // 버린 대신 다시 읽기를 걸었다 — 다음 쓰기는 진짜 문서 위에서 한다
    await vi.waitFor(() => expect(useStore.getState().apps['control']?.doc).toEqual(full))
    expect(read).toHaveBeenCalledTimes(2)
  })
})

/**
 * 외부 앱의 "바뀌었다" (M4 B-5): 스토어는 (프로젝트, 앱)마다 세기만 한다. 다시 읽는 것은 열린
 * 화면이 자기 상태 도구로 한다. 그래서 내장 앱처럼 apps.state를 부르지 않는다.
 */
describe('외부 앱의 바뀜 신호 (M4 B-5)', () => {
  it('방송이 그 (프로젝트, 앱)의 카운터만 올리고, 내장 앱의 상태를 다시 읽지 않는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const reads = vi.spyOn(mock.apps, 'state')

    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppChanges[externalAppKey(null, 'notes')]).toBe(1))

    expect(useStore.getState().externalAppChanges).toEqual({ 'p1/notes': 2, '_user/notes': 1 })
    // 두 프로젝트의 notes는 다른 앱이다 — 열쇠가 섞이지 않는다
    expect(externalAppKey('p2', 'notes')).not.toBe(externalAppKey('p1', 'notes'))
    expect(reads).not.toHaveBeenCalled()
    expect(useStore.getState().apps['notes']).toBeUndefined()
  })

  it('기록의 신호(M4 D-6)는 기록 판의 카운터만 올린다 — 화면이 듣는 카운터는 그대로다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppRunChanges).toEqual({ 'p1/notes': 1, '_user/notes': 1 }))
    // 읽기 전용 도구의 사슬도 이 신호로 온다 — 화면을 깨우면 #190의 고리가 돌아온다
    expect(useStore.getState().externalAppChanges).toEqual({})
  })

  it('카운터 곁에 그 바뀜을 낸 화면 인스턴스를 둔다 — 화면이 낸 것일 때만, 세션·앱·주인 없음이면 null', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const key = externalAppKey('p1', 'notes')
    const say = (cause?: Record<string, unknown>) =>
      mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', ...(cause ? { cause } : {}) } as NormalizedEvent)
    const seen = () => [useStore.getState().externalAppChanges[key], useStore.getState().externalAppChangedBy[key]]

    say({ kind: 'view', instanceId: 'frame-a' })
    await vi.waitFor(() => expect(seen()).toEqual([1, 'frame-a']))
    say({ kind: 'session', sessionId: 's1' })
    await vi.waitFor(() => expect(seen()).toEqual([2, null]))
    say({ kind: 'view', instanceId: 'frame-b' })
    await vi.waitFor(() => expect(seen()).toEqual([3, 'frame-b']))
    // 주인이 없는 바뀜(앱이 다시 떴다, host가 섞인 것을 모았다) — 모두가 듣는다
    say()
    await vi.waitFor(() => expect(seen()).toEqual([4, null]))
  })
})

/** 발견된 외부 앱 하나 (host의 `apps.list` 한 줄) */
function appInfo(appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo {
  return {
    appId, projectId: 'p1', dir: `/tmp/p1/.centralu/apps/${appId}`, name: `App ${appId}`, version: '0.1.0',
    description: null, home: 'home', trusted: true, status: 'stopped', error: null, warnings: [], ...over,
  }
}

/**
 * 외부 앱 목록 (M4 A-8): 스토어는 host의 `apps.list` 사본을 든다. 방송(`external_apps_changed`)은
 * 무엇이 바뀌었는지 싣지 않으므로 통째로 다시 읽는다. 앱이 뜰 때는 방송이 연달아 오므로(뜨는 중 →
 * 떴다) 읽기가 겹친다. 겹친 읽기가 옛 목록으로 새 목록을 덮으면, 사이드바는 떠 있는 앱을 "뜨는 중"으로
 * 영영 보여 준다.
 */
describe('외부 앱 목록 (M4 A-8)', () => {
  it('처음 붙을 때 읽고, 방송이 올 때마다 다시 읽는다', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('notes')]
    await useStore.getState().attach(mock)
    expect(useStore.getState().externalApps.map((a) => a.appId)).toEqual(['notes'])

    mock.setExternalApps([appInfo('notes', { status: 'running' }), appInfo('timer', { projectId: null })])
    await vi.waitFor(() => expect(useStore.getState().externalApps).toHaveLength(2))
    expect(useStore.getState().externalApps[0]?.status).toBe('running')
  })

  it('읽는 중에 또 방송이 오면 끝난 뒤 한 번 더 읽는다 — 마지막 목록이 남는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.apps, 'list')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // 첫 읽기는 그 순간의 목록(뜨는 중)을 들고 늦게 돌아온다
    list.mockImplementationOnce(async () => {
      const snap = structuredClone(mock.externalAppList)
      await gate
      return snap
    })

    mock.setExternalApps([appInfo('notes', { status: 'starting' })])
    mock.setExternalApps([appInfo('notes', { status: 'running' })])
    release()

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('running'))
  })

  it('다시 붙으면(끊긴 사이의 방송은 다시 오지 않는다) 목록을 다시 읽는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.externalAppList = [appInfo('notes', { status: 'failed', error: 'boom' })]
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('failed'))
  })
})

/**
 * 신뢰 (M4, 결정 3): 등록할 때 **한 번** 묻고, 답하지 않으면 아무것도 보내지 않는다. 이미 신뢰한
 * 프로젝트를 다시 골랐을 때는 묻지 않는다.
 */
describe('프로젝트 신뢰 (M4)', () => {
  it('새로 등록한 프로젝트에 한 번 묻는다 — "나중에"는 아무것도 보내지 않고, "신뢰"는 보내고 화면에 적는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/trust-a')
    expect(useStore.getState().trustAsk).toBe(p.id)

    await useStore.getState().answerTrustAsk(false)
    expect(useStore.getState().trustAsk).toBeNull()
    expect(mock.trustCalls).toEqual([])
    expect(useStore.getState().projects[p.id]?.trusted).toBe(false)

    const q = await useStore.getState().addProject('/tmp/trust-b')
    await useStore.getState().answerTrustAsk(true)
    expect(mock.trustCalls).toEqual([{ projectId: q.id, trusted: true }])
    expect(useStore.getState().projects[q.id]?.trusted).toBe(true)
    expect(useStore.getState().trustAsk).toBeNull()

    // 같은 폴더를 다시 골랐다 — 이미 신뢰했으니 다시 묻지 않는다
    await useStore.getState().addProject('/tmp/trust-b')
    expect(useStore.getState().trustAsk).toBeNull()
  })

  it('돌고 있는 세션이 있을 때만, 바꾼 신뢰는 그 세션이 다시 시작하거나 이어질 때 적용된다고 한 줄로 말한다', async () => {
    const mock = new MockPlatform()
    const busy = await mock.projects.add('/tmp/trust-busy')
    mock.sessions.set('trust-live', sessionInfo('trust-live', { projectId: busy.id, live: true }))
    await useStore.getState().attach(mock)
    const quiet = await useStore.getState().addProject('/tmp/trust-quiet')

    await useStore.getState().setProjectTrusted(quiet.id, true)
    expect(useStore.getState().toast).toBeNull()

    await useStore.getState().setProjectTrusted(busy.id, true)
    expect(useStore.getState().toast).toBe('Running sessions here pick up the new trust when they restart or resume.')
  })

  it('신뢰를 끄면 그 프로젝트의 앱 목록이 방송을 따라 막힌다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/trust-c')
    await useStore.getState().setProjectTrusted(p.id, true)
    mock.setExternalApps([appInfo('notes', { projectId: p.id })])
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('stopped'))

    await useStore.getState().setProjectTrusted(p.id, false)
    expect(useStore.getState().projects[p.id]?.trusted).toBe(false)
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('untrusted'))
  })
})

/**
 * 고정 화면 (M4 B-2): 연 화면은 포커스가 옮겨 가도 산다. 인스턴스는 host가 home을 불러 한 번 만들고,
 * 닫을 때 놓는다. 여는 사이에 닫혔으면 막 연 인스턴스도 놓는다 — 놓지 않으면 아무도 보지 않는 화면이
 * 앱을 영영 붙든다.
 */
describe('고정 화면 (M4 B-2)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    mock.sessions.set('pin-s1', sessionInfo('pin-s1'))
    mock.externalAppList = [appInfo('slider')]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    return mock
  }
  const pinned = () => useStore.getState().pinnedViews

  it('열면 자리가 서고, 세션을 보러 가도 자리는 그대로이며, 다시 열어도 새로 만들지 않는다', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' }, focusedProjectId: 'p1' })
    await useStore.getState().startPinnedView('p1/slider')
    const opened = pinned()[0]
    expect(opened).toMatchObject({ key: 'p1/slider', phase: 'open', instanceId: expect.stringMatching(/^mock-view-/) })

    useStore.getState().focusSession('pin-s1')
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([opened])

    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()).toEqual([opened])
    expect(mock.openedViews).toEqual([{ appId: 'slider', projectId: 'p1' }])
  })

  it('닫으면 인스턴스를 놓고 자리를 지우며, 보던 세션으로 돌아간다', async () => {
    const mock = await live()
    useStore.getState().focusSession('pin-s1')
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const id = pinned()[0]!.instanceId

    useStore.getState().closeApp('p1/slider')
    expect(mock.closedViews).toEqual([id])
    expect(pinned()).toEqual([])
    expect(useStore.getState()).toMatchObject({ view: 'focus', focusedApp: null, focusedSessionId: 'pin-s1' })
  })

  it('여는 사이에 닫았으면 막 연 인스턴스도 놓는다', async () => {
    const mock = await live()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mock.openViewProvider = async () => {
      await gate
      return { instanceId: 'late-view', tool: 'home', resourceUri: 'ui://slider/main', toolInput: {}, toolResult: { content: [] }, runId: 'r' }
    }
    useStore.getState().openApp('p1', 'slider')
    const opening = useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]?.phase).toBe('opening')
    useStore.getState().closeApp('p1/slider')
    release()
    await opening
    expect(mock.closedViews).toEqual(['late-view'])
    expect(pinned()).toEqual([])
  })

  it('Restart는 옛 인스턴스를 놓고, host가 다시 시작을 마친 **뒤에야** 다시 연다 (B-6)', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const old = pinned()[0]!.instanceId
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(mock.apps, 'restart').mockImplementation(async () => {
      order.push('restart:begin')
      await gate
      order.push('restart:end')
    })
    const realOpen = mock.apps.openView
    vi.spyOn(mock.apps, 'openView').mockImplementation(async (appId, projectId) => {
      order.push('open')
      return realOpen(appId, projectId)
    })

    const restarting = useStore.getState().restartApp('p1/slider')
    expect(mock.closedViews).toEqual([old])
    // 화면의 효과가 지금 열려고 해도(열 수 있는 앱이다) 열리지 않는다 — restart가 막 띄운 앱을 내린다
    await useStore.getState().startPinnedView('p1/slider')
    release()
    await restarting
    expect(pinned()[0]?.phase).toBe('idle')
    await useStore.getState().startPinnedView('p1/slider')
    expect(order).toEqual(['restart:begin', 'restart:end', 'open'])
    expect(pinned()[0]).toMatchObject({ phase: 'open', instanceId: expect.not.stringMatching(old!) })
  })

  it('보던 고정 화면이 되살아난다 — 목록에 없는 앱이면 포커스 뷰에 남는다', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider')]
    mock.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null })
    await useStore.getState().attach(mock)
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } })
    expect(pinned().map((p) => p.key)).toEqual(['p1/slider'])

    const gone = new MockPlatform()
    gone.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null, view: 'focus' })
    await useStore.getState().attach(gone)
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([])
  })
})

/**
 * 프로젝트의 기본 모델은 **도구의 것**이다 (#107).
 *
 * 실사고: `default_tool=codex`인 프로젝트가 `default_model=opus[1m]`을 들고 있었고,
 * 거기서 태어난 codex 세션은 매 턴 `400 invalid_request_error`로 죽었다. 인수인계는
 * 도구가 바뀔 때 일부러 모델을 비웠는데(`sameTool ? … : undefined`), 그 아래에서
 * 프로젝트 기본값이 다시 채웠다 — 가드가 위임한 층에게 무너진 모양이다.
 */
describe('프로젝트 기본 모델은 도구를 따라간다 (#107)', () => {
  const withDefaults = async (mock: MockPlatform, path: string, defaults: Record<string, { model: string | null; effort: string | null }>) => {
    const proj = await mock.projects.add(path)
    proj.defaultModels = defaults
    proj.defaultTool = 'claude'
    return proj
  }

  it('도구가 다르면 그 도구의 기억만 온다 — 없으면 아무것도 보내지 않는다', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-1', { claude: { model: 'opus', effort: 'high' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.tool).toBe('codex')
    expect(mock.lastCreateParams?.model).toBeUndefined()
    expect(mock.lastCreateParams?.effort).toBeUndefined()

    // 같은 도구에는 그대로 온다 — 기억하는 기능 자체는 살아 있어야 한다
    await useStore.getState().createSession(proj.id, { tool: 'claude' })
    expect(mock.lastCreateParams?.model).toBe('opus')
    expect(mock.lastCreateParams?.effort).toBe('high')
  })

  /*
   * 도구별로 적어 두는 것만으로는 부족하다: 모델은 은퇴한다. 어제 고른 이름이 오늘
   * 목록에 없으면 그대로 보내는 쪽이 세션을 죽인다 — agents.models가 진실이다.
   */
  it('그 도구가 더는 받지 않는 모델은 버린다', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-2', { codex: { model: 'gpt-5-retired', effort: 'high' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.model).toBeUndefined()
    // 강도는 모델의 손잡이라 함께 버린다 — 어느 모델의 것인지 모르는 high가 남으면 안 된다
    expect(mock.lastCreateParams?.effort).toBeUndefined()
  })

  it('아직 목록에 있는 모델은 그대로 간다', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-3', { codex: { model: 'gpt-5.6-terra', effort: 'medium' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.model).toBe('gpt-5.6-terra')
    expect(mock.lastCreateParams?.effort).toBe('medium')
  })
})

describe('인수인계하고 새로 시작', () => {
  it('글을 받아 새 세션을 만들고 이름을 물려주고 원본까지 지운다', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho1')
    mock.sessions.set('ho-s1', sessionInfo('ho-s1', { projectId: proj.id, name: '메아', model: 'gpt-5.6', tool: 'codex' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s1')
    // 인수인계 요청은 숨기지 않는다 — 세션의 보통 메시지로 들어간다
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s1'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    // 죽는 세션이 글을 **파일로** 쓴다 (대화에서 긁지 않는다 — 메아 실측의 교훈)
    mockNote(mock, 'ho-s1', '후계자에게: 상태 요약')
    mock.emit({ type: 'message_delta', sessionId: 'ho-s1', role: 'assistant', text: '파일에 남겼습니다.' } as NormalizedEvent)
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s1', state: 'waiting_input' } as NormalizedEvent)
    await done

    /*
     * 새 세션의 첫 메시지는 **노트가 아니라 노트의 자리**다 (#102). 미리보기는 실리되
     * 원문은 안 실린다 — 길이가 제약이 아니라는 프롬프트의 약속은 파일에서만 참이다.
     */
    expect(mock.lastCreateParams?.initialPrompt).toContain(handoffFile('ho-s1'))
    expect(mock.lastCreateParams?.initialPrompt).toContain('후계자에게: 상태 요약') // 미리보기
    // 원문은 기록으로 간다 — 전임자가 사라지면 다시 만들 수 없는 유일한 재료다
    // id도 함께 간다 (#106) — host의 청소가 이 노트에 아직 주인이 있음을 아는 근거다
    expect(mock.lastCreateParams?.handoff).toEqual({ from: '메아', note: '후계자에게: 상태 요약', fromSessionId: 'ho-s1' })
    expect(mock.lastCreateParams?.tool).toBe('codex')
    expect(mock.lastCreateParams?.model).toBe('gpt-5.6')
    const heir = [...mock.sessions.values()].find((r) => r.name === '메아')
    expect(heir).toBeDefined()
    expect(heir!.id).not.toBe('ho-s1')
    // 화면의 요약도 즉시 물려받은 설정을 보인다 — DB에만 있고 메뉴는 Default면 "안 넘어간 것"으로 읽힌다 (도그푸딩)
    expect(useStore.getState().sessions[heir!.id]).toMatchObject({ model: 'gpt-5.6', effort: null })
    // 기존 세션은 원본까지 정말로 지워졌다
    expect(mock.sessions.has('ho-s1')).toBe(false)
    expect(mock.externallyDeleted).toContain('ho-s1')
    // 화면은 새 세션을 본다
    expect(useStore.getState().focusedSessionId).toBe(heir!.id)
  })

  it('그리드 자리를 물려준다 — 후임자가 같은 인덱스에 서고, 순서는 밀리지 않는다', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho7')
    mock.sessions.set('ho-g1', sessionInfo('ho-g1', { projectId: proj.id }))
    mock.sessions.set('ho-g2', sessionInfo('ho-g2', { projectId: proj.id, name: '한가운데' }))
    mock.sessions.set('ho-g3', sessionInfo('ho-g3', { projectId: proj.id }))
    await mock.agents.setGridView(['ho-g1', 'ho-g2', 'ho-g3'])
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-g2')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-g2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-g2', '이어서 하세요')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-g2' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-g2', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === '한가운데' && r.id !== 'ho-g2')!
    // 가운데 칸이 그대로 후임자다 — 칸이 사라졌다 다시 생기면 배치가 흐트러진다 (도그푸딩)
    expect(useStore.getState().gridPanels).toEqual(['ho-g1', heir.id, 'ho-g3'])
    expect(useStore.getState().focusedSessionId).toBe(heir.id)
  })

  /*
   * 기록 모드 (#78): 서비스가 중단된 에이전트에게 노트를 부탁하는 것은 응답 불능인
   * 상대에게 유언장을 부탁하는 것이다 — host가 저장소 원문으로 기록을 만들고,
   * 죽은 세션에게는 **아무것도 묻지 않는다**.
   */
  it('기록 모드는 죽은 세션에게 아무것도 묻지 않고, 원본은 기본으로 남긴다 (#78)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-rec')
    mock.sessions.set('ho-r1', sessionInfo('ho-r1', { projectId: proj.id, name: '죽은 메아', tool: 'codex', state: 'error' }))
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-r1', { mode: 'record', tool: 'claude' })

    // 죽은 세션으로 나간 메시지가 없다 — 이 모드의 존재 이유
    expect((useStore.getState().chat['ho-r1'] ?? []).some((i) => i.kind === 'user')).toBe(false)
    // 기록도 **같은 경로**로 모인다 (#102) — 생산자만 다르고 후임자가 받는 말은 같다
    expect(mock.fsState.files[handoffFile('ho-r1')]).toContain('Handoff Record')
    expect(mock.lastCreateParams?.initialPrompt).toContain(handoffFile('ho-r1'))
    expect(mock.lastCreateParams?.initialPrompt).toContain('Handoff Record') // 미리보기
    expect(mock.lastCreateParams?.handoff?.note).toContain('Handoff Record')
    expect(mock.lastCreateParams?.tool).toBe('claude')
    // 원본은 남는다 — record 모드의 기본은 보존이다 (후임자가 확인될 때까지)
    expect(mock.sessions.has('ho-r1')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-r1')
    // 이름은 물려받는다
    expect([...mock.sessions.values()].some((r) => r.name === '죽은 메아' && r.id !== 'ho-r1')).toBe(true)
  })

  it('세션이 글을 쓰다 에러가 나면 아무것도 지우지 않는다 — 파괴는 성공 뒤에만', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho2')
    mock.sessions.set('ho-s2', sessionInfo('ho-s2', { projectId: proj.id, name: '메아2' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s2')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mock.emit({ type: 'state_change', sessionId: 'ho-s2', state: 'error' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s2')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-s2')
    expect(useStore.getState().toast).toMatch(/Handoff failed/)
  })

  it('다른 에이전트에게 넘기면 도구별 설정은 물려주지 않는다', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho5')
    mock.sessions.set('ho-s5', sessionInfo('ho-s5', { projectId: proj.id, name: '갈아타기', tool: 'codex', model: 'gpt-5.6', effort: 'high' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s5', { tool: 'claude' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s5'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s5', '노트')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s5' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s5', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.lastCreateParams?.tool).toBe('claude')
    // codex의 모델·강도를 claude에 넘기면 생성부터 죽는다 — 물려주지 않는다
    expect(mock.lastCreateParams?.model).toBeUndefined()
    expect(mock.lastCreateParams?.effort).toBeUndefined()
    expect(mock.sessions.has('ho-s5')).toBe(false) // 삭제 기본값은 그대로 켜져 있다
  })

  it('삭제를 끄면 기존 세션이 남는다 — 갈아타기가 아니라 분기', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho6')
    mock.sessions.set('ho-s6', sessionInfo('ho-s6', { projectId: proj.id, name: '분기' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s6', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s6'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s6', '분기 노트')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s6' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s6', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s6')).toBe(true) // 기존 세션이 산다
    expect(mock.externallyDeleted).not.toContain('ho-s6')
    expect([...mock.sessions.values()].filter((r) => r.name === '분기').length).toBe(2)
  })

  it('돌던 턴의 보고가 글 머리에 섞이지 않는다 — 턴이 끝난 뒤에 부탁한다 (메아 실측)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho4')
    mock.sessions.set('ho-s4', sessionInfo('ho-s4', { projectId: proj.id, name: '메아4', state: 'working' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s4')
    // 돌던 턴이 아직 안 끝났다 — 프롬프트는 나가지 않고, 그 턴의 보고만 흘러든다
    await new Promise((r) => setTimeout(r, 700))
    mock.emit({ type: 'message_delta', sessionId: 'ho-s4', role: 'assistant', text: '적용했습니다: 직전 작업 보고' } as NormalizedEvent)
    expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(false)

    // 턴이 끝나면 그제야 부탁한다
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s4', '# 1. 프로젝트와 목표')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await done

    // 직전 턴의 보고는 글에 없다 — "적용했습니다"로 시작하는 인수인계가 바로 그 사고였다
    expect(mock.lastCreateParams?.handoff?.note).toBe('# 1. 프로젝트와 목표')
    expect(mock.lastCreateParams?.initialPrompt).not.toContain('적용했습니다')
  })

  /*
   * #102: 전임자에게는 "파일이니 길이는 제약이 아니다"라고 말해 놓고 그 결과를 한 통의
   * 채팅 메시지로 배달했다 — 길수록 충실한 노트가 되고, 충실할수록 후임자가 도착하자마자
   * 죽었다 (실측: 긴 세션을 codex에 넘기자 에러). 첫 메시지는 이제 노트의 **자리**를
   * 가리키므로, 노트가 아무리 길어져도 첫 메시지는 자라지 않는다.
   */
  it('긴 노트도 거대한 첫 메시지가 되지 않는다 — 넘기는 것은 내용이 아니라 경로다 (#102)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-big')
    mock.sessions.set('ho-big', sessionInfo('ho-big', { projectId: proj.id, name: '오래 산 세션' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-big')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-big'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const huge = '# 1. 프로젝트와 목표\n' + '이 세션은 아주 길었고 노트도 그만큼 길다. '.repeat(20_000)
    mockNote(mock, 'ho-big', huge)
    mock.emit({ type: 'turn_complete', sessionId: 'ho-big' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-big', state: 'waiting_input' } as NormalizedEvent)
    await done

    const prompt = mock.lastCreateParams!.initialPrompt!
    // 노트는 80만 자가 넘는데 첫 메시지는 한 화면이다 — 이 격차가 곧 이 고침이다
    expect(huge.length).toBeGreaterThan(500_000)
    expect(prompt.length).toBeLessThan(2_000)
    expect(prompt).toContain(handoffFile('ho-big'))
    expect(prompt).toContain('# 1. 프로젝트와 목표') // 미리보기는 있다
    // 그리고 노트는 유실되지 않는다 — 파일보다 오래 사는 곳(기록)에 원문이 있다
    const kept = mock.lastCreateParams?.handoff?.note ?? ''
    expect(kept).toHaveLength(huge.trim().length)
    expect(kept.endsWith('노트도 그만큼 길다.')).toBe(true)
  })

  /*
   * #106: 청소는 턴 경계에 매달려 있었다 — 후임자의 **첫 턴이 끝나는 순간**. 그 조건은
   * 턴이 성공했는지도, 노트를 읽었는지도 묻지 않는다. 실사고에서 첫 턴은 1초도 안 돼
   * 400으로 죽었고 디렉토리는 3분 만에 비었다. 후임자는 없는 파일의 경로를 들고 있었고,
   * 그 글은 쓴 세션이 방금 대체됐으므로 다시 만들 수 없다.
   */
  it('첫 턴이 실패해도 노트는 남는다 — 턴 경계에서는 아무것도 치우지 않는다 (#106)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-sweep')
    mock.sessions.set('ho-sw', sessionInfo('ho-sw', { projectId: proj.id, name: '치우기' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-sw', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-sw'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const notePath = mockNote(mock, 'ho-sw', '읽히기 전에 사라지면 안 되는 글')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-sw' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-sw', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === '치우기' && r.id !== 'ho-sw')!
    // 첫 턴이 400으로 죽는다 — 예전에는 이 자리에서 노트가 사라졌다
    mock.emit({
      type: 'error', sessionId: heir.id,
      error: { code: 'internal', message: "The 'opus[1m]' model is not supported", retryable: true },
    } as NormalizedEvent)
    // 성공한 턴이 와도 마찬가지다 — 근거는 "읽었는가"인데 그것은 관찰할 수 없다
    mock.emit({ type: 'turn_complete', sessionId: heir.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))

    expect(mock.trashed).not.toContain(notePath)
    expect(mock.fsState.files[notePath]).toBe('읽히기 전에 사라지면 안 되는 글')
  })

  /*
   * #104: 한 프로젝트에서 세션 여럿을 동시에 돌리는 것이 이 앱의 존재 이유인데, 인수인계
   * 파일은 프로젝트마다 하나였다. 그래서 동시에 도는 두 인수인계는 (1) 같은 자리에 써서
   * 늦게 쓴 쪽이 이겼고 — 기다리던 쪽은 모양이 맞고 내용이 틀린 노트를 조용히 받았다 —
   * (2) 먼저 첫 턴을 마친 후임자의 청소가 남의 글을 치웠다.
   */
  it('같은 프로젝트의 두 인수인계가 서로의 글을 덮지도 치우지도 않는다 (#104)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-pair')
    mock.sessions.set('ho-a', sessionInfo('ho-a', { projectId: proj.id, name: '왼쪽' }))
    mock.sessions.set('ho-b', sessionInfo('ho-b', { projectId: proj.id, name: '오른쪽' }))
    await useStore.getState().attach(mock)

    // 둘을 나란히 건다 — 순서대로 하면 이 버그는 아예 나타나지 않는다
    const a = useStore.getState().handoffSession('ho-a', { deleteOld: false })
    const b = useStore.getState().handoffSession('ho-b', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-a'] ?? []).some((i) => i.kind === 'user')).toBe(true)
      expect((useStore.getState().chat['ho-b'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const pathA = mockNote(mock, 'ho-a', '왼쪽의 노트')
    const pathB = mockNote(mock, 'ho-b', '오른쪽의 노트')
    for (const id of ['ho-a', 'ho-b']) {
      mock.emit({ type: 'turn_complete', sessionId: id } as NormalizedEvent)
      mock.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' } as NormalizedEvent)
    }
    await Promise.all([a, b])

    // 각자 제 전임자의 글을 받았다 — 이름이 하나였을 때는 둘 다 나중에 쓰인 한 글을 받았다
    const paramsOf = (from: string) => mock.createParamsLog.find((x) => x.handoff?.from === from)
    expect(paramsOf('왼쪽')?.handoff?.note).toBe('왼쪽의 노트')
    expect(paramsOf('오른쪽')?.handoff?.note).toBe('오른쪽의 노트')
    expect(paramsOf('왼쪽')?.initialPrompt).toContain(pathA)
    expect(paramsOf('오른쪽')?.initialPrompt).toContain(pathB)

    /*
     * 한쪽 후임자의 첫 턴이 끝나도 **아무 글도 사라지지 않는다** (#106). 청소가 턴에
     * 매달려 있던 동안에는 먼저 끝난 쪽이 남의 글을 치웠고(#104가 고친 것), 이제는
     * 자기 전임자의 글조차 여기서 치우지 않는다 — 읽었는지 알 방법이 없어서다.
     */
    const heirA = [...mock.sessions.values()].find((r) => r.name === '왼쪽' && r.id !== 'ho-a')!
    mock.emit({ type: 'turn_complete', sessionId: heirA.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))
    expect(mock.trashed).not.toContain(pathA)
    expect(mock.trashed).not.toContain(pathB)
    expect(mock.fsState.files[pathA]).toBe('왼쪽의 노트')
    expect(mock.fsState.files[pathB]).toBe('오른쪽의 노트')
  })

  /*
   * #104: 대기 루프는 "파일이 있고 비어 있지 않다"만 본다 — 그것이 **방금 부탁해서 놓인
   * 글**인지는 묻지 않는다. 그래서 지난 인수인계가 실패하고 남긴 파일은 다음 인수인계에서
   * 갓 쓴 노트로 배달됐다. 동시성도 필요 없고, 조용하며, 재시작을 견디고, 내용까지
   * 그럴듯하다. 이제는 묻기 전에 그 자리를 비우므로 남은 글이 배달될 자리가 없다.
   */
  it('지난 실패가 남긴 파일을 갓 쓴 노트로 착각하지 않는다 (#104)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-stale')
    mock.sessions.set('ho-st', sessionInfo('ho-st', { projectId: proj.id, name: '오래된 자리' }))
    await useStore.getState().attach(mock)

    // 지난 번에 실패한 인수인계가 남기고 간 글이 이미 그 자리에 있다
    const notePath = mockNote(mock, 'ho-st', '지난 달에 실패한 인수인계가 남긴 옛 노트')

    const done = useStore.getState().handoffSession('ho-st', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-st'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    // 전임자가 턴을 끝냈는데 아무것도 쓰지 않았다 — 옛 글이 배달되던 바로 그 순간이다
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 1_500))
    expect(mock.createParamsLog).toEqual([]) // 후임자는 태어나지 않는다 — 아직 받을 글이 없다
    expect(mock.fsState.files[notePath]).toBeUndefined() // 자리는 부탁하기 전에 비워졌다

    // 진짜 노트가 놓이면 그제야 넘어간다
    mockNote(mock, 'ho-st', '방금 쓴 새 노트')
    await done
    expect(mock.lastCreateParams?.handoff?.note).toBe('방금 쓴 새 노트')
  })

  it('워크트리 세션은 거른다 — 워크트리의 수명이 세션에 묶여 있다', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho3')
    mock.sessions.set(
      'ho-s3',
      sessionInfo('ho-s3', { projectId: proj.id, worktree: { path: '/tmp/wt', branch: 'centralu/x' } }),
    )
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-s3')

    expect(mock.sessions.has('ho-s3')).toBe(true)
    expect((useStore.getState().chat['ho-s3'] ?? []).length).toBe(0)
    expect(useStore.getState().toast).toMatch(/Worktree sessions/)
  })
})

/** MCP 서버 제안 카드 (b안) — 제안 이벤트가 목록을 새로 읽고, 승인 클릭이 host로 간다 */
describe('MCP 서버 제안', () => {
  it('propose_mcp_server 도구 호출이 오면 제안 목록을 다시 읽는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s1', sessionInfo('mcp-s1'))
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: '브라우저' })

    mock.emit({
      type: 'tool_call', sessionId: 'mcp-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_mcp_server', title: 'playwright', readOnly: true, paths: [] },
    } as NormalizedEvent)

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: '브라우저' },
      ])
    })
  })

  it('승인 클릭이 host로 전달되고 목록이 비워진다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    await useStore.getState().refreshMcpProposals()

    await useStore.getState().resolveMcpProposal('playwright', true)

    expect(mock.mcpApproved).toContain('playwright')
    expect(useStore.getState().mcpProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Installing playwright/)
  })
})

/** 스킬 제안 (#71) — MCP 제안과 같은 레일: 이벤트가 목록을 깨우고, 승인이 host로 간다 */
describe('스킬 제안', () => {
  it('propose_skill 도구 호출이 오면 제안 목록을 다시 읽고, 승인이 저장으로 이어진다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('sk-s1', sessionInfo('sk-s1'))
    await useStore.getState().attach(mock)
    mock.skillProposalList.push({ name: 'weekly-report', content: '금요일마다 요약', why: '반복 요청' })

    mock.emit({
      type: 'tool_call', sessionId: 'sk-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_skill', title: 'weekly-report', readOnly: true, paths: [] },
    } as NormalizedEvent)
    await vi.waitFor(() => {
      expect(useStore.getState().skillProposals).toEqual([
        { name: 'weekly-report', content: '금요일마다 요약', why: '반복 요청' },
      ])
    })

    await useStore.getState().resolveSkillProposal('weekly-report', true)
    expect(mock.skillList).toEqual([{ name: 'weekly-report', content: '금요일마다 요약' }])
    expect(useStore.getState().skillProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Skill saved/)
  })
})

describe('명령 실행 장부 (#60 → 터미널 패널 이관)', () => {
  it('runCommand는 프로젝트·명령 아래 실행을 적고, exit 이벤트가 결말을 적는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd')

    await useStore.getState().runCommand(p.id, 'pnpm dev')
    let r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(true)

    // 데브 서버가 죽었다 — runId가 terminalId 자리를 타고 exit가 온다
    mock.exitCommand(p.id, 'pnpm dev', 1)
    r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('셸 터미널의 exit는 장부를 건드리지 않는다 — 아는 runId만 결말로 받는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd2')
    await useStore.getState().runCommand(p.id, 'pnpm dev')

    // 모르는 terminalId (셸 터미널이 죽은 상황)
    mock.emitTerminalExit('shell-1', 0)
    expect(useStore.getState().commandRuns[p.id]!['pnpm dev']!.running).toBe(true)

    // 같은 방사구로 **아는** runId가 오면 결말이 적힌다 — 위 무시가 공허하지 않다는 증명
    mock.emitTerminalExit(useStore.getState().commandRuns[p.id]!['pnpm dev']!.runId, 0)
    expect(useStore.getState().commandRuns[p.id]!['pnpm dev']!.running).toBe(false)
  })

  it('loadCommandRuns는 host 장부를 투영한다 — UI가 리로드돼도 도는 명령이 보인다', async () => {
    const mock = new MockPlatform()
    // UI(스토어)가 모르는 사이 host에서 이미 돌고 있던 실행
    const p0 = await mock.projects.add('/tmp/cmd3')
    await mock.commands.run(p0.id, 'pnpm dev', 80, 24)

    await useStore.getState().attach(mock)
    expect(useStore.getState().commandRuns[p0.id]).toBeUndefined()
    await useStore.getState().loadCommandRuns(p0.id)
    expect(useStore.getState().commandRuns[p0.id]!['pnpm dev']!.running).toBe(true)
  })

  it('stopCommand의 결말도 exit 이벤트로 돌아온다 (130 = SIGINT 관례)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd4')
    await useStore.getState().runCommand(p.id, 'pnpm dev')

    await useStore.getState().stopCommand(p.id, 'pnpm dev')
    const r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(false)
    expect(r.exitCode).toBe(130)
  })
})


/**
 * 기록을 읽기 전에 대화 아닌 이벤트가 먼저 오면 (도그푸딩 2026-09-25).
 *
 * 앱을 다시 켜자 11,550줄짜리 세션이 통째로 비어 보였다. host가 세션을 재개하며 보낸
 * 상태·사용량 이벤트가, 사용자가 그 세션을 누르기 전에 `chat[id] = []`를 만들었고,
 * 포커스는 그 빈 배열을 "이미 읽었다"로 읽어 기록을 부르지 않았다. 오류도 없었다.
 */
describe('기록보다 먼저 온 이벤트', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `줄 ${i + 1}` }, ts: i + 1,
    }))
  const quiet = [
    ['state_change', { type: 'state_change', state: 'idle' }],
    ['context_usage', { type: 'context_usage', used: 111693, window: 1000000, exactness: 'exact' }],
  ] as const

  it.each(quiet)('%s가 먼저 와도, 그 세션을 누르면 기록이 보인다', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('b', sessionInfo('b'))
    mock.messages.set('b', many('b', 50))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    mock.emit({ sessionId: 'b', ...ev } as unknown as NormalizedEvent)
    useStore.getState().focusSession('b')

    await vi.waitFor(() => expect(useStore.getState().chat['b']).toHaveLength(50))
    expect(useStore.getState().history['b']?.more).toBe(false)
  })

  it('기록을 읽는 사이에 대화 아닌 이벤트가 끼어도 기록을 버리지 않는다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('c', sessionInfo('c'))
    mock.messages.set('c', many('c', 30))
    await useStore.getState().attach(mock)

    // 기록 요청이 나간 뒤, 응답이 오기 전에 이벤트가 도착하도록 응답을 붙잡는다
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }

    const loading = useStore.getState().loadHistory('c')
    mock.emit({ sessionId: 'c', type: 'state_change', state: 'idle' } as unknown as NormalizedEvent)
    release()
    await loading

    expect(useStore.getState().chat['c']).toHaveLength(30)
  })

  /*
   * 근본 고침은 이쪽이다: 대화가 아닌 이벤트는 자리를 만들지 않는다. `chat[id]`가 없다는
   * 것은 저장소 전체에서 "아직 안 읽었다"로 쓰인다(포커스, 세션 생성). 아래 두 방어선이
   * 로딩을 막아 주므로, 이 약속은 따로 걸지 않으면 깨져도 아무도 모른다.
   */
  it.each(quiet)('%s는 아직 안 읽은 세션에 빈 자리를 만들지 않는다', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('g', sessionInfo('g'))
    await useStore.getState().attach(mock)

    mock.emit({ sessionId: 'g', ...ev } as unknown as NormalizedEvent)

    expect(useStore.getState().chat['g']).toBeUndefined()
    // 상태는 그대로 반영된다 — 자리를 안 만든다고 이벤트를 버리는 것이 아니다
    expect(useStore.getState().sessions['g']).toBeDefined()
  })

  /*
   * 아래 둘은 이벤트와 **무관하게** 규칙 자체를 건다: 빈 자리는 읽지 않은 것과 같다.
   * 빈 배열을 만드는 길은 이벤트만이 아니다(낙관적으로 그린 줄을 되돌리는 filter도
   * 비울 수 있다). 위 시험들은 이벤트 쪽 고침이 막아 버려서 이 두 방어선을 보지 못한다.
   */
  it('빈 자리에 커서도 없는 세션을 누르면 기록을 부른다 — 빈 자리가 어디서 왔든', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('e', sessionInfo('e'))
    mock.messages.set('e', many('e', 20))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    useStore.setState((s) => ({ chat: { ...s.chat, e: [] } }))
    useStore.getState().focusSession('e')

    await vi.waitFor(() => expect(useStore.getState().chat['e']).toHaveLength(20))
  })

  it('기록이 도착했을 때 자리가 비어 있으면 기록으로 채운다 — 빈 자리가 어디서 왔든', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('f', sessionInfo('f'))
    mock.messages.set('f', many('f', 25))
    await useStore.getState().attach(mock)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }
    const loading = useStore.getState().loadHistory('f')
    useStore.setState((s) => ({ chat: { ...s.chat, f: [] } }))
    release()
    await loading

    expect(useStore.getState().chat['f']).toHaveLength(25)
  })

  it('화면에 줄이 이미 있어도 기록과 합칠 뿐 지우지 않는다 (09-09의 약속, #79)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('d', sessionInfo('d'))
    mock.messages.set('d', many('d', 40))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    // 스트리밍 중인 말이 먼저 왔다 — 이건 지우면 안 되는 줄이다
    mock.emit(delta('d', '지금 쓰는 중'))
    useStore.getState().focusSession('d')
    await new Promise((r) => setTimeout(r, 20))

    const chat = useStore.getState().chat['d']!
    expect(chat.map((i) => (i as { text?: string }).text)).toContain('지금 쓰는 중')
    expect(useStore.getState().history['d']).toBeDefined()
  })
})

/**
 * 대화 안 앱 화면의 자리 복원 (M4 B-1). 기록에는 본문 없이 "이 카드 아래에 어느 앱의 화면이 섰다(또는
 * 거절됐다)"만 있다 — 다시 연 UI는 그 카드에 자리표시를 세운다. 다시 열 수 있는지는 host에 묻기 전까지
 * 모른다(kept: false). 기록의 앱 화면 줄은 대화의 줄(ChatItem)이 되지 않는다.
 */
describe('inlineViewsFromHistory — 지난 카드의 앱 화면 자리', () => {
  const row = (seq: number, payload: Record<string, unknown>) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'app_view' as const, payload, ts: 0 })
  const call = (seq: number, callId: string) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'tool_call' as const, payload: { type: 'tool_call', callId, summary: { tool: 'mcp__app-viewer__show', title: 'show', readOnly: false, paths: [] } }, ts: 0 })

  it('열림은 다시 열 수 있는지 모르는 자리표시로, 거절은 이유만 있는 자리표시로 — 같은 카드면 나중 줄이 이긴다', () => {
    const msgs = [
      call(1, 'c-open'),
      row(2, { type: 'app_view', callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      call(3, 'c-spoof'),
      row(4, { type: 'app_view', callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' }),
      call(5, 'c-late'),
      row(6, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      row(7, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'rejected', reason: "This call's result points at ui://other/main" }),
      // 모양이 틀린 줄은 버린다
      row(8, { type: 'app_view', phase: 'open' }),
    ]
    expect(inlineViewsFromHistory(msgs)).toEqual({
      'c-open': { callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0 },
      'c-spoof': {
        callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: 'This app does not serve ui://other/main', reason: 'This app does not serve ui://other/main',
      },
      'c-late': {
        callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: "This call's result points at ui://other/main", reason: "This call's result points at ui://other/main",
      },
    })
    // 대화의 줄은 카드 셋뿐이다 — 앱 화면의 기록은 줄이 되지 않는다
    expect(messagesToChat(msgs).map((i) => i.kind)).toEqual(['tool', 'tool', 'tool'])
  })
})

/**
 * 새 코드를 따라 다시 연다 (M4 C-4). 판정은 목록의 지문(`codeStamp`) 하나다 — 화면을 열 때 떠 있던 코드와 달라지면 옛 HTML
 * 이다. 열 때 몰랐으면(앱이 그 순간 처음 떴다) 처음 알게 된 값을 받기만 한다: 그것을 변화로 읽으면 막 연 화면을 한 번 더
 * 연다.
 */
describe('새 코드를 따라 다시 연다 (M4 C-4)', () => {
  const pinned = () => useStore.getState().pinnedViews

  it('열 때 지문을 모르면 받기만 하고, 그 뒤 지문이 바뀌면 teardown 뒤 같은 자리를 새로 연다', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider', { status: 'running' })]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const first = pinned()[0]!
    expect(first).toMatchObject({ phase: 'open', codeStamp: null })
    const teardown = vi.fn(async () => 'answered')
    registerPinnedFrame('p1/slider', { teardown })

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'aaaa' })])
    await vi.waitFor(() => expect(pinned()[0]?.codeStamp).toBe('aaaa'))
    expect(teardown).not.toHaveBeenCalled()
    expect(mock.closedViews).toEqual([])

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'bbbb' })])
    await vi.waitFor(() => expect(pinned()[0]?.phase).toBe('idle'))
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(mock.closedViews).toEqual([first.instanceId])
    expect(pinned()).toEqual([expect.objectContaining({ key: 'p1/slider', instanceId: null, codeStamp: null, updatedAt: expect.any(Number) })])
    expect(useStore.getState().focusedApp).toEqual({ projectId: 'p1', appId: 'slider' })
    // 화면이 다시 열면 새 지문을 받는다 — 그 뒤로는 같은 지문이라 조용하다
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]).toMatchObject({ phase: 'open', codeStamp: 'bbbb', updatedAt: expect.any(Number) })
    // 사람이 다시 시작한 화면에는 "Updated"가 서지 않는다 — 그 말은 새 코드로 다시 연 화면의 것이다
    await useStore.getState().restartApp('p1/slider')
    expect(pinned()[0]).toMatchObject({ updatedAt: null, codeStamp: null })
  })
})

/**
 * 기다리는 사이에 지워진 세션 (#163). RPC를 기다린 뒤의 set이 `{ ...s.sessions[id]!, … }`로 펼쳐서, 그 사이에
 * session_deleted가 오면 필드가 거의 없는 행을 되살렸다 — 모든 세션을 도는 코드가 그 행에서 깨졌다.
 */
describe('기다리는 사이에 지워진 세션은 되살아나지 않는다 (#163)', () => {
  function stalled<T>() {
    let resolve!: (v: T) => void
    const p = new Promise<T>((r) => (resolve = r))
    return { p, resolve }
  }

  it('깨우는 사이에 지워지면 깨우기의 답이 행을 다시 만들지 않는다', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const wake = stalled<{ session: SessionInfo; resumed: boolean; reason?: string }>()
    vi.spyOn(platform.agents, 'resumeSession').mockReturnValue(wake.p as never)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    const waking = useStore.getState().wake(s.id)
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: s.id } as NormalizedEvent)
    wake.resolve({ session: s, resumed: false, reason: 'The session was deleted while waking' })
    await waking

    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    expect(useStore.getState().wakeError[s.id]).toBeUndefined()
  })

  it('읽음 표시를 기다리는 사이에 지워져도 던지지 않고 행을 만들지 않는다', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const mark = stalled<void>()
    vi.spyOn(platform.agents, 'markRead').mockReturnValue(mark.p as never)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, lastSeq: 5, lastReadSeq: 0 } as never } })

    const marking = useStore.getState().markRead(s.id)
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: s.id } as NormalizedEvent)
    mark.resolve()
    await marking

    expect(useStore.getState().sessions[s.id]).toBeUndefined()
  })

  it('지운 세션의 알림 카드와 세션별 짐도 함께 사라진다', () => {
    const id = 'del-163'
    useStore.setState({
      sessions: { [id]: { ...sessionInfo(id) } as never },
      notices: [{ sessionId: id, kind: 'done', name: id, at: 1 }, { sessionId: 'other', kind: 'done', name: 'other', at: 2 }],
      history: { [id]: { oldestSeq: 1, more: false, loading: false } },
      drafts: { [id]: { text: '쓰던 글' } as never },
      stickToBottom: { [id]: true },
      wakeError: { [id]: 'x' },
      wakeLocked: { [id]: true },
    })
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: id } as NormalizedEvent)

    const st = useStore.getState()
    expect(st.notices.map((n) => n.sessionId)).toEqual(['other'])
    expect([st.history[id], st.drafts[id], st.stickToBottom[id], st.wakeError[id], st.wakeLocked[id]]).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ])
  })
})

/*
 * 설정 변경 토스트는 host가 실제로 한 일을 말한다 (#164). 예전에는 늘 "(from next turn)"이었다.
 */
describe('설정 변경 토스트 (#164)', () => {
  it.each([
    ['after_turn', 'Effort: high (applies when this turn ends)'],
    ['restarted', 'Effort: high (agent restarted)'],
    ['saved', 'Effort: high (from next turn)'],
  ] as const)('%s → %s', async (applied, toast) => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    vi.spyOn(platform.agents, 'updateSettings').mockResolvedValue({ ...s, effort: 'high', applied })
    useStore.setState({ platform, sessions: { [s.id]: { ...s } as never } })

    await useStore.getState().updateSessionSettings(s.id, { effort: 'high' })
    expect(useStore.getState().toast).toBe(toast)
  })
})

/*
 * "항상 허용"의 알림은 실제로 보낸 매처로 (#170). 예전에는 카드가 따로 문구를 지어서, 매처가 없는 종류(`other`)에도
 * "Always allow in this session: other"라고 알렸다 — 아무 규칙도 남지 않았는데.
 */
describe('항상 허용 알림 (#170)', () => {
  async function answerAlways(detail: Record<string, unknown>, scope: 'session' | 'project' = 'session') {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState({
      platform,
      sessions: { [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail } } as never },
    })
    await useStore.getState().respondApproval(s.id, 'r1', 'always', scope)
    return { matcher: spy.mock.calls[0]?.[4], toast: useStore.getState().toast }
  }

  it('파일 편집은 그 경로를 보내고, 그 경로로 알린다', async () => {
    const r = await answerAlways({ kind: 'file_edit', path: '/x/a.ts', diffPreview: '', multi: false }, 'project')
    expect(r.matcher).toBe('/x/a.ts')
    expect(r.toast).toBe('Always allow in this project: /x/a.ts')
  })

  it('매처가 없는 종류는 규칙이 생겼다고 알리지 않는다', async () => {
    const r = await answerAlways({ kind: 'other', raw: 'mcp__x__y {}' })
    expect(r.matcher).toBeUndefined()
    expect(r.toast).not.toContain('Always allow in')
    expect(r.toast).toContain('Allowed once')
  })
})

/*
 * #158: 첫 응답의 결과가 화면에 닿기 전에 같은 카드에 두 번째 입력이 들어오면, 두 번째 응답이 host에서 '사라진 요청'이
 * 되어 방금 실행된 명령을 Denied로 적었다. 한 요청에는 한 번만 보낸다.
 */
describe('승인은 한 요청에 한 번만 보낸다 (#158)', () => {
  async function pendingCard() {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    useStore.setState({
      platform,
      sessions: {
        [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/tmp' } } } as never,
      },
    })
    return { platform, id: s.id }
  }

  it('응답이 돌아오기 전의 두 번째 입력은 보내지 않는다', async () => {
    const { platform, id } = await pendingCard()
    const finish: (() => void)[] = []
    const spy = vi
      .spyOn(platform.agents, 'respondApproval')
      .mockImplementation(() => new Promise<void>((r) => void finish.push(r)))
    const first = useStore.getState().respondApproval(id, 'r1', 'allow')
    const second = useStore.getState().respondApproval(id, 'r1', 'deny')
    finish.forEach((f) => f())
    await Promise.all([first, second])
    expect(spy.mock.calls.map((c) => c[2])).toEqual(['allow'])
  })

  it('카드가 이미 걷힌 요청에는 보내지 않는다', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState((st) => ({ sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, pendingApproval: null } } }))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).not.toHaveBeenCalled()
  })

  it('전송이 실패하면 다시 누를 수 있다', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockRejectedValueOnce(new Error('Connection lost'))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(useStore.getState().toast).toBe('Connection lost')
    spy.mockResolvedValue(undefined as never)
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(useStore.getState().approvalsInFlight).toEqual({})
  })
})
