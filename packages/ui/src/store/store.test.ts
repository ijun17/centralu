import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- 런타임 ui는 ports만 알지만, 테스트는 즉석 모킹 대신 MockPlatform을 쓰는 것이 계약이다 (platform/src/mock/index.ts 머리말)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'

/**
 * 스토어 회귀 테스트 — 포트는 MockPlatform으로 (즉석 모킹 금지, 계약이 흩어진다).
 * pendingEvents 보관함은 모듈 상태라 테스트 사이에 못 비운다 — 세션 id를 테스트마다 다르게 쓴다.
 */

function sessionInfo(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', tool: 'claude', externalId: null, name: id, autoNamed: true,
    state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, ...sessionLiveDefaults(), ...over,
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
    useStore.getState().setTreeHeight(300)
    await new Promise((r) => setTimeout(r, 0))
    const snap = mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy; treeHeight?: number } | null
    expect(snap?.notifyPolicy).toEqual(policy)
    expect(snap?.treeHeight).toBe(300)
  })

  it('반대로 정책 저장이 레이아웃(treeHeight)을 지우지도 않는다', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setTreeHeight(280)
    await new Promise((r) => setTimeout(r, 0))
    useStore.getState().setNotifyPolicy({ ...DEFAULT_NOTIFY_POLICY })
    await new Promise((r) => setTimeout(r, 0))

    expect((mock.workspaceSnapshot as { treeHeight?: number } | null)?.treeHeight).toBe(280)
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
