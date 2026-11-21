import { useEffect, useState, type ReactNode } from 'react'
import { parseAppLink } from '@cc/protocol/client'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider, useCapability } from './PlatformProvider.jsx'
import { useNavShortcut, useShortcut } from './shortcut.js'
import { isTextEntry, letterOf, navButtonOf, navKeyOf } from './keys.js'
import { isForeground } from './foreground.js'
import { Gust } from './Gust.jsx'
import { ErrorBoundary } from './ErrorBoundary.jsx'
import { applyTheme, cacheChoice, pickTheme, resolveChoice } from './theme.js'
import { applyTypography, cacheTypography, typographyOf } from './typography.js'
import { CENTER_FLOOR, projectScreenOf, screenExists, usableThemeFiles, useStore, useTextZoom } from '../store/store.js'
import { showsIntro } from '../store/screens.js'
import { canStep } from '../store/navHistory.js'
import { dialogOpen } from '../store/layers.js'
import { useCounts } from '../store/selectors.js'
import { Sidebar } from '../features/sidebar/Sidebar.jsx'
import { EvidencePanel } from '../features/evidence/EvidencePanel.jsx'
import { Overlay } from '../features/evidence/Overlay.jsx'
import { SessionView } from '../features/session/SessionView.jsx'
import { KeptDraftCard } from '../features/session/KeptDraft.jsx'
import { GridView } from '../features/grid/GridView.jsx'
import { AssistantView } from '../features/assistant/AssistantView.jsx'
import { PinnedApps } from '../features/pinned-app/PinnedApps.jsx'
import { ProjectView } from '../features/project/ProjectView.jsx'
import { Inbox } from '../features/inbox/Inbox.jsx'
import { Intro } from '../features/onboarding/Intro.jsx'
import { CommandPalette } from '../features/palette/CommandPalette.jsx'
import { ImportAppDialog } from '../features/app-share/ImportAppDialog.jsx'
import { UpdateLine } from '../features/settings/UpdateLine.jsx'
import { useAutoApplyUpdate } from '../features/settings/apply-update.js'
import { Notices } from '../features/notices/Notices.jsx'
import { HostRequestCards } from '../features/host-requests/HostRequestCards.jsx'
import { UsageDonuts } from '../features/usage/UsageDonuts.jsx'
import { DragRegion } from '../components/DragRegion.jsx'
import { IconButton } from '../components/IconButton.jsx'
import { Button } from '../components/Button.jsx'
import { InboxPill } from '../features/inbox/InboxPill.jsx'
import { WindowControls } from './WindowControls.jsx'
import { CloseIcon, GearIcon, StepIcon } from '../components/icons.jsx'
import { isOsFileDrag, markInternalDrags } from '../features/files/dragPath.js'
import { lazyComponent } from '../components/lazy.jsx'

/*
 * Not on the first frame for most launches, so it loads when first opened (components/lazy.tsx). The grid stays in the
 * startup bundle: its own code is ~6 KB, and drawn a frame late it would focus a composer after the hand had moved on.
 */
const Settings = lazyComponent(() => import('../features/settings/Settings.jsx').then((m) => m.Settings))

