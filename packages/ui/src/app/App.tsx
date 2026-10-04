import { useEffect } from 'react'
import { nextWaitingSession } from '@cc/core'
import { parseAppLink } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider, useCapability } from './PlatformProvider.jsx'
import { useShortcut } from './shortcut.js'
import { letterOf } from './keys.js'
import { isForeground } from './foreground.js'
import { Gust } from './Gust.jsx'
import { ErrorBoundary } from './ErrorBoundary.jsx'
import { TEXT_SCALES, projectScreenOf, useStore } from '../store/store.js'
import { useCounts, computeInbox } from '../store/selectors.js'
import { Sidebar } from '../features/sidebar/Sidebar.jsx'
import { EvidencePanel } from '../features/evidence/EvidencePanel.jsx'
import { Overlay } from '../features/evidence/Overlay.jsx'
import { SessionView } from '../features/session/SessionView.jsx'
import { GridView } from '../features/grid/GridView.jsx'
import { OrchestratorView } from '../features/orchestrator/OrchestratorView.jsx'
import { PinnedApps } from '../features/pinned-app/PinnedApps.jsx'
import { ProjectView } from '../features/project/ProjectView.jsx'
import { Inbox } from '../features/inbox/Inbox.jsx'
import { Intro } from '../features/onboarding/Intro.jsx'
import { CommandPalette } from '../features/palette/CommandPalette.jsx'
import { Settings } from '../features/settings/Settings.jsx'
import { ImportAppDialog } from '../features/app-share/ImportAppDialog.jsx'
import { UpdateLine } from '../features/settings/UpdateLine.jsx'
import { Notices } from '../features/notices/Notices.jsx'
import { UsageDonuts } from '../features/usage/UsageDonuts.jsx'
import { DragRegion } from '../components/DragRegion.jsx'
import { isOsFileDrag, markInternalDrags } from '../features/files/dragPath.js'
import { attachAppHost } from '../apps/host.js'
import { storeAppHost } from '../store/app-host.js'

/*
 * Attach the host to the app runtime (#97) — module scope, so this runs before the first render.
 *
 * Every app (rail, settings, dedicated screens) is rendered somewhere below this file, so
 * attaching the host here once means it is standing before any app stands, no matter which
 * entry point (desktop, web) the person came in through. Attaching it inside an effect would
 * mean the first render meets an empty host.
 */
attachAppHost(storeAppHost)

