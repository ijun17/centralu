import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { handoffFile, sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- 런타임 ui는 ports만 알지만, 테스트는 즉석 모킹 대신 MockPlatform을 쓰는 것이 계약이다 (platform/src/mock/index.ts 머리말)
import { MockPlatform } from '@cc/platform/mock'
import { messagesToChat, useStore } from './store.js'

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
    commandRuns: {},
    notifyPolicy: DEFAULT_NOTIFY_POLICY,
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
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('u3-s3', true))
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

  it('이벤트로만 생긴 대화에도 커서를 세운다 — 없으면 위로 갈 길이 없다', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h3', sessionInfo('h3'))
    mock.messages.set('h3', many('h3', 120))
    await useStore.getState().attach(mock)

    // 화면을 열기 전에 이벤트가 먼저 왔다 — chat만 생기고 커서는 없다
    mock.emit({ sessionId: 'h3', type: 'message_delta', role: 'assistant', text: '먼저 온 말' } as never)
    await vi.waitFor(() => expect(useStore.getState().chat['h3']).toBeDefined())
    expect(useStore.getState().history['h3']).toBeUndefined()

    await useStore.getState().focusSession('h3')

    await vi.waitFor(() => expect(useStore.getState().history['h3']?.more).toBe(true))
    const chat = useStore.getState().chat['h3']!
    expect(useStore.getState().history['h3']!.oldestSeq).toBe(chat[0]!.seq)
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
    expect(items).toEqual([{ kind: 'image', seq: 1, mime: 'image/png', data: 'aWJs', path: '/tmp/a.png', note: undefined }])
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
      { kind: 'reasoning', seq: 1, text: '**경로 검토**' },
      { kind: 'assistant', seq: 3, text: '답' },
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
    expect(mock.lastCreateParams?.handoff).toEqual({ from: '메아', note: '후계자에게: 상태 요약' })
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
   * #102: 예전에는 createSession 직후에 파일을 휴지통으로 보냈다 — 후임자가 아직 열지도
   * 않은 파일을 치우는 경주였고, 첫 메시지가 노트 전문이던 동안에만 들키지 않았다.
   */
  it('파일은 후임자의 첫 턴이 끝난 뒤에 치운다 (#102)', async () => {
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
    // 후임자가 아직 아무것도 못 했다 — 파일은 그대로 있어야 한다
    expect(mock.trashed).not.toContain(notePath)

    mock.emit({ type: 'turn_complete', sessionId: heir.id } as NormalizedEvent)
    await vi.waitFor(() => {
      expect(mock.trashed).toContain(notePath)
    })
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

    // 한쪽 후임자의 첫 턴이 끝난다 — 치우는 것은 제 전임자의 파일 하나뿐이다
    const heirA = [...mock.sessions.values()].find((r) => r.name === '왼쪽' && r.id !== 'ho-a')!
    mock.emit({ type: 'turn_complete', sessionId: heirA.id } as NormalizedEvent)
    await vi.waitFor(() => {
      expect(mock.trashed).toContain(pathA)
    })
    expect(mock.trashed).not.toContain(pathB)
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
