import type { UiPreferences, UiPreferencesPatch } from '@cc/protocol/client'
import { isRecord, parseUiPreferences, readAutoCompact, readNotifyPolicy } from '@cc/protocol/client'
import type { PreferencesPort, WorkspaceSnapshot } from '../ports/index.js'
import { readStored, writeStored } from './stored.js'
import type { Emit } from './event-bus.js'

/** The workspace snapshot and the screen preferences, both kept in localStorage when the page has one */
export class PreferencesMock {
  constructor(private readonly emit: Emit) {}

  workspaceSnapshot: WorkspaceSnapshot | null = null

  // In localStorage so "the arrangement survives a relaunch" is testable against the mock (#20)
  readonly workspace = {
    save: async (s: WorkspaceSnapshot) => {
      this.workspaceSnapshot = s
      writeStored('cc-mock-workspace', s)
    },
    load: async (): Promise<WorkspaceSnapshot | null> => {
      if (this.workspaceSnapshot) return this.workspaceSnapshot
      const stored = readStored('cc-mock-workspace')
      return isRecord(stored) ? stored : null
    },
  }

  /** Public so tests can set it up without the port */
  uiPrefs: UiPreferences = parseUiPreferences(undefined)

  /** In localStorage, as the snapshot, so "chosen values survive a restart" is testable */
  readonly prefs: PreferencesPort = {
    load: async () => {
      const kept = readStored('cc-mock-prefs')
      if (kept !== undefined) this.uiPrefs = parseUiPreferences(kept)
      // A record with no notification switches takes the snapshot's, or the defaults, once (#1306)
      if (this.uiPrefs.notifyPolicy === undefined) {
        const snapshot: unknown = await this.workspace.load()
        const carried = readNotifyPolicy(isRecord(snapshot) ? snapshot.notifyPolicy : undefined)
        this.write({ notifyPolicy: carried })
      }
      return { ...this.uiPrefs }
    },
    save: async (patch: UiPreferencesPatch) => {
      this.write(patch)
      // The window that made the change hears it too (#1306)
      if (Object.keys(patch).length) this.emit({ type: 'prefs_changed' })
      return { ...this.uiPrefs }
    },
  }

  /** As the host writes it: the notification switches merged one by one (#1306) */
  private write(patch: UiPreferencesPatch): void {
    // As the host's `prefs.set`, so a text size lands on a step here too
    const notifyPolicy = patch.notifyPolicy ? { ...(this.uiPrefs.notifyPolicy ?? readNotifyPolicy(undefined)), ...patch.notifyPolicy } : undefined
    const autoCompact = patch.autoCompact ? { ...readAutoCompact(this.uiPrefs.autoCompact), ...patch.autoCompact } : undefined
    this.uiPrefs = parseUiPreferences({ ...this.uiPrefs, ...patch, ...(notifyPolicy ? { notifyPolicy } : {}), ...(autoCompact ? { autoCompact } : {}) })
    writeStored('cc-mock-prefs', this.uiPrefs)
  }
}
