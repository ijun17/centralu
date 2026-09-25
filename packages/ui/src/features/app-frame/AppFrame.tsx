import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AppBridge, McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import { APP_VERSION, type AppId } from '@cc/protocol'
import type { AppToolResult } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.js'
import { TEXT_SCALES, externalAppKey, useStore } from '../../store/store.js'

/**
 * 앱 화면 한 장 (M4 B-3c, 스파이크 S-1 `harness/src/host.ts`).
 *
 * host가 준 샌드박스 프록시 주소를 iframe으로 띄우고, 공식 ext-apps 2.x `AppBridge`로 화면과
 * 이야기한다. 화면(앱의 HTML)은 프록시 안쪽의 불투명 출처 프레임에서 돈다. 이 컴포넌트가 아는
 * 것은 바깥 프레임 하나다. 메시지는 그 프레임의 `contentWindow`에서 온 것만 받는다(event.source).
 *
 * **이 화면이 어느 앱인지는 props가 정한다.** 화면이 보내는 메시지에 무엇이 적혀 있든 도구
 * 호출과 리소스 읽기는 이 컴포넌트의 `appId`로 나간다(플랜 "화면의 앱 id는 메시지를 보낸
 * iframe으로 정한다", #93·#94와 같은 원칙).
 *
 * 순서: 브리지를 **먼저** 연결하고 그다음에 주소를 싣는다. iframe의 `contentWindow`는 이동해도
 * 같은 객체다. 그래서 화면의 첫 `ui/initialize`가 이미 듣고 있는 브리지에 닿는다. 프록시와
 * 준비 신호를 주고받지 않는 이유다(host views/proxy-page.ts).
 */

export type AppFrameTeardown = 'answered' | 'timeout' | 'failed' | 'not-connected'

export type AppFrameHandle = {
  /**
   * 규격의 `ui/resource-teardown`을 보내고 답을 잠깐 기다린다. 부모는 화면을 내리기 **전에**
   * 이것을 부른다. 답을 받으면 브리지를 닫고 프레임을 비운다.
   *
   * 언마운트만으로는 보장할 수 없다. React가 iframe을 DOM에서 떼는 순간 그 창의 브라우징
   * 컨텍스트가 사라진다. 그 전에 보낸 메시지도, 기다리던 답도 함께 버려진다.
   */
  teardown(): Promise<AppFrameTeardown>
}

export type AppFrameMessage = { role: 'user'; content: unknown[] }

export type AppFrameProps = {
  appId: AppId
  /** 앱은 (프로젝트, id)로 정해진다. null은 사용자 폴더 앱 */
  projectId?: string | null
  /** 도구 호출 한 번이 만든 화면 인스턴스 (host가 발급) */
  instanceId: string
  /** 화면을 만든 도구 호출의 인자. 알게 되면 규격대로 한 번 보낸다 */
  toolInput?: Record<string, unknown>
  /** 그 호출의 결과. 끝나면 규격대로 한 번 보낸다 (tool-input 다음에) */
  toolResult?: AppToolResult
  /**
   * 그 호출이 답 없이 끝났다 — 취소, 거절, 앱이 못 뜸 (M4 B-1). 결과 대신 이 이유로 규격의 tool-cancelled를
   * 한 번 보낸다(tool-input 다음에). 결과와 취소는 둘 중 먼저 온 하나만 간다.
   */
  toolCancelled?: string
  /**
   * "이 앱의 상태가 바뀌었다" (B-3d). 값이 바뀔 때마다 화면에 우리 확장 알림
   * `centralu/notifications/changed`를 보낸다.
   *
   * 주지 않으면 스토어의 그 앱 카운터를 쓴다(`externalAppChanges`). host는 앱에 닿은 호출이
   * 끝날 때마다 `external_app_state_changed`를 알리고, 스토어가 (프로젝트, 앱)마다 센다(플랜
   * "열린 화면이 같은 값을 보는 법"). 그래서 어느 부모가 이 화면을 띄우든 배선 없이 갱신을
   * 받는다. 값을 주는 부모는 그 신호를 스스로 정한다.
   */
  changeSignal?: number
  /**
   * 화면이 대화에 보내는 말(`ui/message`). 없으면 거절로 답한다. 어디로 보낼지는 부모가 정한다.
   * `false`를 돌려주면 거절로 답한다 — 고정 화면은 사람에게 어느 세션으로 보낼지 묻고, 사람이 취소하면
   * 화면에 "보내지 않았다"를 알려야 한다(B-4). 조용히 성공으로 답하면 화면은 보냈다고 믿는다.
   */
  onMessage?: (message: AppFrameMessage) => void | boolean | Promise<void | boolean>
  /**
   * 고정 화면(B-2): 화면이 놓인 자리를 채운다. 높이는 화면(`size-changed`)이 아니라 자리가 정하고,
   * 화면에는 그 크기를 고정 크기로 알린다(`containerDimensions: { height, width }`). 넘치는 내용은
   * 화면 안에서 스크롤된다. 대화 안 화면은 내용만큼 자라지만, 메인 영역을 차지한 화면이 제 키를
   * 정하면 짧은 앱은 영역 위쪽에 띠로 남고 긴 앱은 영역 밖으로 나간다.
   */
  fill?: boolean
  /**
   * 화면이 뜨는 동안 기본 한 줄("Loading app view…") 대신 보일 것 — 고정 화면의 스켈레톤(B-6). 프레임
   * 위를 덮는다. 프레임은 그 아래에서 계속 뜨고, 화면이 초기화되는 순간 걷힌다.
   */
  loading?: ReactNode
  className?: string
}