export function App({
  platform,
  banner,
}: {
  platform: Platform
  /** A line the shell has to say, between the top bar and the lanes (the keeper's "other build" bar, #280) */
  banner?: ReactNode
}) {
  const attach = useStore((s) => s.attach)
  const setAppFocused = useStore((s) => s.setAppFocused)

  useEffect(() => {
    void attach(platform)
  }, [platform, attach])

  // `centralu://app?url=…`: the import dialog reads nothing until Review, as someone else made the link
  useEffect(
    () =>
      platform.system.onAppLink((link) => {
        const parsed = parseAppLink(link)
        if (parsed.ok) useStore.getState().openImport(parsed.source, true)
        else useStore.getState().setToast(`Ignored a link Centralu cannot open: ${parsed.error}`)
      }),
    [platform],
  )

  // Held until the host's preferences arrive: the store's defaults would replace the cached theme with a dark flash
  const themeMode = useStore((s) => s.prefs.themeMode)
  const themeDark = useStore((s) => s.prefs.themeDark)
  const themeLight = useStore((s) => s.prefs.themeLight)
  const themeFiles = useStore((s) => s.themeFiles)
  const lastGoodThemes = useStore((s) => s.lastGoodThemes)
  const connected = useStore((s) => s.connection === 'connected')
  const [prefsArrived, setPrefsArrived] = useState(false)
  if (connected && !prefsArrived) setPrefsArrived(true)
  useEffect(() => {
    if (!prefsArrived) return
    const choice = resolveChoice(
      { ...useStore.getState().prefs, themeMode, themeDark, themeLight },
      usableThemeFiles({ themeFiles, lastGoodThemes }),
    )
    const theme = pickTheme(choice)
    applyTheme(theme)
    cacheChoice(choice)
    // The desktop window keeps the theme's side whatever the OS is set to, and paints its own strip in the floor
    void platform.system
      .setWindowAppearance(theme.base, getComputedStyle(document.body).backgroundColor)
      .catch(() => {})
  }, [
    prefsArrived,
    themeMode,
    themeDark,
    themeLight,
    themeFiles,
    lastGoodThemes,
    platform,
  ])

  // Held back for the theme's reason. The text size is one CSS zoom on the root: all text is in px, and zoom works
  // in both WKWebView and the browser
  const bodyFont = useStore((s) => s.prefs.bodyFont)
  const codeFont = useStore((s) => s.prefs.codeFont)
  const lineHeight = useStore((s) => s.prefs.lineHeight)
  const textSize = useStore((s) => s.prefs.textSize)
  useEffect(() => {
    if (!prefsArrived) return
    const typography = typographyOf({ bodyFont, codeFont, lineHeight, textSize })
    applyTypography(typography)
    cacheTypography(typography)
  }, [prefsArrived, bodyFont, codeFont, lineHeight, textSize])

  /*
   * Drag-and-drop is denied across the window (#116): with Tauri's `dragDropEnabled: false` a drop falls to the
   * webview, which navigates to the file. Capture, so nothing below stops it first; no conditions, as each hands its
   * other side back to the webview; `dragenter`/`dragover` too, as they answer "can it drop here". Only a floor: the
   * composer and the session panels still call preventDefault themselves.
   */
  useEffect(() => {
    // Text dragged over a text field is editing. A drag with a file from the OS is still blocked (`isOsFileDrag`, #286):
    // in WebKit, selected conversation text with a screenshot carries `Files` but is not one
    const editable = (target: EventTarget | null): boolean => {
      const el = target instanceof Element ? target : null
      return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')
    }
    const deny = (e: globalThis.DragEvent) => {
      if (editable(e.target) && !isOsFileDrag([...(e.dataTransfer?.types ?? [])])) return
      e.preventDefault()
    }
    const opts = { capture: true } as const
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      window.addEventListener(type, deny, opts)
    }
    return () => {
      for (const type of ['dragenter', 'dragover', 'drop'] as const) {
        window.removeEventListener(type, deny, opts)
      }
    }
  }, [])

  // So no drop target takes a drag that starts here for a file from the OS (INTERNAL_DRAG_MIME, #286)
  useEffect(() => markInternalDrags(window), [])

  useEffect(() => {
    // document.hasFocus() can still be stale at the moment of blur, so focus and blur pass the value already known
    const onFocus = () => setAppFocused(isForeground(true, document.visibilityState))
    const onBlur = () => setAppFocused(false)
    const onVisibility = () => setAppFocused(isForeground(document.hasFocus(), document.visibilityState))
    onVisibility()
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [setAppFocused])

  const settingsOpen = useStore((s) => s.settingsOpen)

  return (
    <PlatformProvider platform={platform}>
      {/*
        A render that throws leaves the window up: without a boundary React shows a blank white screen.
      */}
      <ErrorBoundary platform={platform}>
        {/* h-full, not h-screen (100vh) — vh does not know about zoom (--text-zoom comment in index.css) */}
        <div className="relative flex h-full flex-col bg-surface-floor text-ink">
          <TopBar />
          {/*
            In the flow below the top bar (#326): over the window its text would sit under the macOS traffic lights,
            and above the top bar the lights (pinned by trafficLightPosition) would land on it. It shifts the lanes,
            but only once per build mismatch, at one height (ShellBanner); over the lanes it would hide their tops.
          */}
          {banner}
          <Body />
          {/* A program's call waiting for the person (#1405): over the lanes, not in their flow */}
          <HostRequestCards />
          <CommandPalette />
          {/*
            Kept once opened: Settings remembers its category while closed
          */}
          <OnceOpened open={settingsOpen}>
            <Settings />
          </OnceOpened>
          <ImportAppDialog />
          <Gust />
          <KeptDraftCard />
          <Toast />
          <GlobalKeys />
          {/*
            The window's edge, over the frame: a border on it would push the top bar off the native controls' centre.
            Four strips, not one bordered box: a window-sized box over the composited scrollers gets a window-sized
            backing store (~22 MB of WebKit's GPU process, #2034). Borders, not 1px backgrounds, which at 1.5x can
            come out two device pixels thick.
          */}
          <div aria-hidden className="pointer-events-none absolute inset-0" data-testid="app-edge">
            <span className="absolute inset-x-0 top-0 border-t border-line" />
            <span className="absolute inset-x-0 bottom-0 border-t border-line" />
            <span className="absolute inset-y-0 left-0 border-l border-line" />
            <span className="absolute inset-y-0 right-0 border-l border-line" />
          </div>
        </div>
      </ErrorBoundary>
    </PlatformProvider>
  )
}

