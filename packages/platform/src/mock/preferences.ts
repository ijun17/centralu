import type { UiPreferences, UiPreferencesPatch } from '@cc/protocol/client'
import { isRecord, parseUiPreferences, readAutoCompact, readNotifyPolicy } from '@cc/protocol/client'
import type { PreferencesPort, WorkspaceSnapshot } from '../ports/index.js'
import { readStored, writeStored } from './stored.js'
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
      writeStored('cc-mock-workspace', s)
    },
    load: async (): Promise<WorkspaceSnapshot | null> => {
      if (this.workspaceSnapshot) return this.workspaceSnapshot
      const stored = readStored('cc-mock-workspace')
      return isRecord(stored) ? stored : null
    },
  }

  /** Public so tests can look inside — and set it up without going through the port */
  uiPrefs: UiPreferences = parseUiPreferences(undefined)

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
      const kept = readStored('cc-mock-prefs')
      if (kept !== undefined) this.uiPrefs = parseUiPreferences(kept)
      // The notification switches (#1306): a record with none takes the snapshot's, or the defaults, once
      if (this.uiPrefs.notifyPolicy === undefined) {
        const snapshot: unknown = await this.workspace.load()
        const carried = readNotifyPolicy(isRecord(snapshot) ? snapshot.notifyPolicy : undefined)
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
    const autoCompact = patch.autoCompact ? { ...readAutoCompact(this.uiPrefs.autoCompact), ...patch.autoCompact } : undefined
    this.uiPrefs = parseUiPreferences({ ...this.uiPrefs, ...patch, ...(notifyPolicy ? { notifyPolicy } : {}), ...(autoCompact ? { autoCompact } : {}) })
    writeStored('cc-mock-prefs', this.uiPrefs)
  }
}
