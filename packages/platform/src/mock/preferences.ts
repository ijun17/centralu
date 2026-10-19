import type { UiPreferences, UiPreferencesPatch } from '@cc/protocol'
import { parseUiPreferences, readNotifyPolicy, textSizeFromLegacyStep } from '@cc/protocol'
import type { PreferencesPort, WorkspaceSnapshot } from '../ports/index.js'
import type { Emit } from './event-bus.js'

/** The workspace snapshot and the screen preferences, both kept in localStorage when the page has one */
export class PreferencesMock {
  constructor(private readonly emit: Emit) {}

  /** Public so tests can look inside */
  workspaceSnapshot: WorkspaceSnapshot | null = null

  /**
   * The snapshot also survives a reload through localStorage when the page has one
   * (issue #20). The real host keeps it on disk, so "the arrangement survives a
   * relaunch" is only testable against this mock if the mock's snapshot outlives the
   * page too. Unit tests run in node, where touching `localStorage` throws — the
   * try/catch keeps the in-memory field serving them alone, exactly as before.
   */
  readonly workspace = {
    save: async (s: WorkspaceSnapshot) => {
      this.workspaceSnapshot = s
      try {
        localStorage.setItem('cc-mock-workspace', JSON.stringify(s))
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
    },
    load: async (): Promise<WorkspaceSnapshot | null> => {
      if (this.workspaceSnapshot) return this.workspaceSnapshot
      try {
        const raw = localStorage.getItem('cc-mock-workspace')
        return raw ? (JSON.parse(raw) as WorkspaceSnapshot) : null
      } catch {
        return null
      }
    },
  }

  /** Public so tests can look inside — and set it up without going through the port */
  uiPrefs: UiPreferences = parseUiPreferences(undefined)
  /** Whether anything has been written since the page loaded — the in-memory twin of a stored record */
  private uiPrefsStored = false

  /**
   * Screen preferences (UiPreferences).
   *
   * Also kept in localStorage, for the same reason as the snapshot: the real thing keeps it
   * in a DB, so "the chosen values survive a restart" is this app's promise, and if the mock
   * died before the page did, a test running in a browser could never see that promise at
   * all. localStorage throws in node, so it just falls out of the try/catch and the
   * in-memory copy answers as it always did.
   */
  readonly prefs: PreferencesPort = {
    load: async () => {
      let stored: unknown = this.uiPrefsStored ? this.uiPrefs : undefined
      try {
        const raw = localStorage.getItem('cc-mock-prefs')
        if (raw) {
          stored = JSON.parse(raw)
          this.uiPrefs = parseUiPreferences(stored)
        }
      } catch {
        /* node, or storage denied — the in-memory copy still works */
      }
      // The same one-time move as the host's: a record with no text size takes the snapshot's step (#312 step 5)
      const hasTextSize = typeof stored === 'object' && stored !== null && 'textSize' in stored
      if (!hasTextSize) {
        const legacy = textSizeFromLegacyStep(((await this.workspace.load()) as { textScale?: unknown } | null)?.textScale)
        if (legacy !== null) this.write({ textSize: legacy })
      }
      // And the notification switches (#1306): a record with none takes the snapshot's, or the defaults, once
      if (this.uiPrefs.notifyPolicy === undefined) {
        const carried = readNotifyPolicy(((await this.workspace.load()) as { notifyPolicy?: unknown } | null)?.notifyPolicy)
        this.write({ notifyPolicy: carried })
      }
      return { ...this.uiPrefs }
    },
    // The same rule as the real thing: leaves an unwritten field untouched, and returns the whole thing after it was recorded
    save: async (patch: UiPreferencesPatch) => {
      this.write(patch)
      // Every window hears a change (#1306), the one that made it too
      if (Object.keys(patch).length) this.emit({ type: 'prefs_changed' })
      return { ...this.uiPrefs }
    },
  }

  /** The record after a patch, as the host writes it: through the schema, the notification switches merged one by one (#1306) */
  private write(patch: UiPreferencesPatch): void {
    // Read through the schema as the host's `prefs.set` does, so a text size lands on a step here too
    const notifyPolicy = patch.notifyPolicy ? { ...(this.uiPrefs.notifyPolicy ?? readNotifyPolicy(undefined)), ...patch.notifyPolicy } : undefined
    this.uiPrefs = parseUiPreferences({ ...this.uiPrefs, ...patch, ...(notifyPolicy ? { notifyPolicy } : {}) })
    this.uiPrefsStored = true
    try {
      localStorage.setItem('cc-mock-prefs', JSON.stringify(this.uiPrefs))
    } catch {
      /* node, or storage denied — the in-memory copy still works */
    }
  }
}