/** 우리 확장 알림. 표준 밖이라 우리 템플릿이 아닌 화면은 받지 않고 지나간다 */
export const CHANGED_NOTIFICATION = 'centralu/notifications/changed'

/**
 * teardown 답을 기다리는 시간. 규격은 "답을 기다려야 한다(SHOULD)"라고만 적는다. 화면은 이
 * 동안 저장하거나 정리한다. 대화 안 화면은 가상 스크롤에서 벗어날 때마다 이 시간을 쓰므로
 * 길게 잡지 않는다.
 */
export const TEARDOWN_WAIT_MS = 1000

const MIN_HEIGHT = 24
const MAX_HEIGHT = 2000
const INITIAL_HEIGHT = 160

/**
 * 바깥(프록시) 프레임의 sandbox. 안쪽 프레임은 이것보다 넓을 수 없다(중첩 sandbox는 교집합).
 * 앱별 출처 방식의 안쪽 프레임에 `allow-same-origin`이 필요해서 여기에도 둔다. 프록시는 우리
 * 화면과 다른 출처(host 포트)라 이 조합으로도 우리 창에 손대지 못한다. 팝업과 최상위 이동은
 * 어느 겹에도 없다.
 */
const PROXY_SANDBOX = 'allow-scripts allow-same-origin allow-forms'

/** 링크는 이 셋만 연다. 나머지(`javascript:`, `file:`, 사용자 정의 스킴)는 묻지도 않고 거절한다 */
const OPENABLE = /^(https?:|mailto:)/i

/**
 * 우리 색과 글꼴을 규격의 변수 이름으로 넘긴다. 값은 화면이 놓인 자리에서 **읽는다.** 대화
 * 레인은 바닥색을 한 단계 올려 두었다(styles/index.css `[data-testid='session-view']`).
 * 적어 두면 자리마다 틀린 색이 된다.
 */
const STYLE_MAP: readonly [string, string][] = [
  ['--color-background-primary', '--color-void'],
  ['--color-background-secondary', '--color-panel'],
  ['--color-background-tertiary', '--color-graphite'],
  ['--color-text-primary', '--color-chalk'],
  ['--color-text-secondary', '--color-ash'],
  ['--color-text-tertiary', '--color-slate'],
  ['--color-border-primary', '--color-edge'],
  ['--color-border-secondary', '--color-graphite'],
  ['--font-sans', '--font-sans'],
  ['--font-mono', '--font-mono'],
]