function OnceOpened({ open, children }: { open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened ? children : null
}

/**
 * The intro takes the center lane for a person who never created anything, an Assistant included (FR-19, #63). The
 * sidebar stays beside it, so Add project is reachable.
 */
function Body() {
  const intro = useStore(showsIntro)
  const view = useStore((s) => s.view)
  const zoom = useTextZoom()
  // The focus lane with a project picked and no session is that project's screen (#203)
  const projectScreen = useStore(projectScreenOf)
  const ready = useStore((s) => s.workspaceReady)

  // No screen until the last one is restored: any other would flash before it (owner, 2026-10-18)
  if (!ready) {
    return (
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="screen-waiting" />
      </div>
    )
  }

  if (intro) {
    return (
      <div className="relative flex min-h-0 flex-1">
        {/*
          Its view buttons move past the intro (setView and openAssistant set introSeen): the intro is never forced
        */}
        <Sidebar />
        <Notices />
        <div className="cc-fade relative flex min-h-0 min-w-0 flex-1">
          <Intro />
        </div>
      </div>
    )
  }
  // No evidence lane beside the grid (its panels would drop below their minimum width), the Assistant, or a pinned
  // app (its record panel stands beside it)
  const hasEvidenceLane = view !== 'assistant' && view !== 'grid' && view !== 'app'

  return (
    // relative here, not on the app: over the top bar a notice card would catch the approval banner's button
    <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      <Notices />
      {/*
        The overlay covers only this lane: the sidebar shows another session calling, and the evidence panel's tree
        is how the next file opens (#15).
      */}
      {/*
        min-w-0: else widening the panel scrolls the whole screen sideways.
      */}
      <div className="cc-fade relative flex min-h-0 min-w-0 flex-1" style={{ minWidth: CENTER_FLOOR / zoom }}>
        {view === 'assistant' ? (
          <AssistantView />
        ) : view === 'grid' ? (
          <GridView />
        ) : view === 'app' ? null : projectScreen ? (
          <ProjectView projectId={projectScreen} />
        ) : (
          <SessionView />
        )}
        {/*
          Pinned apps stay mounted here, only hidden: a detached iframe loses its document
        */}
        <PinnedApps />
        <Overlay />
      </div>
      {hasEvidenceLane && <EvidencePanel />}
    </div>
  )
}

/** `pr-4` on the right, and the floor of the left padding where no traffic lights take room */
const EDGE_PADDING = 16

/**
 * The dashboard: one count (user request, 2026-09-09; FR-12 asks for two), as each row of the list says its kind.
 * Brightness carries the urgency: ink-signal for an approval or an error, grey for waiting for input.
 */
function TopBar() {
  const counts = useCounts()
  // Always mounted, so auto-apply (#352) runs on every screen
  const autoApplyWaiting = useAutoApplyUpdate()
  const toggleInbox = useStore((s) => s.toggleInbox)

  // Asked, not assumed: a fixed `pl-[86px]` fits only macOS, whose traffic lights sit inside this bar
  const controlsInset = useCapability('windowControlsInset')
  const windowControls = useCapability('windowControls')
  const sc = useShortcut()
  /*
   * The only drag handle, as the title bar is hidden. The traffic lights are fit to the bar via `trafficLightPosition`
   * in tauri.conf.json: 36px bar, 12px button → y = 12. Change both together (tooling/styles.test.ts checks).
   */
  return (
    <DragRegion
      className="flex h-9 shrink-0 items-center gap-4 border-b border-line-chrome bg-surface-side pr-4 relative"
      style={{ paddingLeft: Math.max(controlsInset, EDGE_PADDING) }}
      testId="app-header"
    >
      <NavButtons />

      {/*
        The list drops below the button: where it is pressed is where it appears (#4)
      */}
      {/* flex, not inline — an inline span's box is a text line, so top-full lands wrong */}
      <span className="relative flex">
        <InboxPill counts={counts} onOpen={() => toggleInbox()} title={`Waiting (${sc('mod', 'I')})`} />
        <Inbox />
      </span>

      {/*
        No shortcut chips (#33): a hint read once would draw attention on every glance; the dashboard speaks state.
      */}
      {/*
        The middle is empty on purpose (owner, 2026-11-05) and drags the window.
      */}
      {/* data-tauri-drag-region: a double press on the gap inside this wrapper zooms the window, as on the bar itself */}
      <span className="ml-auto flex items-center gap-3 self-stretch" data-tauri-drag-region>
        {/*
          Only when a new version is available (#43): state, unlike a chip
        */}
        <UpdateLine waiting={autoApplyWaiting} />
        {/*
          One donut per tool; "Disconnected" stands in its place, "Connected" is never written
        */}
        <UsageDonuts />
        {/*
          Here too, not only in the palette: else only who knows the shortcuts finds the shortcuts table
        */}
        {/* A gear, not the word (owner, 2026-10-18): the one settings mark people already know; the name is its tooltip */}
        <IconButton
          label="Settings"
          onClick={() => useStore.getState().toggleSettings(true)}
          testId="open-settings"
          align="right"
        >
          {/* 20px, the usage donuts' size beside it */}
          <GearIcon size={20} />
        </IconButton>
        {/* Windows: the window's own controls, flush with the right edge, where the OS title bar was (WindowControls) */}
        {windowControls && <WindowControls />}
        {/*
          "Add project" is in the sidebar, where its result appears (#4)
        */}
      </span>
    </DragRegion>
  )
}

/** Disabled by the rules a step follows: docs/state-management.md §5a */
function NavButtons() {
  const canBack = useStore((s) => canStep(s.nav, -1, (x) => screenExists(s, x)))
  const canForward = useStore((s) => canStep(s.nav, 1, (x) => screenExists(s, x)))
  const nav = useNavShortcut()
  return (
    <span className="flex items-center gap-0.5">
      <IconButton
        label={`Back (${nav(-1)})`}
        onClick={() => useStore.getState().goBack()}
        disabled={!canBack}
        testId="nav-back"
      >
        <StepIcon dir={-1} />
      </IconButton>
      <IconButton
        label={`Forward (${nav(1)})`}
        onClick={() => useStore.getState().goForward()}
        disabled={!canForward}
        testId="nav-forward"
      >
        <StepIcon dir={1} />
      </IconButton>
    </span>
  )
}

/** The control loop must be operable without a mouse (FR-17) */
function GlobalKeys() {
  const toggleInbox = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)
  const openNextWaiting = useStore((s) => s.openNextWaiting)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTextEntry(e.target)
      const letter = letterOf(e)
      const mod = e.metaKey || e.ctrlKey
      // A dialog keeps the keyboard (#842 item 1); the open palette lets only ⌘K, which closes it, through
      const layers = useStore.getState()
      if (dialogOpen(layers)) return
      if (layers.paletteOpen && !(mod && letter === 'k')) return
      const dir = e.defaultPrevented ? null : navKeyOf(e)
      if (dir) {
        e.preventDefault()
        if (dir < 0) useStore.getState().goBack()
        else useStore.getState().goForward()
        return
      }
      // Command palette ⌘K (FR-17)
      if (mod && letter === 'k') {
        e.preventDefault()
        useStore.getState().togglePalette()
        return
      }
      if (mod && letter === 'i') {
        e.preventDefault()
        toggleInbox()
        return
      }
      // The next waiting item, in the inbox's order (core)
      if (mod && e.shiftKey && letter === 'a') {
        e.preventDefault()
        openNextWaiting()
        return
      }
      if (mod && letter === 'b') {
        e.preventDefault()
        useStore.getState().togglePanel()
        return
      }
      // From e.code: with Shift held, e.key is a symbol such as '#'
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
      if (mod && !e.shiftKey && digit) {
        const st = useStore.getState()
        const project = Object.values(st.projects)[Number(digit) - 1]
        if (project) {
          e.preventDefault()
          const first = Object.values(st.sessions).find((s) => s.projectId === project.id)
          if (first) focusSession(first.id)
        }
        return
      }
      if (!typing && e.key === 'Escape') toggleInbox(false)
    }
    // The global shortcut (⌘⇧A pressed outside the app) comes in through the same action
    const onExternalNext = openNextWaiting
    // Side buttons (docs/state-management.md §5a) act on release; the press is claimed too, so a browser running the
    // dev UI does not also step its own history. They work in a text field: a side button never edits text
    const claimSideButton = (e: MouseEvent) => {
      if (navButtonOf(e.button)) e.preventDefault()
    }
    const onSideButton = (e: MouseEvent) => {
      const dir = navButtonOf(e.button)
      if (!dir) return
      e.preventDefault()
      if (dir < 0) useStore.getState().goBack()
      else useStore.getState().goForward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', claimSideButton)
    window.addEventListener('mouseup', onSideButton)
    window.addEventListener('cc:next-waiting', onExternalNext)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', claimSideButton)
      window.removeEventListener('mouseup', onSideButton)
      window.removeEventListener('cc:next-waiting', onExternalNext)
    }
  }, [toggleInbox, focusSession, openNextWaiting])

  return null
}

