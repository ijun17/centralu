import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AppBridge, McpUiHostContext, McpUiStyles, McpUiTheme } from '@modelcontextprotocol/ext-apps/app-bridge'
import { APP_DRAG_NOTIFICATION, APP_VERSION, type AppId } from '@cc/protocol'
import type { AppToolResult, AppViewFrame } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.js'
import { externalAppKey, useStore } from '../../store/store.js'
import { DragRelay } from './dragRelay.js'
import { activeTheme, readHostStyles } from './hostStyles.js'

/**
 * A single app view (M4 B-3c, spike S-1 `harness/src/host.ts`).
 *
 * This renders the sandboxed proxy address the host gave it in an iframe, and talks to the view
 * through the official ext-apps 2.x `AppBridge`. The view (the app's HTML) runs inside an
 * opaque-origin frame nested inside the proxy. This component only knows about one outer frame.
 * It accepts messages only from that frame's `contentWindow` (event.source).
 *
 * **Which app this view belongs to is decided by props.** Whatever the view's own messages
 * claim, tool calls and resource reads always go out under this component's `appId` (the same
 * principle as the plan's "the view's app id is decided by which iframe sent the message", #93
 * and #94).
 *
 * Order: connect the bridge **first**, then load the address. An iframe's `contentWindow` stays
 * the same object across navigation, so the view's first `ui/initialize` reaches a bridge that
 * is already listening. That is why there is no readiness handshake with the proxy (host
 * views/proxy-page.ts).
 *
 * **Another host behind the connection** (a restart, or a build switch behind the keeper's front
 * door, #280): the view asks for its address again. The same address means the new host serves
 * this instance where the old one did, so the frame and the bridge are left alone and the view
 * keeps its state. Another address is loaded the way the first one was; a failure goes the same
 * way as a first load's failure.
 */

export type AppFrameTeardown = 'answered' | 'timeout' | 'failed' | 'not-connected'

export type AppFrameHandle = {
  /**
   * Sends the spec's `ui/resource-teardown` and waits briefly for a reply. The parent calls
   * this **before** taking the view down. Once it gets a reply, it closes the bridge and clears
   * the frame.
   *
   * Unmounting alone cannot guarantee this. The moment React detaches the iframe from the DOM,
   * that window's browsing context is gone, taking with it any message sent before then and the
   * reply that was being waited on.
   */
  teardown(): Promise<AppFrameTeardown>
}

export type AppFrameMessage = { role: 'user'; content: unknown[] }

export type AppFrameProps = {
  appId: AppId
  /** An app is identified by (project, id). null means a user-folder app */
  projectId?: string | null
  /** The view instance created by one tool call (issued by the host) */
  instanceId: string
  /** The arguments of the tool call that created the view. Sent once, per spec, once it is known */
  toolInput?: Record<string, unknown>
  /** The result of that call. Sent once, per spec, when it finishes (after tool-input) */
  toolResult?: AppToolResult
  /**
   * The call ended without a result — cancelled, rejected, or the app failed to open (M4 B-1).
   * Instead of a result, the spec's tool-cancelled is sent once with this reason (after
   * tool-input). Whichever of result or cancellation arrives first is the one that is sent.
   */
  toolCancelled?: string
  /**
   * "This app's state changed" (B-3d). Every time the value changes, sends the view our
   * extension notification `centralu/notifications/changed`.
   *
   * If not supplied, uses the store's counter for that app (`externalAppChanges`). The host
   * reports `external_app_state_changed` every time a call that reached the app finishes, and
   * the store counts it per (project, app) (the plan's "how open views see the same value").
   * That way, whichever parent mounts this view, it gets updates with no wiring of its own. A
   * change caused by this view itself is not reported (`externalAppChangedBy`). A parent that
   * supplies the value decides for itself when to signal it — in that case the owner is
   * unknown, so it reports on every change.
   */
  changeSignal?: number
  /**
   * A message the view sends to the conversation (`ui/message`). Answered with rejection if
   * this is not supplied. Where it goes is decided by the parent. Returning `false` also
   * answers with rejection — a pinned view asks the person which session to send to, and if the
   * person cancels, the view has to be told "it was not sent" (B-4). Answering with silent
   * success would leave the view believing it was sent.
   */
  onMessage?: (message: AppFrameMessage) => void | boolean | Promise<void | boolean>
  /**
   * Pinned view (B-2): fills the slot the view is placed in. Height is decided by the slot, not
   * by the view (`size-changed`), and the view is told that size as a fixed size
   * (`containerDimensions: { height, width }`). Overflowing content scrolls inside the view. A
   * view inside the conversation grows to fit its content, but if a view occupying the main area
   * set its own height, a short app would leave a band at the top of the area and a tall app
   * would spill outside it.
   */
  fill?: boolean
  /**
   * The view could not be opened (failed to get an address — the instance was already closed,
   * or the host restarted). If supplied, the parent decides what goes in its place: a view
   * inside the conversation (B-1) collapses to a placeholder instead of a broken frame. If not
   * supplied, this component draws the reason itself.
   */
  onFailed?: (message: string) => void
  /**
   * What to show instead of the default one-line message ("Loading app view…") while the view
   * is loading — the pinned view's skeleton (B-6). Covers the frame from above. The frame keeps
   * loading underneath it and this is lifted the moment the view initializes.
   */
  loading?: ReactNode
  className?: string
}

