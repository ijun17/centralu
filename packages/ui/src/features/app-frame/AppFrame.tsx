import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { appKeyOf } from '@cc/core'
import type { AppBridge, McpUiHostContext, McpUiStyles, McpUiTheme } from '@modelcontextprotocol/ext-apps/app-bridge'
import { errorMessage, APP_DRAG_NOTIFICATION, APP_VERSION, type AppId } from '@cc/protocol/client'
import type { AppToolResult, AppViewFrame } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.js'
import { Button } from '../../components/Button.jsx'
import { useStore } from '../../store/store.js'
import { viewReconnect } from '../../store/viewReconnect.js'
import { DragRelay } from './dragRelay.js'
import { activeTheme, readHostStyles } from './hostStyles.js'

// One app view (docs/apps/views.md "How a view is hosted"): the host's proxy address in an iframe, spoken to through
// ext-apps' `AppBridge` and heard only from that frame's `contentWindow`. Calls and reads go out under the `appId` prop,
// whatever the view's messages claim (#93, #94).

export type AppFrameTeardown = 'answered' | 'timeout' | 'failed' | 'not-connected'

export type AppFrameHandle = {
  /**
   * Sends `ui/resource-teardown`, waits briefly for a reply, then closes the bridge and clears the frame. The parent calls
   * it before taking the view down: once React detaches the iframe, its browsing context goes, with any pending message or reply.
   */
  teardown(): Promise<AppFrameTeardown>
}

export type AppFrameMessage = { role: 'user'; content: unknown[] }

export type AppFrameProps = {
  appId: AppId
  /** null: a user-folder app */
  projectId?: string | null
  /** A user-folder app's linked machine (#82); a drag out of the view carries it, so the session knows which app it came from */
  machine?: string | null
  /** Issued by the host for the tool call that created the view */
  instanceId: string
  /** The creating call's arguments; sent once, when known */
  toolInput?: Record<string, unknown>
  /** Sent once, after tool-input */
  toolResult?: AppToolResult
  /** No result (cancelled, rejected, the app failed to open): sent once as tool-cancelled, if it comes before a result */
  toolCancelled?: string
  /**
   * Each change sends `centralu/notifications/changed` (docs/apps/views.md "Keeping open views current"). Defaults to the
   * store's per-app counter (`externalAppChanges`), so any parent gets updates unwired and the view's own changes are skipped
   * (`externalAppChangedBy`). A supplied value has no known owner, so every change is reported.
   */
  changeSignal?: number
  /**
   * The view's `ui/message`; the parent decides where it goes. Missing, or returning `false`, answers with rejection: a pinned
   * view's person may cancel the session pick, and the view must not believe it was sent.
   */
  onMessage?: (message: AppFrameMessage) => void | boolean | Promise<void | boolean>
  /**
   * Pinned view: fills its slot and is told that fixed size (`containerDimensions`); content scrolls inside. A main-area view
   * that set its own height would leave a band (short app) or spill out (tall app).
   */
  fill?: boolean
  /**
   * No address could be got (instance closed, host restarted). Supplied: the parent fills the place (an inline view collapses
   * to a placeholder); otherwise this component shows the reason.
   */
  onFailed?: (message: string) => void
  /** Laid over the loading frame instead of "Loading app view…" (the pinned skeleton); lifted when the view initializes */
  loading?: ReactNode
  className?: string
}

/** Outside the standard: a view not built from our template ignores it */
export const CHANGED_NOTIFICATION = 'centralu/notifications/changed'

/** The spec only says SHOULD wait. Short: an inline view spends it each time it scrolls out of the virtualized list */
export const TEARDOWN_WAIT_MS = 1000

const MIN_HEIGHT = 24
const MAX_HEIGHT = 2000
const INITIAL_HEIGHT = 160

/**
 * Nested sandboxes intersect, so this carries the inner frame's `allow-same-origin` (per-app origin). The proxy is on the
 * host's origin, not ours, so it still cannot touch our window. No layer gets popups or top-level navigation.
 */
const PROXY_SANDBOX = 'allow-scripts allow-same-origin allow-forms'

/** Any other scheme (`javascript:`, `file:`, custom) is refused without asking */
const OPENABLE = /^(https?:|mailto:)/i

/**
 * docs/apps/attaching.md "Long calls and cancellation". Three beats per the SDK's 60 s, so one late beat cannot let the
 * clock run out and leave the app's result with nowhere to go.
 */
const CALL_HEARTBEAT_MS = 20_000