function Toast() {
  const toast = useStore((s) => s.toast)
  // Every toast said, the same words again included: the timer restarts on each (#842 item 14)
  const toastAt = useStore((s) => s.toastAt)
  const action = useStore((s) => s.toastAction)
  const setToast = useStore((s) => s.setToast)
  // The pointer or the keyboard on it holds this toast (#1512), and only this one: pressing Undo or Dismiss removes the
  // element under the pointer, which then never says it left
  const [heldFor, setHeldFor] = useState<number | null>(null)
  const held = heldFor === toastAt
  useEffect(() => {
    if (!toast || held) return
    // A toast with an Undo stays long enough to be read and pressed (#1512); one that only says something goes sooner
    const t = setTimeout(() => setToast(null), action ? 8000 : 2500)
    return () => clearTimeout(t)
  }, [toast, toastAt, action, held, setToast])
  if (!toast) return null
  return (
    // z-30: the notice cards' tier, above the overlay (z-20), so a failure shows while a file or diff is open
    <div
      className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-surface-raised py-2 pl-3 pr-1.5 text-sm text-ink shadow-(--shadow-popover)"
      data-testid="toast"
      role="status"
      onMouseEnter={() => setHeldFor(toastAt)}
      onMouseLeave={() => setHeldFor(null)}
      onFocus={() => setHeldFor(toastAt)}
      onBlur={() => setHeldFor(null)}
    >
      <span>{toast}</span>
      {action && (
        <Button
          variant="subtle"
          size="sm"
          data-testid="toast-action"
          onClick={() => {
            // Put away first: a second press while the action runs must not run it twice
            setToast(null)
            action.run()
          }}
        >
          {action.label}
        </Button>
      )}
      {/* Gone before it was read is the toast's whole risk; one that is in the way can be put away (#842 item 14) */}
      <IconButton
        label="Dismiss"
        onClick={() => setToast(null)}
        testId="toast-dismiss"
        placement="top"
        align="right"
      >
        <CloseIcon size={11} />
      </IconButton>
    </div>
  )
}
