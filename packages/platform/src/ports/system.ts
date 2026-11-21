/** Decides how strong the sound and the dock bounce are */
export type AlertKind = 'approval' | 'error' | 'done' | 'all_done'

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close'

export interface SystemPort {
  notify(title: string, body: string): Promise<void>
  /**
   * Sound and the dock icon, apart from `notify`'s OS banner: the banner needs notification permission and code
   * signing and was measured dead on macOS, so this is what reaches a person who stepped away.
   */
  alert(kind: AlertKind, sound: boolean): Promise<void>
  setBadge(count: number): Promise<void>
  /** For the top bar's own controls where the OS draws none (`windowControls`); close asks the usual quit question */
  windowAction(action: WindowAction): Promise<void>
  openInIde(path: string, line?: number): Promise<void>
  /**
   * In the OS's default browser (#159): in WKWebView `window.open` opens nothing, as wry drops it silently without a
   * new-window handler. The caller checks http(s); the desktop also allows mailto, tel and VS Code Remote-SSH links
   * (`vscode://vscode-remote/ssh-remote+…`, #82; capabilities/default.json). Throws when it cannot open or refuses
   * the scheme.
   */
  openUrl(url: string): Promise<void>
  /** Native on desktop; web dev falls back to a path input (FR-19) */
  pickDirectory(): Promise<string | null>
  /** Native and filtered on desktop, a path input in web dev (M4 E-3). The host checks the path again */
  pickFile(opts: { title: string; extensions: string[] }): Promise<string | null>
  /**
   * `centralu://app?url=…` links from the OS (M4 E-4); one that launched the app is delivered once on subscribing.
   * Someone else's text: validate with `parseAppLink`. Never called where links are not received (web).
   */
  onAppLink(cb: (link: string) => void): () => void
  /**
   * The title bar is hidden. `data-tauri-drag-region` alone fails: it must be on the mousedown target itself, so
   * grabbing text in the header misses ("only works sometimes"). Nothing on the web.
   */
  startWindowDrag(): Promise<void>
  /**
   * `scheme` null follows the OS (#312): `prefers-color-scheme` reports a held window's appearance, so System mode sees
   * the OS only once the window is released. `background`: the computed floor color the window paints around the page
   * (first frame, a resize). Nothing on the web.
   */
  setWindowAppearance(scheme: 'dark' | 'light' | null, background: string): Promise<void>
}

/** docs/platform-abstraction.md §2: measurements and labels, never an OS name (`guard/ui-no-os` guards ui) */
export type PlatformCapabilities = {
  /** px at the left of the top bar: macOS puts the traffic lights inside the overlay title bar; others draw a strip */
  windowControlsInset: number
  /**
   * Handlers accept `metaKey || ctrlKey`, so only the labels differ; a symbol nobody's keyboard has says the app is not
   * for them. No `⇧`: every keyboard prints it.
   */
  shortcutKeys: ShortcutKeys
  /** "Finder" only on a Mac (#19); Linux has no one answer (Nautilus, Dolphin, Thunar…), so the generic phrase */
  fileManagerName: string
  /**
   * The top bar draws minimize, maximize and close at its right end (owner, 2026-10-18): on Windows the OS title bar is
   * off, so the top bar is the only strip, as on macOS.
   */
  windowControls: boolean
  /**
   * Runs on the computer's `centralu serve` host (desktop, Windows), kept for a hub linked to it (#1223): closing
   * leaves agents running with no background mode to switch; the quit question and Settings say so, and "Quit
   * completely" stops that host (#1466).
   */
  servesHost: boolean
  /**
   * Whether a frame's `dragend` is in the top page's coordinates (#308, app-frame/dragRelay.ts): WebKit reports the
   * frame's, per spec, Chromium (WebView2) the page's. `engine.ts` has the measurement.
   */
  frameDragEndInPage: boolean
}

/** `join` exists because a Mac runs `⌘⇧A` together, which elsewhere becomes `CtrlShiftA`: names need a separator */
export type ShortcutKeys = {
  mod: string
  alt: string
  join: string
}