/**
 * Keeps one running call alive; returns its stop. No progress token means the view's SDK registered no `onprogress` and
 * would not hear a beat. `progress` must grow with each notification (spec).
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
 * docs/apps/view-theme-layout-drag.md "The theme in a view". The text size is only announced (`centralu.fontScale`): the
 * root's CSS zoom already scales iframe content (measured in Chromium and WebKit: at zoom 2 a 100px box is 200 device
 * pixels, devicePixelRatio 2), so scaling the font variables too would double it.
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

/** The proxy page reads the side here before its first paint; the fragment never reaches the host, and `loadedUrl` stays the host's */
function withScheme(url: string, theme: McpUiTheme): string {
  return `${url.split('#')[0]}#color-scheme=${theme}`
}

/**
 * A slot not sized yet reads 0, which would collapse the view, so it says unknown (`maxHeight` only). A hidden pinned view
 * keeps its size: it is moved out of the window, never `display: none` (PinnedApps' OUT_OF_SIGHT).
 */
function fillDimensions(el: Element | null): McpUiHostContext['containerDimensions'] {
  const h = el?.clientHeight ?? 0
  const w = el?.clientWidth ?? 0
  return h > 0 && w > 0 ? { height: h, width: w } : { maxHeight: MAX_HEIGHT }
}

type Phase = 'loading' | 'reconnecting' | 'ready' | 'error' | 'closed'
type LinkAsk = { url: string; answer: (open: boolean) => void }

