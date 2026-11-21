import type { AlertKind, SystemPort, WindowAction } from '../ports/index.js'
import { badgeCount } from '../capabilities.js'
import { deliver } from '../deliver.js'

/** The OS side the mock stands in for: notifications, the dock badge, pickers, the window and app links */
export class SystemMock {
  nextPickedDirectory: string | null = '/tmp/picked'
  /** Null: the person cancelled */
  nextPickedFile: string | null = '/tmp/picked.zip'
  /** As a shell refusing the dialog (#972) */
  pickFails: string | null = null
  readonly pickedFileAsks: { title: string; extensions: string[] }[] = []
  private readonly appLinkListeners = new Set<(link: string) => void>()
  /** Kept until taken, as Tauri's `take_app_links` (#424: WebKit starts the UI after e2e hands the link over) */
  private readonly pendingAppLinks: string[] = []
  /** Raw, unfiltered by the shell */
  openAppLink(link: string): void {
    if (this.appLinkListeners.size === 0) this.pendingAppLinks.push(link)
    deliver(this.appLinkListeners, link)
  }
  readonly notifications: { title: string; body: string }[] = []
  readonly opened: { path: string; line?: number }[] = []
  readonly openedUrls: string[] = []
  badge = 0
  windowActions: WindowAction[] = []
  readonly system: SystemPort = {
    notify: async (title: string, body: string) => {
      this.notifications.push({ title, body })
    },
    alert: async (kind: AlertKind, sound: boolean) => {
      this.alerts.push({ kind, sound })
    },
    setBadge: async (count: number) => {
      this.badge = badgeCount(count)
    },
    windowAction: async (action: WindowAction) => {
      this.windowActions.push(action)
    },
    openInIde: async (path: string, line?: number) => {
      this.opened.push({ path, line })
    },
    openUrl: async (url: string) => {
      this.openedUrls.push(url)
    },
    startWindowDrag: async () => {
      // So a test sees "tried to move a panel, but the window moved"
      this.windowDrags++
    },
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

  windowDrags = 0
  windowAppearance: { scheme: 'dark' | 'light' | null; background: string } | null = null

  /** It has to ring even if the banner is dead */
  alerts: { kind: AlertKind; sound: boolean }[] = []
}