function styleVariables(el: Element | null): Record<string, string> {
  if (!el) return {}
  const cs = getComputedStyle(el)
  const out: Record<string, string> = {}
  for (const [spec, ours] of STYLE_MAP) {
    const v = cs.getPropertyValue(ours).trim()
    if (v) out[spec] = v
  }
  return out
}

/**
 * 화면에 알리는 우리 환경. 테마는 하나(어두움)뿐이다.
 *
 * 글자 크기는 `centralu.fontScale`로 **알리기만** 한다. 앱 전체의 글자 크기는 루트의 CSS
 * zoom이고, zoom은 iframe 안의 내용까지 같은 배율로 그린다(Chromium·WebKit 실측: zoom 2에서
 * 100px 상자가 200 장치 픽셀, 안쪽 devicePixelRatio 2). 그래서 규격의 글꼴 크기 변수를 배율만큼
 * 키워 보내면 두 번 커진다.
 */
function hostContext(scale: number, el: Element | null, fill = false): McpUiHostContext {
  const variables = styleVariables(el)
  return {
    theme: 'dark',
    platform: 'desktop',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: fill ? fillDimensions(el) : { maxHeight: MAX_HEIGHT },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(Object.keys(variables).length ? { styles: { variables: variables as never } } : {}),
    centralu: { fontScale: scale },
  }
}

/**
 * 채우는 화면의 크기. 숨겨진 자리(다른 것을 보는 동안의 고정 화면, `display: none`)는 0이다 —
 * 0을 알리면 화면이 자기를 접는다. 그때는 모른다고 말한다(`maxHeight`만).
 */
function fillDimensions(el: Element | null): McpUiHostContext['containerDimensions'] {
  const h = el?.clientHeight ?? 0
  const w = el?.clientWidth ?? 0
  return h > 0 && w > 0 ? { height: h, width: w } : { maxHeight: MAX_HEIGHT }
}

type Phase = 'loading' | 'ready' | 'error' | 'closed'
type LinkAsk = { url: string; answer: (open: boolean) => void }