export function App({ platform }: { platform: Platform }) {
  const attach = useStore((s) => s.attach)
  const setAppFocused = useStore((s) => s.setAppFocused)

  useEffect(() => {
    void attach(platform)
  }, [platform, attach])

  /*
   * App link (M4 E-4) — the OS hands over `centralu://app?url=…`. If the shape is right, open the
   * import dialog to that source. The dialog reads or downloads nothing until the person presses
   * Review: the person clicked the link, but someone else made it. A malformed link says in one
   * line what is wrong and opens nothing.
   */
  useEffect(
    () =>
      platform.system.onAppLink((link) => {
        const parsed = parseAppLink(link)
        if (parsed.ok) useStore.getState().openImport(parsed.source, true)
        else useStore.getState().setToast(`Ignored a link Centralu cannot open: ${parsed.error}`)
      }),
    [platform],
  )

  /*
   * Overall text size (Settings → Appearance, 5 levels).
   *
   * Applied with a single CSS zoom on the root — all text is pinned in px, so there is no way to
   * grow just the font (see the TEXT_SCALES comment in the store), and zoom works in both
   * WKWebView (Tauri) and the browser.
   */
  const textScale = useStore((s) => s.textScale)
  useEffect(() => {
    const factor = TEXT_SCALES[textScale] ?? 1
    const style = document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    style.zoom = String(factor)
    /*
     * vh/vw are not affected by zoom (measured: zooming in made the 100vh shell overflow the
     * window and cut off the composer). The shell was switched to a chain of %, and the vh/vw in
     * modals are divided by this variable to bring them back to the real window size — zoom and
     * this variable must always be the same value, so they are set together in one place.
     */
    style.setProperty('--text-zoom', String(factor))
  }, [textScale])

  /*
   * Where the spinning indicator gets stopped (user request, 2026-09-13).
   *
   * Export the switch as an attribute on the root, and let CSS do the actual stopping. There are
   * two places where something spins today (the grid panel border, the sidebar icon) and there
   * could be more later; if each place read the setting itself, every new spinning element would
   * have to remember this setting. Writing it once on the root means it applies even if it is
   * forgotten.
   *
   * Why this setting is about battery life rather than taste, with measurements, is in the
   * `spinGrid` comment in store.ts.
   */
  const spinGrid = useStore((s) => s.spinGrid)
  const spinSessionIcon = useStore((s) => s.spinSessionIcon)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.spinGrid = spinGrid ? 'on' : 'off'
    root.dataset.spinIcon = spinSessionIcon ? 'on' : 'off'
  }, [spinGrid, spinSessionIcon])

  // The notification policy is "do not notify while the app is in front of the person", so track
  // focus state
  /*
   * Drag-and-drop is denied by default across the whole window (#116).
   *
   * Tauri has `dragDropEnabled: false`, so a drop falls through to the webview's default
   * behavior — it navigates to the dropped file. A single PDF fills the entire window, and the
   * only way back is the browser's back button (and only for someone who knows one exists).
   *
   * So this lays down a floor: the browser never gets to decide anything on its own in this
   * window. If something happens, our handler did it.
   *
   * This is in the capture phase and has no conditions. Adding even one condition — the kind of
   * drag, the element underneath, whether there is a handler that accepts it — turns the other
   * side of that condition into the next round of this bug. That is exactly what happened before:
   * the composer blocked its own spot, and the rest of the window still belonged to the webview.
   * It is capture for the same reason — even if something below calls stopPropagation, the floor
   * has to be laid down first.
   *
   * All three are blocked. `drop` alone is not enough: `dragover` is the answer to "can something
   * be dropped here", and without blocking it the browser takes that decision for itself.
   * `dragenter` answers the same question.
   *
   * This is only the floor. The composer and the session panels still call preventDefault in
   * their own places — if a feature's correctness hangs on one global line, the feature dies
   * quietly the day that line moves.
   */
  useEffect(() => {
    /*
     * There is exactly one exception, and it is narrow: text dragged over a text field.
     *
     * That is an editing action, not the browser replacing the app — blocking even dropping
     * selected text into a search box or a settings field would mean the floor built for files
     * sweeps away text too. A drag that includes a file is still blocked over a text field.
     * Dropping a PDF into a search box is also a way for the webview to open a file, and closing
     * that path is the whole point of this floor.
     *
     * "A file" means one from outside the app (`isOsFileDrag`, #286). Selected conversation text
     * with a screenshot in it can carry `Files` in WebKit, but it started in this window: it is
     * the same editing action as plain text, not a file for the webview to open.
     */
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

  // Every drag that starts in this window is marked as ours, so no drop target takes it for a
  // file from the OS — see INTERNAL_DRAG_MIME (#286)
  useEffect(() => markInternalDrags(window), [])

  useEffect(() => {
    /*
       All three handlers use the same judgment.
       Previously only visibilitychange looked at visibility — after switching to another app, if
       another occlusion event fired, the window was still 'visible' so it went back to being 'in
       front' again, and from that point notifications were silently suppressed. Notifying the
       person while they are away is exactly what this app is supposed to do.
     */
    // document.hasFocus() can still be stale at the moment of blur, so pass the value we already
    // know directly
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

  return (
    <PlatformProvider platform={platform}>
      {/*
        The window survives even if a render throws (dogfooding, 2026-09-07). Without a boundary,
        React tears down the whole tree and leaves a blank white screen, and that screen is
        indistinguishable from "the app is dead".
      */}
      <ErrorBoundary>
        {/* h-full, not h-screen (100vh) — vh does not know about zoom (--text-zoom comment in index.css) */}
        <div className="relative flex h-full flex-col bg-surface-floor text-ink">
          <TopBar />
          <Body />
          <CommandPalette />
          <Settings />
          <ImportAppDialog />
          <Gust />
          <Toast />
          <GlobalKeys />
        </div>
      </ErrorBoundary>
    </PlatformProvider>
  )
}

/**
 * For a first-time person, the intro takes the place of the center lane (FR-19 → #63).
 *
 * The condition is not "zero projects" but "has never created anything" — if there is even
 * one session (including an orchestrator), this person is not first-time, and showing the intro
 * again would only get in the way.
 *
 * The sidebar stands alongside it. While the intro used to cover the whole screen, Add project
 * was not on screen, so a person reading the intro had no way to create a project — the screen
 * was breaking this flow's own premise of not forcing a conversation (caught by dogfooding).
 * Only the evidence lane is missing: there is no project or session yet to look at.
 */
function Body() {
  const virgin = useStore((s) => Object.keys(s.projects).length === 0 && Object.keys(s.sessions).length === 0)
  const introSeen = useStore((s) => s.introSeen)
  // Hooks come before any early return — placing one after the intro branch below would change
  // the hook count between renders
  const view = useStore((s) => s.view)
  // The focus lane with a project picked and no session is that project's screen (#203)
  const projectScreen = useStore(projectScreenOf)

  if (virgin && !introSeen) {
    return (
      <div className="relative flex min-h-0 flex-1">
        {/*
          The sidebar stays fully visible as-is. It was once built with the view-switch buttons
          removed — the reasoning was that pressing them while the intro held the center would
          not change the screen, so the click would be dead. That diagnosis was right but the fix
          was wrong: instead of hiding the buttons, make them work. Now pressing either the
          orchestrator or the grid button moves past the intro to that screen (setView and
          openOrchestrator in the store set introSeen).

          Not forcing a flow is this onboarding's premise. Removing the path for a person who
          wants to skip the intro and start using the app right away would mean forcing "read the
          intro" instead of the conversation we said we would not force.
        */}
        <Sidebar />
        <Notices />
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <Intro />
        </div>
      </div>
    )
  }
  /*
    Three lanes. Left = observe, center = act, right = evidence.
    The overlay covers the middle lane only — see the note below.
  */

  /*
    The grid and the orchestrator have no evidence lane. The grid already splits the screen;
    taking one more lane out of it drops the panel below its minimum width, which reproduces
    by our own hand the very thing that got the grid shelved (§5.4).
  */
  /*
    Pinned screens (M4 B-2) also have no evidence lane. The app takes up the whole area, and the
    app's own record panel stands beside it. Adding one more lane there would shrink the screen
    down to sidebar width.
  */
  const hasEvidenceLane = view !== 'orchestrator' && view !== 'grid' && view !== 'app'

  return (
    // relative: the notice cards need to float inside this. Applying it to the whole app would
    // cover the top bar and the approval banner, so the card would intercept the banner's button
    // (e2e caught this as a blocked click).
    <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      <Notices />
      {/*
        The overlay is confined to this lane, and that is why it lives inside this div
        rather than beside it. Covering the left lane would mean missing another session
        calling for me while I read code — blinding the instruments in the control tower.
        Covering the right lane turned out to be just as bad in a quieter way.

        It used to cover the right lane too, on the grounds that "340px can't hold a diff".
        That is a true sentence and the wrong conclusion: it answers why the overlay is not
        rendered *inside* the panel, not why it should *hide* the panel. The overlay is not
        competing with the panel for width — it is competing with the conversation. What
        the panel holds is the file tree and the change list, which is how you open the
        next file, so the loop people were left with was: click a file, watch the tree
        disappear, press escape, click the next one (issue #15). The diff does get ~340px
        narrower; it is unified, not side-by-side, so that costs line width and not a
        column, and the tree stays where your hand already is.
      */}
      {/*
        Without min-w-0, this lane cannot shrink below the min-content width of its contents.
        Then widening the panel pushes the layout past the window edge and the whole screen
        scrolls horizontally (the real cause of a bug found in dogfooding).
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {view === 'orchestrator' ? (
          <OrchestratorView />
        ) : view === 'grid' ? (
          <GridView />
        ) : view === 'app' ? null : projectScreen ? (
          <ProjectView projectId={projectScreen} />
        ) : (
          <SessionView />
        )}
        {/*
          Pinned screens (M4 B-2) are always rendered in this spot, and when viewing something
          else they are only hidden. An iframe loses its document the moment it is detached from
          the DOM. Detaching it would mean the app comes up from scratch every time the person
          goes to a session and comes back.
        */}
        <PinnedApps />
        <Overlay />
      </div>
      {hasEvidenceLane && <EvidencePanel />}
    </div>
  )
}

/**
 * Top bar = the dashboard.
 *
 * There is one number (user request, 2026-09-09). FR-12 said not to sum approvals and
 * waiting-for-input, and that held for a long time, but dogfooding showed that the decision to
 * tell the two apart never actually happened at the top bar: either way, the answer was "open the
 * list and work through it one by one", and the kind is already written on each row of the list.
 * Keeping the two separate on the dashboard just made the reader do the addition in their head
 * every time.
 *
 * Instead, brightness carries the urgency: pure white (ink-signal) if there is even one approval or
 * error, gray if only waiting-for-input. The rule that pure white is reserved for whatever is
 * blocking me still holds.
 */
/** The bar's edge margin. Same value as `pr-4` on the right, and also the floor for the left padding */
const EDGE_PADDING = 16

function TopBar() {
  const counts = useCounts()
  const toggleInbox = useStore((s) => s.toggleInbox)

  // Leave room in the top-left if the window buttons occupy it. Since the title bar is hidden,
  // this header is the only drag handle —
  //
  // How much to leave is a platform fact, so we ask instead of assuming. It was
  // `pl-[86px]`, which is right on macOS (the traffic lights sit inside this bar) and
  // wrong everywhere else: on desktops that draw their own decorations above us, the
  // same padding is just a hole at the left edge with nothing in it.
  const controlsInset = useCapability('windowControlsInset')
  const sc = useShortcut()
  /*
   * Top bar.
   *
   * Without data-tauri-drag-region, the window cannot be moved (caught in dogfooding).
   *
   * Aligned on the same axis as the traffic lights. It was first fitted by shrinking the bar
   * down to title-bar height (28px), which made the bar too thin. Since we control the traffic
   * light position ourselves through `trafficLightPosition` in tauri.conf.json, the bar height is
   * now decided first and the buttons are fit to it — the window decoration does not get to
   * dictate the height the screen needs.
   *
   *   bar height 36px, button diameter 12px → y = (36 - 12) / 2 = 12
   *
   * The two must move together. If the bar height changes, fix the y in tauri.conf.json too
   * (tooling/styles.test.ts checks that relationship).
   */
  return (
    <DragRegion
      className="flex h-9 shrink-0 items-center gap-4 border-b border-line bg-surface-side pr-4"
      /*
       * Inset is 0 wherever there are no traffic lights (web and mock report it that way —
       * correct, since there is no button to make room for). But using it as-is would remove the
       * left margin entirely and the name would sit flush against the window corner. The right
       * side has pr-4 while the left had nothing, so the bar looked lopsided (caught in
       * dogfooding). So there is a floor: make room for whatever there is to make room for, and
       * otherwise use the same margin as the other corners.
       */
      style={{ paddingLeft: Math.max(controlsInset, EDGE_PADDING) }}
      testId="app-header"
    >
      <span
        /*
         * No tracking at all — the name is set like ordinary text.
         *
         * It went 0.16em (wider than anything else on screen) → 0.12em, the app's uppercase
         * label tracking → 0.06em → none, and every step read better than the one before.
         * That direction is the answer: this is a name, not a label. A label is scanned
         * letter by letter and tracking is what pays for that; a name is taken in as one
         * shape, and this one is read least of anything here — you already opened the app.
         * Set flush it stops being spelled out and just sits there being the title.
         */
        className="pointer-events-none text-sm font-semibold text-ink"
        data-testid="app-title"
      >
        CENTRALU
      </span>

      {/*
        The list drops down directly below this button (user request, 2026-09-09). While it was a
        modal in the center of the screen, the place pressed and the place it opened were far
        apart, so the one action of seeing the number and opening the list made the eye move
        twice. Where something is pressed and where it appears must be the same place (the rule
        from #4).
      */}
      {/* flex, not inline — an inline span's box is a text line, so top-full lands wrong */}
      <span className="relative flex">
        <button
          className="group flex items-center gap-2.5 rounded-md px-2 py-0.5 transition-colors hover:bg-surface-hover/50"
          onClick={() => toggleInbox()}
          data-testid="counter"
          title={`Waiting (${sc('mod', 'I')})`}
        >
          <Metric
            label="Waiting for input"
            value={counts.approval + counts.input + counts.error}
            tone={
              counts.approval + counts.error > 0 ? 'signal'
              : counts.input > 0 ? 'text-ink-muted'
              : 'text-ink-faint'
            }
            testId="count-waiting"
          />
        </button>
        <Inbox />
      </span>

      {/*
        The shortcut chips (⌘I · ⌘⇧A) are not here (issue #33).

        They sat beside the count and brightened with it, so at the one moment the bar has
        something to say — something is waiting — two of the three bright things were
        instructions. A shortcut hint is worth reading once and then never again, but a chip
        on the dashboard charges attention on every glance, forever. The dashboard is the place
        that speaks state.

        Brightening stays the number's job. The chip's on-condition was just `waiting > 0`, while
        the number already has its own brightness by kind (ink-signal for approvals, ink-muted for
        waiting-for-input) — a more accurate signal was already there, and the chip was just
        riding along with it.

        Where they went: named with their keys in Settings → Shortcuts, and runnable from
        the command palette (⌘K). Deleting the only visible mention was the failure to avoid,
        so the palette gained both entries in the same change.
      */}
      <span className="ml-auto flex items-center gap-3">
        {/*
          "A new version is available" — a line that appears only when there is one (issue #43).

          This puts something back in the spot the shortcut chips were removed from (comment
          above), but with the opposite character: the chip stayed on all the time and stopped
          telling anything after the first time it was seen, while this line is normally absent
          entirely and only appears when the dashboard has something to say. And this too is
          state — "this app is not up to date right now" is a question the dashboard should be
          able to answer.
        */}
        <UpdateLine />
        {/*
          Usage is one donut per tool, not a text button (user request, 2026-09-09). The dashboard
          is a place where the answer should already be there before anyone asks, and the detail
          drops down below that donut.

          This one spot also doubles as connection status: if there is no host, there is no way
          to reach the agent at all, so "Disconnected" stands in place of the donut. "Connected"
          is not written — normal should stay quiet.
        */}
        <UsageDonuts />
        {/*
          Settings used to have exactly one entrance: the command palette. But the shortcuts
          table lives inside it — meaning only someone who already knew the shortcuts could see
          the shortcuts table. Dogfooding surfaced this as "where are the settings?". Not forcing
          a flow is different from hiding the entrance.
        */}
        <button
          className="rounded-md px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-hover/50 hover:text-ink"
          onClick={() => useStore.getState().toggleSettings(true)}
          data-testid="open-settings"
          title="Settings (shortcuts · notifications · approval rules)"
        >
          Settings
        </button>
        {/*
          "Add project" used to be here. It moved to the bottom of the sidebar (issue #4) — the
          place pressed (far right of the screen) and the place the result appeared (the sidebar
          on the left) were apart, across the whole screen. The top bar is a dashboard, and a
          button that creates something standing next to the numbers mixes reading and doing into
          one row.
        */}
      </span>
    </DragRegion>
  )
}

function Metric({
  label,
  value,
  tone,
  testId,
}: {
  label: string
  value: number
  tone: string
  testId: string
}) {
  return (
    <span className={`flex items-baseline gap-1.5 ${tone}`} data-testid={testId}>
      {/*
        The glow belongs to the number (user's observation, 2026-09-12: "it looks smeared").

        `signal` sets both a color and `text-shadow: 0 0 6px var(--color-signal-glow)`. The color
        gets overridden here by text-ink-faint, but the shadow is inherited — so the #5c5c5c label
        text was wearing a white glow. A bright halo on dark text does not look luminous, it looks
        out of focus. A glow is only a glow on pure white text.

        Since the label sits out of the brightness competition (always ink-faint), only the
        inheritance is cut off.
      */}
      <span className="text-2xs text-ink-faint [text-shadow:none]">{label}</span>
      <span className="readout text-md leading-none">{String(value).padStart(2, '0')}</span>
    </span>
  )
}

/** The control loop must be operable without a mouse (FR-17) */
function GlobalKeys() {
  const toggleInbox = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'
      /*
        Letters get their meaning asked for the same reason as digits (app/keys.ts). The digit
        comment below says "e.key becomes a symbol when Shift is held", and the same thing
        happens with letters — on a Korean keyboard layout, k comes through as ㅏ even with no
        modifier key. A letter that arrives as Latin is trusted as-is, and only checked by
        position otherwise.
      */
      const letter = letterOf(e)
      // Command palette ⌘K (FR-17)
      if ((e.metaKey || e.ctrlKey) && letter === 'k') {
        e.preventDefault()
        useStore.getState().togglePalette()
        return
      }
      if ((e.metaKey || e.ctrlKey) && letter === 'i') {
        e.preventDefault()
        toggleInbox()
        return
      }
      // Jump to the next waiting item: approval → error → waiting-for-input, in that order
      // (sorting lives in core)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && letter === 'a') {
        e.preventDefault()
        const st = useStore.getState()
        const next = nextWaitingSession(computeInbox(st), st.focusedSessionId)
        if (next) focusSession(next)
        return
      }
      // Toggle the evidence panel ⌘B — replaces tab switching (⌘⇧1-4).
      // Git and files are not a screen that replaces the conversation, they sit alongside it.
      if ((e.metaKey || e.ctrlKey) && letter === 'b') {
        e.preventDefault()
        useStore.getState().togglePanel()
        return
      }
      // Digit shortcuts are read from e.code — e.key turns into a symbol like '#' when Shift is
      // held (caught by e2e)
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
      // Jump to project ⌘1-9 (FR-17)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && digit) {
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
    const onExternalNext = () => {
      const st = useStore.getState()
      const next = nextWaitingSession(computeInbox(st), st.focusedSessionId)
      if (next) focusSession(next)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('cc:next-waiting', onExternalNext)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('cc:next-waiting', onExternalNext)
    }
  }, [toggleInbox, focusSession])

  return null
}

function Toast() {
  const toast = useStore((s) => s.toast)
  const setToast = useStore((s) => s.setToast)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast, setToast])
  if (!toast) return null
  return (
    /*
      z-30 — the same tier as the notice cards, and above the overlay (z-20).

      Without it this is an opaque pill painted *underneath* the wide surface, so every
      failure reported while a file or a diff is open said nothing at all. That is the one
      state where the toast matters most: the overlay covers the lane the pill sits in, and
      what it covers up is the app's whole answer to "that didn't work".
    */
    <div
      className="absolute bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink shadow-(--shadow-popover)"
      data-testid="toast"
      role="status"
    >
      {toast}
    </div>
  )
}