/** Our extension notification. Being outside the standard, a view that is not our template ignores it */
export const CHANGED_NOTIFICATION = 'centralu/notifications/changed'

/**
 * How long to wait for a teardown reply. The spec only says it "SHOULD" wait for a response.
 * The view uses this time to save or clean up. A view inside the conversation spends this time
 * every time it scrolls out of the virtualized list, so it is kept short.
 */
export const TEARDOWN_WAIT_MS = 1000

const MIN_HEIGHT = 24
const MAX_HEIGHT = 2000
const INITIAL_HEIGHT = 160

/**
 * Sandbox for the outer (proxy) frame. The inner frame cannot have broader permissions than
 * this (nested sandboxes intersect). The inner frame, in its per-app-origin scheme, needs
 * `allow-same-origin`, so it is included here too. The proxy is on a different origin from our
 * own view (the host's port), so this combination still cannot touch our window. Popups and
 * top-level navigation are absent from every layer.
 */
const PROXY_SANDBOX = 'allow-scripts allow-same-origin allow-forms'

/** Links only open for these three schemes. Everything else (`javascript:`, `file:`, custom schemes) is rejected without even asking */
const OPENABLE = /^(https?:|mailto:)/i

/**
 * The interval for progress notifications sent to the view while a tool it called is running
 * (the plan's "slow calls": the host keeps a call alive during the wait by sending progress
 * notifications to the view).
 *
 * The view's SDK drops a request after 60 seconds (the MCP TS SDK's default limit). ext-apps'
 * `callServerTool` is set to reset that clock whenever a progress notification arrives
 * (`resetTimeoutOnProgress`). But the host keeps calls running well past that 60 seconds — while
 * waiting for approval (capability approval can take minutes), while a slow tool is running.
 * Without notifications, the view drops the call and shows a failure, yet the app finishes the
 * work anyway and the result has nowhere to go. Three times within 60 seconds is an interval at
 * which even one late notification does not let the clock run out.
 */
export const CALL_HEARTBEAT_MS = 20_000

/**
 * Keeps one running call alive — returns a function that stops it. If the view did not attach a
 * progress token, there is nothing to keep alive: that view's SDK never opened a slot to receive
 * progress notifications (a token is only attached to a request that registered `onprogress`),
 * and a notification it does not receive cannot reset its clock. The notification's `progress`
 * value only ever increases (per spec: the progress value must grow with every notification).
 */
function keepAlive(bridge: AppBridge, token: string | number | undefined, beats: Set<ReturnType<typeof setInterval>>): () => void {
  if (token === undefined) return () => {}
  let progress = 0
  const t = setInterval(() => {
    progress += 1
    void bridge.notification({ method: 'notifications/progress', params: { progressToken: token, progress } }).catch(() => {})
  }, CALL_HEARTBEAT_MS)
  beats.add(t)
  return () => {
    clearInterval(t)
    beats.delete(t)
  }
}