export const AppFrame = forwardRef<AppFrameHandle, AppFrameProps>(function AppFrame(
  { appId, projectId = null, instanceId, toolInput, toolResult, toolCancelled, changeSignal, onMessage, fill = false, loading, className },
  ref,
) {
  const platform = usePlatform()
  const scale = TEXT_SCALES[useStore((s) => s.textScale)] ?? 1
  const heard = useStore((s) => s.externalAppChanges[externalAppKey(projectId, appId)])
  const signal = changeSignal ?? heard
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [linkAsk, setLinkAsk] = useState<LinkAsk | null>(null)

  // 브리지 처리기는 한 번 걸고 오래 산다 — 바뀌는 값은 ref로 읽는다
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const fillRef = useRef(fill)
  fillRef.current = fill
  const sent = useRef({ input: false, result: false, change: undefined as number | undefined })
  const changeRef = useRef(signal)
  changeRef.current = signal

  /** 링크는 사람이 확인한 뒤 연다. 먼저 온 질문이 남아 있으면 그것은 거절로 닫는다 */
  const linkAskRef = useRef<LinkAsk | null>(null)
  const settleLink = useCallback((open: boolean) => {
    const ask = linkAskRef.current
    linkAskRef.current = null
    setLinkAsk(null)
    ask?.answer(open)
  }, [])
  const askToOpen = useCallback(
    (url: string) =>
      new Promise<boolean>((resolve) => {
        linkAskRef.current?.answer(false)
        const ask = { url, answer: resolve }
        linkAskRef.current = ask
        setLinkAsk(ask)
      }),
    [],
  )

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    let cancelled = false
    let bridge: AppBridge | null = null
    sent.current = { input: false, result: false, change: changeRef.current }
    setPhase('loading')
    setError(null)

    void (async () => {
      const [{ AppBridge, PostMessageTransport }, frame] = await Promise.all([
        // 브리지는 화면이 처음 뜰 때 불러온다 — 앱 화면을 한 번도 안 여는 사람의 기동 비용이 0이다
        import('@modelcontextprotocol/ext-apps/app-bridge'),
        platform.apps.viewFrame(appId, instanceId, { projectId, hostOrigin: window.location.origin }),
      ])
      if (cancelled) return
      bridge = new AppBridge(
        null,
        { name: 'Centralu', version: APP_VERSION },
        {
          openLinks: {},
          serverTools: {},
          serverResources: {},
          logging: {},
          ...(onMessageRef.current ? { message: { text: {} } } : {}),
          sandbox: { csp: frame.sandbox.csp, permissions: frame.sandbox.permissions },
          experimental: { [CHANGED_NOTIFICATION]: {} },
        },
        { hostContext: hostContext(scaleRef.current, boxRef.current, fillRef.current) },
      )
      const from = { projectId, instanceId }
      // 앱은 이 컴포넌트의 것이다 — params에 무엇이 실려 와도 appId는 여기서 정한다
      bridge.oncalltool = async (params) =>
        (await platform.apps.callTool(appId, params.name, params.arguments ?? {}, from)) as never
      bridge.onreadresource = async (params) => (await platform.apps.readResource(appId, params.uri, from)) as never
      bridge.onopenlink = async ({ url }) => {
        if (typeof url !== 'string' || !OPENABLE.test(url)) return { isError: true }
        if (!(await askToOpen(url))) return { isError: true }
        // 이미 있는 바깥 열기 길과 같다(components/terminalLinks.ts). 앱 안에서 이동하면 세션이 날아간다
        window.open(url, '_blank', 'noopener,noreferrer')
        return {}
      }
      bridge.onsizechange = ({ height: h }) => {
        // 채우는 화면의 키는 자리가 정한다 — 화면이 알려 온 키로 자리를 바꾸지 않는다
        if (fillRef.current) return
        if (typeof h === 'number' && Number.isFinite(h)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))))
      }
      bridge.onmessage = async (params) => {
        const deliver = onMessageRef.current
        if (!deliver) return { isError: true }
        const delivered = await deliver({ role: params.role, content: params.content })
        return delivered === false ? { isError: true } : {}
      }
      // 기록 보기(B-7)가 생기기 전까지 화면의 로그는 받기만 한다
      bridge.onloggingmessage = () => {}
      bridge.oninitialized = () => {
        if (cancelled || !bridge) return
        // 연결과 초기화 사이에 글자 크기가 바뀌었으면 여기서 따라잡는다 (바뀐 칸만 나간다)
        bridge.setHostContext(hostContext(scaleRef.current, boxRef.current, fillRef.current))
        sent.current.change = changeRef.current
        setPhase('ready')
      }
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!))
      if (cancelled) {
        void bridge.close()
        return
      }
      bridgeRef.current = bridge
      // 기능 위임은 이동 전에 정해진다 — 주소를 싣기 전에 건다
      if (frame.allow) iframe.setAttribute('allow', frame.allow)
      else iframe.removeAttribute('allow')
      iframe.src = frame.url
    })().catch((e: unknown) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    })

    return () => {
      cancelled = true
      bridgeRef.current = null
      if (bridge) void bridge.close()
      settleLink(false)
    }
  }, [platform, appId, projectId, instanceId, askToOpen, settleLink])

  /*
   * 부모가 teardown 없이 내려 버리는 경우의 마지막 시도. 레이아웃 효과의 정리는 iframe이 아직
   * 붙어 있을 때 돈다. 그래서 요청이 적어도 창에는 부쳐진다. 도착과 답은 보장하지 않는다.
   * 보장이 필요한 부모는 위의 `teardown()`을 먼저 부른다.
   */
  useLayoutEffect(
    () => () => {
      const b = bridgeRef.current
      if (b) void b.teardownResource({}, { timeout: TEARDOWN_WAIT_MS }).catch(() => {})
    },
    [],
  )

  // tool-input은 한 번, tool-result(또는 tool-cancelled)는 그다음에 한 번 (규격: 결과 전에 입력이 반드시 먼저)
  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b) return
    if (toolInput !== undefined && !sent.current.input) {
      sent.current.input = true
      void b.sendToolInput({ arguments: toolInput })
    }
    if ((toolResult !== undefined || toolCancelled !== undefined) && !sent.current.result) {
      if (!sent.current.input) {
        sent.current.input = true
        void b.sendToolInput({ arguments: {} })
      }
      sent.current.result = true
      if (toolResult !== undefined) void b.sendToolResult(toolResult as never)
      else void b.sendToolCancelled({ reason: toolCancelled })
    }
  }, [phase, toolInput, toolResult, toolCancelled])

  // 글자 크기가 바뀌면 host-context-changed (setHostContext가 바뀐 칸만 보낸다)
  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b) return
    b.setHostContext(hostContext(scale, boxRef.current, fill))
  }, [phase, scale, fill])

  /*
   * 채우는 화면은 자리의 크기가 바뀔 때마다 알린다(창 크기, 사이드바 폭, 기록 패널 열고 닫기).
   * 숨겨졌다가 다시 보일 때도 여기로 온다 — 숨은 동안의 0은 알리지 않으므로(fillDimensions),
   * 보이는 순간의 크기가 다음 알림이 된다.
   */
  useEffect(() => {
    const box = boxRef.current
    if (!fill || phase !== 'ready' || !box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => bridgeRef.current?.setHostContext(hostContext(scaleRef.current, box, true)))
    ro.observe(box)
    return () => ro.disconnect()
  }, [fill, phase])

  // B-3d: 앱의 상태가 바뀌었다 — 초기화 뒤, 값이 달라질 때마다 한 번
  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b || signal === undefined) return
    if (sent.current.change === signal) return
    sent.current.change = signal
    void b.notification({ method: CHANGED_NOTIFICATION, params: {} })
  }, [phase, signal])

  useImperativeHandle(
    ref,
    () => ({
      async teardown() {
        const b = bridgeRef.current
        if (!b || phase !== 'ready') return 'not-connected'
        let outcome: AppFrameTeardown
        try {
          await b.teardownResource({}, { timeout: TEARDOWN_WAIT_MS })
          outcome = 'answered'
        } catch (e) {
          outcome = /timed? ?out/i.test(String((e as Error)?.message)) ? 'timeout' : 'failed'
        }
        bridgeRef.current = null
        void b.close()
        // 화면을 내린다 — 부모가 곧 떼더라도 그 사이에 화면이 더 말하지 않게
        iframeRef.current?.removeAttribute('src')
        setPhase('closed')
        return outcome
      },
    }),
    [phase],
  )

  return (
    <div ref={boxRef} className={`${className ?? ''} ${loading ? 'relative' : ''}`} data-testid="app-frame" data-phase={phase}>
      {phase === 'loading' &&
        (loading ? (
          <div className="absolute inset-0 z-10 flex" data-testid="app-frame-loading">
            {loading}
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] text-ash" data-testid="app-frame-loading">
            Loading app view…
          </div>
        ))}
      {phase === 'error' && (
        <div className="rounded-md border border-edge bg-panel px-3 py-2 text-[12px] text-ash" role="alert" data-testid="app-frame-error">
          This app view could not be shown: {error}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={`${appId} view`}
        sandbox={PROXY_SANDBOX}
        data-testid="app-frame-iframe"
        className={`block w-full rounded-md border border-edge ${fill ? 'min-h-0 flex-1' : ''}`}
        style={{
          ...(fill ? {} : { height }),
          display: phase === 'ready' || phase === 'loading' ? 'block' : 'none',
        }}
      />
      {linkAsk && (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-edge bg-panel px-3 py-2 text-[12px] text-chalk" data-testid="app-frame-link-ask">
          <span className="min-w-0 flex-1 truncate">
            This app wants to open <span className="readout text-ash">{linkAsk.url}</span>
          </span>
          <button
            type="button"
            className="rounded border border-edge px-2 py-0.5 hover:bg-graphite"
            data-testid="app-frame-link-open"
            onClick={() => settleLink(true)}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-ash hover:bg-graphite"
            data-testid="app-frame-link-cancel"
            onClick={() => settleLink(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
})
