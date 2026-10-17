import type { AlertKind, SystemPort } from '../ports/index.js'

/** The OS side the mock stands in for: notifications, the dock badge, pickers, the window and app links */
export class SystemMock {
  /** For tests: the value the directory picker will return */
  nextPickedDirectory: string | null = '/tmp/picked'
  /** The value the file picker will return (M4 E-3 — the .zip to import). Null means the person cancelled */
  nextPickedFile: string | null = '/tmp/picked.zip'
  /** For tests: both pickers fail with this reason, as a shell refusing the dialog would (#972 item 2) */
  pickFails: string | null = null
  /** What the file picker was asked to filter by */
  readonly pickedFileAsks: { title: string; extensions: string[] }[] = []
  /** The side that listens for app links (M4 E-4) — `openAppLink` hands one over like the OS would */
  private readonly appLinkListeners = new Set<(link: string) => void>()
  /**
   * Links handed over before anyone listened. The Tauri shell keeps these until the window takes
   * them (`take_app_links`), so a link that arrives while the UI is still starting is not lost; the
   * mock does the same (#424: WebKit starts the UI later than the e2e handed the link over).
   */
  private readonly pendingAppLinks: string[] = []
  /** As if the OS handed this app a link (M4 E-4, called by e2e) — passes it through raw, unfiltered by the shell */
  openAppLink(link: string): void {
    if (this.appLinkListeners.size === 0) this.pendingAppLinks.push(link)
    for (const l of this.appLinkListeners) l(link)
  }
  readonly notifications: { title: string; body: string }[] = []
  readonly opened: { path: string; line?: number }[] = []
  /** Addresses opened in the outside browser (#159) — tests check that terminal and app-screen links pass through this door */
  readonly openedUrls: string[] = []
  badge = 0
  readonly system: SystemPort = {
    notify: async (title: string, body: string) => {
      this.notifications.push({ title, body })
    },
    alert: async (kind: AlertKind, sound: boolean) => {
      this.alerts.push({ kind, sound })
    },
    setBadge: async (count: number) => {
      this.badge = count
    },
    openInIde: async (path: string, line?: number) => {
      this.opened.push({ path, line })
    },
    openUrl: async (url: string) => {
      this.openedUrls.push(url)
    },
    startWindowDrag: async () => {
      // The number of times the window drag started — a test needs to be able to see "tried to move a panel, but the app window moved instead"
      this.windowDrags++
    },
    // The last appearance the screen asked the window for, so a test can see what the desktop window would be told
    setWindowAppearance: async (scheme, background) => {
      this.windowAppearance = { scheme, background }
    },
    pickDirectory: async () => {
      if (this.pickFails) throw new Error(this.pickFails)
      return this.nextPickedDirectory
    },
    pickFile: async (opts: { title: string; extensions: string[] }) => {
      this.pickedFileAsks.push(opts)
      if (this.pickFails) throw new Error(this.pickFails)
      return this.nextPickedFile
    },
    onAppLink: (cb: (link: string) => void) => {
      this.appLinkListeners.add(cb)
      for (const link of this.pendingAppLinks.splice(0)) cb(link)
      return () => void this.appLinkListeners.delete(cb)
    },
  }

  /** How many times a window drag started (checked from Playwright) */
  windowDrags = 0
  /** What `setWindowAppearance` was last told — null until the screen has said anything */
  windowAppearance: { scheme: 'dark' | 'light' | null; background: string } | null = null

  /** The record of calls made with sound and the dock — this one has to ring even if the banner is dead */
  alerts: { kind: AlertKind; sound: boolean }[] = []
}