/**
 * Our environment as told to the view: the side of the theme that shows (`theme`), every MCP Apps
 * style variable mapped from our tokens, and Centralu's own variables (the signal colour and the
 * scrollbar) in the `centralu` extension (hostStyles.ts, #312 step 6). A theme switch sends it
 * again (the effect below), and the bridge sends only the fields that changed.
 *
 * The text size is **only announced** through `centralu.fontScale`. The app-wide text size
 * comes from CSS zoom on the root, and zoom renders even the content inside an iframe at the
 * same scale (measured in Chromium and WebKit: at zoom 2, a 100px box becomes 200 device
 * pixels, with an internal devicePixelRatio of 2). So scaling up the spec's font-size variables
 * by the same factor and sending that would double the enlargement.
 */
function hostContext(scale: number, el: Element | null, fill = false): McpUiHostContext {
  const { theme, variables, centralu } = readHostStyles(el)
  return {
    theme,
    platform: 'desktop',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: fill ? fillDimensions(el) : { maxHeight: MAX_HEIGHT },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(Object.keys(variables).length ? { styles: { variables: variables as McpUiStyles } } : {}),
    centralu: { fontScale: scale, ...(Object.keys(centralu).length ? { variables: centralu } : {}) },
  }
}

/**
 * The proxy page learns the side before the view says anything, from the address's fragment
 * (agent-host views/proxy-page.ts), so its colour scheme matches the frame's from the first paint.
 * The fragment never reaches the host, and the address kept for comparison stays the host's.
 */
function withScheme(url: string, theme: McpUiTheme): string {
  return `${url.split('#')[0]}#color-scheme=${theme}`
}

/**
 * The size of a filling view. A slot with no size yet is 0 — announcing 0 would make the view
 * collapse itself. In that case, it says "unknown" instead (only `maxHeight`). A pinned view while
 * something else is looked at keeps a size: it is moved out of the window, never `display: none`
 * (PinnedApps' OUT_OF_SIGHT).
 */
function fillDimensions(el: Element | null): McpUiHostContext['containerDimensions'] {
  const h = el?.clientHeight ?? 0
  const w = el?.clientWidth ?? 0
  return h > 0 && w > 0 ? { height: h, width: w } : { maxHeight: MAX_HEIGHT }
}

type Phase = 'loading' | 'ready' | 'error' | 'closed'
type LinkAsk = { url: string; answer: (open: boolean) => void }