export const AppFrame = forwardRef<AppFrameHandle, AppFrameProps>(function AppFrame(
  { appId, projectId = null, machine = null, instanceId, toolInput, toolResult, toolCancelled, changeSignal, onMessage, onFailed, fill = false, loading, className },
  ref,
) {
  const platform = usePlatform()
  const scale = useStore((s) => s.prefs.textSize)
  const heard = useStore((s) => s.externalAppChanges[appKeyOf(projectId, appId)])
  const heardBy = useStore((s) => s.externalAppChangedBy[appKeyOf(projectId, appId)] ?? null)
  const signal = changeSignal ?? heard
  const by = changeSignal === undefined ? heardBy : null
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [linkAsk, setLinkAsk] = useState<LinkAsk | null>(null)
  // The side that shows, and a count of `cc-themechange` switches (app/theme.ts). Tokens are re-read from the slot on each,
  // so an edit to a custom theme reaches the view as a preset switch does.
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

  // The bridge handlers live long, so changing values are read through refs
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const fillRef = useRef(fill)
  fillRef.current = fill
  const sent = useRef({ input: false, result: false, change: undefined as number | undefined })
  /** Each running call's beat (`keepAlive`); all stop when the view goes down */
  const beats = useRef(new Set<ReturnType<typeof setInterval>>())
  const changeRef = useRef(signal)
  changeRef.current = signal
  const hostResyncs = useStore((s) => s.hostResyncs)
  /** null until loaded, and again once the load is undone */
  const loadedUrl = useRef<string | null>(null)
  /** Another host's different address, already fetched: the load below takes it instead of asking again */
  const nextFrame = useRef<AppViewFrame | null>(null)
  const [reload, setReload] = useState(0)

  /** A link opens only once the person confirms; a newer ask rejects a pending one */
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
        // Loaded with the first view, so startup never pays for it
        import('@modelcontextprotocol/ext-apps/app-bridge'),
        known ?? viewReconnect(platform, () => platform.apps.viewFrame(appId, instanceId, { projectId, hostOrigin: window.location.origin }), () => { if (!cancelled) setPhase('reconnecting') }),
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
        // Opened outside, as terminal links are: navigating in the app would lose the session. A failed open answers an
        // error, never {} (#159).
        try {
          await platform.system.openUrl(url)
        } catch {
          return { isError: true }
        }
        return {}
      }
      bridge.onsizechange = ({ height: h }) => {
        if (fillRef.current) return
        if (typeof h === 'number' && Number.isFinite(h)) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))))
      }
      bridge.onmessage = async (params) => {
        const deliver = onMessageRef.current
        if (!deliver) return { isError: true }
        const delivered = await deliver({ role: params.role, content: params.content })
        return delivered === false ? { isError: true } : {}
      }
      bridge.onloggingmessage = () => {}
      // A drag out of the view comes through the host's relay (dragRelay.ts); other non-standard notifications are ignored
      const relay = new DragRelay(() => iframe, () => ({ appId, projectId, machine }), platform.capabilities.frameDragEndInPage)
      bridge.fallbackNotificationHandler = async (n) => {
        if (n.method === APP_DRAG_NOTIFICATION) relay.take(n.params)
      }
      bridge.oninitialized = () => {
        if (cancelled || !bridge) return
        // Catches up a text size changed between connect and initialize
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
      // Connected before the address loads: `contentWindow` survives navigation, so the view's first `ui/initialize` finds
      // the bridge listening and the proxy needs no readiness handshake. `allow` is fixed at navigation, so it goes first.
      if (frame.allow) iframe.setAttribute('allow', frame.allow)
      else iframe.removeAttribute('allow')
      iframe.src = withScheme(frame.url, activeTheme())
      loadedUrl.current = frame.url
    })().catch((e: unknown) => {
      if (cancelled) return
      const message = errorMessage(e)
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
  }, [platform, appId, projectId, machine, instanceId, askToOpen, settleLink, reload])

  // Another host behind the connection (a restart, an update's next host, #280, #1895): ask for the address again. The same
  // address keeps the frame, bridge and view state; another loads like the first, and fails the same way. Skipped while
  // loading (its own request reaches the new host) and after teardown.
  const refreshing = useRef<{ url: string; request: Promise<void> } | null>(null)
  const resyncsSeen = useRef(hostResyncs)
  useEffect(() => {
    if (hostResyncs === resyncsSeen.current) return
    resyncsSeen.current = hostResyncs
    const loaded = loadedUrl.current
    if (loaded === null || refreshing.current?.url === loaded) return
    // A resync greeting also wakes the current retry. Starting another read would reset its bound.
    const request = viewReconnect(platform, () => platform.apps.viewFrame(appId, instanceId, { projectId, hostOrigin: window.location.origin }), () => {
      if (loadedUrl.current === loaded) setPhase('reconnecting')
    }).then(
      (frame) => {
        if (loadedUrl.current !== loaded) return
        if (frame.url === loaded) {
          setPhase('ready')
          return
        }
        nextFrame.current = frame
        setReload((n) => n + 1)
      },
      (e: unknown) => {
        if (loadedUrl.current !== loaded) return
        const message = errorMessage(e)
        setError(message)
        setPhase('error')
        onFailedRef.current?.(message)
      },
    ).finally(() => {
      if (refreshing.current?.request === request) {
        // Greetings received during this read already woke its retry; absorb a delayed React effect too.
        resyncsSeen.current = useStore.getState().hostResyncs
        refreshing.current = null
      }
    })
    refreshing.current = { url: loaded, request }
  }, [hostResyncs, platform, appId, projectId, instanceId])

  // For a parent that unmounts without `teardown()`: a layout effect's cleanup runs while the iframe is attached, so the
  // request is at least posted. Neither delivery nor a reply is guaranteed.
  useLayoutEffect(
    () => () => {
      const b = bridgeRef.current
      if (b) void b.teardownResource({}, { timeout: TEARDOWN_WAIT_MS }).catch(() => {})
    },
    [],
  )

  // tool-input once, then tool-result or tool-cancelled once (the spec puts input first)
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

  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b) return
    b.setHostContext(hostContext(scale, boxRef.current, fill))
  }, [phase, scale, fill, themeRevision])

  // Hiding and showing are slot resizes too: a hidden pinned view waits out of the window at the lane's size.
  useEffect(() => {
    const box = boxRef.current
    if (!fill || phase !== 'ready' || !box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => bridgeRef.current?.setHostContext(hostContext(scaleRef.current, box, true)))
    ro.observe(box)
    return () => ro.disconnect()
  }, [fill, phase])

  useEffect(() => {
    const b = bridgeRef.current
    if (phase !== 'ready' || !b || signal === undefined) return
    const last = sent.current.change
    if (last === signal) return
    sent.current.change = signal
    // Not the view's own change: it has that as its call's answer, and re-reading could loop (measured: a template view
    // called `show` ~700 times/s). Skipped only for a rise of exactly one by this instance; a bigger rise may hide another's
    // change, and one extra read beats a stale value.
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
          outcome = /timed? ?out/i.test(errorMessage(e)) ? 'timeout' : 'failed'
        }
        bridgeRef.current = null
        void b.close()
        // A gone view needs no beats; a running call's outcome stays in the run record
        for (const t of beats.current) clearInterval(t)
        beats.current.clear()
        // Unloaded now, so the view says nothing more before the parent detaches it
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
      {(phase === 'loading' || phase === 'reconnecting') &&
        (phase === 'reconnecting' ? (
          <div className="px-3 py-2 text-sm text-ink-muted" data-testid="app-frame-loading">
            Reconnecting…
          </div>
        ) : loading ? (
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
          display: phase === 'ready' || phase === 'loading' || phase === 'reconnecting' ? 'block' : 'none',
          // The proxy page declares the same side: Chromium and WebKit paint a framed document opaque when the frame's
          // scheme and its document's differ (docs/apps/view-theme-layout-drag.md "The theme in a view").
          colorScheme: theme,
        }}
      />
      {linkAsk && (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" data-testid="app-frame-link-ask">
          <span className="min-w-0 flex-1 truncate">
            This app wants to open <span className="readout text-ink-muted">{linkAsk.url}</span>
          </span>
          <Button variant="secondary" data-testid="app-frame-link-open" onClick={() => settleLink(true)}>
            Open
          </Button>
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
