/** What it is calling about — this decides how strong the sound and the dock bounce are */
export type AlertKind = 'approval' | 'error' | 'done' | 'all_done'

export interface SystemPort {
  notify(title: string, body: string): Promise<void>
  /**
   * Calls out with sound and the dock icon.
   *
   * Kept separate from `notify` (the OS banner) because **the delivery path is different**.
   * The banner depends on notification permission and code signing, while this one depends
   * on neither. Since we measured the banner path being dead on macOS, this is the one that
   * actually reaches a person who has stepped away.
   */
  alert(kind: AlertKind, sound: boolean): Promise<void>
  setBadge(count: number): Promise<void>
  openInIde(path: string, line?: number): Promise<void>
  /**
   * Opens an http(s) address in the OS's default browser (#159). Used by terminal links and
   * links in app screens. Also VS Code's Remote-SSH links (`vscode://vscode-remote/ssh-remote+…`), which open a
   * linked machine's project in VS Code (#82); the desktop app allows that one scheme besides http(s), mailto and tel
   * (capabilities/default.json).
   *
   * Why this is not just `window.open` at every call site: in the desktop webview
   * (WKWebView), that opens nothing. Without a new-window handler, wry drops the request, and
   * no error is raised either. The address check (http(s) only) has already been done by the
   * caller. Throws if it cannot open, or if the desktop app refuses the scheme.
   */
  openUrl(url: string): Promise<void>
  /** Directory picker. Desktop uses the native picker; web dev falls back to a path input (FR-19) */
  pickDirectory(): Promise<string | null>
  /**
   * Picks a single file (M4 E-3 — the .zip to import). Desktop uses the native picker
   * (filtered by extension); web dev falls back to a path input.
   * The host re-validates the chosen path — the picker's filtering is a convenience only.
   */
  pickFile(opts: { title: string; extensions: string[] }): Promise<string | null>
  /**
   * Listens for an app link (`centralu://app?url=…`, M4 E-4) the OS handed this app. If the
   * app was first launched by a link, that already-arrived link is also delivered once, right
   * at the moment of subscribing. A link is text written by someone else, so the receiver
   * validates it (`parseAppLink`). An implementation that does not receive links (web) never
   * calls this.
   * @returns unsubscribes
   */
  onAppLink(cb: (link: string) => void): () => void
  /**
   * Starts dragging the window from here (since we hid the title bar, we have to build our
   * own handle).
   * `data-tauri-drag-region` alone is not enough — that attribute has to be on the
   * **mousedown target itself**, so grabbing text inside the header breaks it. In practice
   * this showed up as "only works sometimes".
   * Does nothing on the web.
   */
  startWindowDrag(): Promise<void>
  /**
   * Tells the window which side of the theme is showing (#312).
   *
   * `scheme` is `null` to follow the OS. It is what the webview's `prefers-color-scheme`
   * answers with: a window held to one appearance reports that appearance to the page, so
   * System mode can only see the OS once the window stops being held. `background` is the
   * floor colour as a computed CSS colour, for the strip the window paints before or around the
   * page (the first frame, a resize).
   *
   * Does nothing on the web, where the browser already follows the OS.
   */
  setWindowAppearance(scheme: 'dark' | 'light' | null, background: string): Promise<void>
}

export type PlatformCapabilities = {
  osNotifications: boolean
  dockBadge: boolean
  globalShortcuts: boolean
  processSupervision: boolean
  openInIde: boolean
  /**
   * How many px the OS window controls occupy at the left edge of our own top bar.
   *
   * macOS puts the traffic lights *inside* the overlay title bar, so our bar has to
   * leave a hole for them; other desktops draw their decorations in a separate strip
   * and the bar owns the full width. This used to be a hardcoded `pl-[86px]` in the
   * header, which is the exact shape of leak this package exists to prevent: the number
   * is a fact about the window manager, not about the design. Asking for a width rather
   * than an OS name keeps ui free of platform checks.
   */
  windowControlsInset: number
  /**
   * What this machine's keyboard prints on the modifier keys we put on screen.
   *
   * Every shortcut handler already accepts `metaKey || ctrlKey`, so the keys have always
   * worked on Linux and Windows — only the labels lied, and they lied in 61 places because
   * `⌘` was written out at every call site. A symbol nobody's keyboard has is worse than
   * no hint at all: it tells you the app is not for you.
   *
   * Asking for the *labels* rather than for an OS name is the same trade as
   * `windowControlsInset` above, for the same reason: ui is the one package with no
   * platform implementation behind it, so an OS check there is invisible to every test we
   * run (`tooling/styles.test.ts` fails the build if one appears).
   *
   * `⇧` is deliberately absent — it is printed on those keyboards too, so there is nothing
   * to translate and no reason to make the port carry it.
   */
  shortcutKeys: ShortcutKeys
  /**
   * What this desktop calls the thing that shows you a file in a folder (#19).
   *
   * Same trade as `shortcutKeys` above: "Reveal in Finder" is the phrase everyone knows on
   * a Mac and a lie everywhere else, and ui is not allowed to ask which OS it is on — so it
   * asks for the *word* and prints it. Linux has no single answer (Nautilus, Dolphin,
   * Thunar…), so the generic phrase is the honest one there rather than a guess.
   */
  fileManagerName: string
  /**
   * Whether a frame's `dragend` reports where the drag ended in the top page's coordinates rather
   * than the frame's own (#308). The UI places an item dragged out of an app view by that point
   * (app-frame/dragRelay.ts), and the engines disagree: WebKit reports the frame's coordinates, as
   * the spec has it, Chromium (WebView2 on Windows) the page's. An engine fact, asked for here for
   * the same reason as the keyboard above: ui does not look at what it runs on (`engine.ts` has the
   * measurement).
   */
  frameDragEndInPage: boolean
}

/**
 * What the keyboard calls the two modifier keys, and what goes between them when a
 * combination is written as one chunk.
 *
 * Why `join` exists: a Mac writes them run together, like `⌘⇧A`, but carrying that rule over
 * as-is turns into `CtrlShiftA` on other keyboards. Running them together read fine only
 * because they were symbols; the moment they become names, a separator is needed — so the
 * side that knows the keyboard answers with it too.
 */
export type ShortcutKeys = {
  /** `⌘` here, `Ctrl` where there is no command key */
  mod: string
  /** `⌥` here, `Alt` elsewhere */
  alt: string
  /** What goes between keys when a combination is written as one string */
  join: string
}