export const AppFrame = forwardRef<AppFrameHandle, AppFrameProps>(function AppFrame(
  { appId, projectId = null, instanceId, toolInput, toolResult, toolCancelled, changeSignal, onMessage, onFailed, fill = false, loading, className },
  ref,
) {
  const platform = usePlatform()
  const scale = useStore((s) => s.prefs.textSize)
  const heard = useStore((s) => s.externalAppChanges[externalAppKey(projectId, appId)])
  const heardBy = useStore((s) => s.externalAppChangedBy[externalAppKey(projectId, appId)] ?? null)
  const signal = changeSignal ?? heard
  const by = changeSignal === undefined ? heardBy : null
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [linkAsk, setLinkAsk] = useState<LinkAsk | null>(null)
  /*
   * The side of the theme that shows, and a count of switches (app/theme.ts announces each one
   * with `cc-themechange`). The tokens are read again from the slot on every switch, so an edit to
   * a custom theme or the accent reaches the view the same way a preset switch does.
   */
  const [theme, setTheme] = useState<McpUiTheme>(activeTheme)
  const [themeRevision, setThemeRevision] = useState(0)
  useEffect(() => {
    const follow = () => {
      setTheme(activeTheme())
      setThemeRevision((n) => n + 1)
    }
    window.addEventListener('cc-themechange', follow)
    return () => window.removeEventListener('cc-themechange', follow)
  }, [])

  // The bridge handlers are attached once and live long — changing values are read through refs
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const fillRef = useRef(fill)
  fillRef.current = fill
  const sent = useRef({ input: false, result: false, change: undefined as number | undefined })
  /** Progress-notification clock for each running call (`keepAlive`) — stops together when the view goes down (cleanup, teardown) */
  const beats = useRef(new Set<ReturnType<typeof setInterval>>())
  const changeRef = useRef(signal)
  changeRef.current = signal
  const hostResyncs = useStore((s) => s.hostResyncs)
  /** The address the frame was loaded with — null until it is, and again once the load is undone */
  const loadedUrl = useRef<string | null>(null)
  /** An address already asked for that has to be loaded (another host gave a different one) — the load below takes it instead of asking again */
  const nextFrame = useRef<AppViewFrame | null>(null)
  const [reload, setReload] = useState(0)

  /** A link opens only after the person confirms it. If an earlier question is still pending, it is closed as rejected */
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
    const known = nextFrame.current
    nextFrame.current = null

    void (async () => {
      const [{ AppBridge, PostMessageTransport }, frame] = await Promise.all([
        // The bridge is loaded only when a view first opens — someone who never opens an app view pays zero startup cost
        import('@modelcontextprotocol/ext-apps/app-bridge'),
        known ?? platform.apps.viewFrame(appId, instanceId, { projectId, hostOrigin: window.location.origin }),
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
      const live = bridge
      // The app belongs to this component — whatever params carries, appId is decided here
      bridge.oncalltool = async (params) => {
        const stop = keepAlive(live, params._meta?.progressToken, beats.current)
        try {
          return (await platform.apps.callTool(appId, params.name, params.arguments ?? {}, from)) as never
        } finally {
          stop()
        }
      }
      bridge.onreadresource = async (params) => (await platform.apps.readResource(appId, params.uri, from)) as never
      bridge.onopenlink = async ({ url }) => {
        if (typeof url !== 'string' || !OPENABLE.test(url)) return { isError: true }
        if (!(await askToOpen(url))) return { isError: true }
        // The same outward-opening path as terminal links (the platform port). Navigating inside the app would blow away the session.
        // If it fails to open, the app also gets a failure answer — it used to be that success ({}) went back on desktop even when nothing opened (#159)
        try {
          await platform.system.openUrl(url)
        } catch {
          return { isError: true }
        }
        return {}
      }
      bridge.onsizechange = ({ height: h }) => {
        // A filling view's height is decided by the slot — the slot is never resized by a height the view reports
        if (fillRef.current) return
        if (typeof h === 'number' && Number.isFinite(h)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))))
      }
      bridge.onmessage = async (params) => {
        const deliver = onMessageRef.current
        if (!deliver) return { isError: true }
        const delivered = await deliver({ role: params.role, content: params.content })
        return delivered === false ? { isError: true } : {}
      }
      // Until a transcript viewer (B-7) exists, the view's logs are only received, never shown
      bridge.onloggingmessage = () => {}
      /*
       * An item dragged out of the view (#308): the host's relay in the view posts the drag's link
       * and where it ended, since the page never hears a drag from another origin (dragRelay.ts).
       * Every other notification outside the standard is ignored, as before.
       */
      const relay = new DragRelay(() => iframe, () => ({ appId, projectId }), platform.capabilities.frameDragEndInPage)
      bridge.fallbackNotificationHandler = async (n) => {
        if (n.method === APP_DRAG_NOTIFICATION) relay.take(n.params)
      }
      bridge.oninitialized = () => {
        if (cancelled || !bridge) return
        // If the text size changed between connect and initialize, this catches it up here (only the changed field goes out)
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
      // Feature delegation is fixed before navigation — set it before loading the address
      if (frame.allow) iframe.setAttribute('allow', frame.allow)
      else iframe.removeAttribute('allow')
      iframe.src = withScheme(frame.url, activeTheme())
      loadedUrl.current = frame.url
    })().catch((e: unknown) => {
      if (cancelled) return
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      setPhase('error')
      onFailedRef.current?.(message)
    })

    const heartbeats = beats.current
    return () => {
      cancelled = true
      loadedUrl.current = null
      bridgeRef.current = null
      if (bridge) void bridge.close()
      for (const t of heartbeats) clearInterval(t)
      heartbeats.clear()
      settleLink(false)
    }
  }, [platform, appId, projectId, instanceId, askToOpen, settleLink, reload])

  /*
   * Another host lifetime: ask for the address again (see the header). A view still loading is
   * skipped, since its own request already goes to the new host; so is one taken down.
   */
  const resyncsSeen = useRef(hostResyncs)
  useEffect(() => {
    if (hostResyncs === resyncsSeen.current) return
    resyncsSeen.current = hostResyncs
    const loaded = loadedUrl.current
    if (loaded === null) return
    let cancelled = false
    platform.apps.viewFrame(appId, instanceId, { projectId, hostOrigin: window.location.origin }).then(
      (frame) => {
        if (cancelled || loadedUrl.current !== loaded || frame.url === loaded) return
        nextFrame.current = frame
        setReload((n) => n + 1)
      },
      (e: unknown) => {
        if (cancelled || loadedUrl.current !== loaded) return
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        setPhase('error')
        onFailedRef.current?.(message)
      },
    )
    return () => {
      cancelled = true
    }
  }, [hostResyncs, platform, appId, projectId, instanceId])

  /*
   * A last-ditch attempt for the case where the parent tears the view down without calling
   * teardown. A layout effect's cleanup runs while the iframe is still attached, so the request
   * is at least posted to the window. Delivery and a reply are not guaranteed. A parent that
   * needs a guarantee calls `teardown()` above first.
   */
  useLayoutEffect(
    () => () => {
      const b = bridgeRef.current
      if (b) void b.teardownResource({}, { timeout: TEARDOWN_WAIT_MS }).catch(() => {})
    },
    [],
  )

  // tool-input once, then tool-result (or tool-cancelled) once after it (per spec: input must always precede the result)
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

  // On a text-size or theme change, host-context-changed (setHostContext sends only the changed fields)
  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b) return
    b.setHostContext(hostContext(scale, boxRef.current, fill))
  }, [phase, scale, fill, themeRevision])

  /*
   * A filling view is told whenever its slot's size changes (window size, sidebar width,
   * opening and closing the transcript panel). This also fires when it is hidden and shown
   * again: a hidden pinned view stands out of the window at the lane's size, and coming back
   * into its panel or the main area is a size change like any other.
   */
  useEffect(() => {
    const box = boxRef.current
    if (!fill || phase !== 'ready' || !box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => bridgeRef.current?.setHostContext(hostContext(scaleRef.current, box, true)))
    ro.observe(box)
    return () => ro.disconnect()
  }, [fill, phase])

  // B-3d: the app's state changed — once per value change, after initialization
  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b || signal === undefined) return
    const last = sent.current.change
    if (last === signal) return
    sent.current.change = signal
    /*
     * A change this view itself made is not reported — it already got that as the answer to its
     * call. Reporting it would make the view read again, and if that read triggers another
     * change, it becomes a loop. Measured (65acb43): one template view called `show` about 700
     * times per second. Skipping only happens when the counter went up by **exactly one** and
     * that one increment belongs to this instance. If it went up by two or more (piled up in a
     * single render), someone else's change may have been mixed in during that time, so it
     * reports — the safer error has to be "one extra read." It must never show a stale value.
     */
    if (by === instanceId && signal === (last ?? 0) + 1) return
    void b.notification({ method: CHANGED_NOTIFICATION, params: {} })
  }, [phase, signal, by, instanceId])

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
        // There is no reason to send progress notifications to a view that is gone — the outcome of a running call is kept in the execution record
        for (const t of beats.current) clearInterval(t)
        beats.current.clear()
        // Take the view down — so it says nothing more in the meantime even if the parent detaches it soon after
        iframeRef.current?.removeAttribute('src')
        loadedUrl.current = null
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
          <div className="px-3 py-2 text-sm text-ink-muted" data-testid="app-frame-loading">
            Loading app view…
          </div>
        ))}
      {phase === 'error' && !onFailed && (
        <div className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink-muted" role="alert" data-testid="app-frame-error">
          This app view could not be shown: {error}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={`${appId} view`}
        sandbox={PROXY_SANDBOX}
        data-testid="app-frame-iframe"
        className={`block w-full rounded-md border border-line ${fill ? 'min-h-0 flex-1' : ''}`}
        style={{
          ...(fill ? {} : { height }),
          display: phase === 'ready' || phase === 'loading' ? 'block' : 'none',
          /*
           * The side of the theme, which the proxy page states too (agent-host views/proxy-page.ts:
           * from the address's fragment first, then from every theme the bridge sends). Chromium and
           * WebKit paint a framed document's canvas opaque when the frame element's scheme and the
           * document's differ, so the view would sit on a solid rectangle instead of our background.
           */
          colorScheme: theme,
        }}
      />
      {linkAsk && (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" data-testid="app-frame-link-ask">
          <span className="min-w-0 flex-1 truncate">
            This app wants to open <span className="readout text-ink-muted">{linkAsk.url}</span>
          </span>
          <button
            type="button"
            className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-hover"
            data-testid="app-frame-link-open"
            onClick={() => settleLink(true)}
          >
            Open
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-ink-muted hover:bg-surface-hover"
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
