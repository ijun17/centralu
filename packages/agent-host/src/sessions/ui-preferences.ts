import type { UiPreferences, UiPreferencesPatch } from '@cc/protocol'
import { parseUiPreferences, textSizeFromLegacyStep } from '@cc/protocol'
import { parseJson } from '../dev-services/store/json.js'
import { isObj } from '../json-value.js'
import type { AppAccess } from './app-access.js'
import type { DelegationHost } from './delegation-flow.js'
import type { SessionTrashHost } from './session-trash.js'

/**
 * The single app_setting key where the whole set of screen preferences lives.
 *
 * If each preference got its own key, reading them would grow the same way, and above all
 * "fetch all screen preferences on startup" would only be possible for whoever knows the list of
 * keys. As one blob, that list belongs to the schema (UiPreferences).
 */
const UI_PREFS_KEY = 'ui_preferences'

/**
 * What the screen preferences reach of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type UiPreferenceStoreHost = Pick<DelegationHost, 'meta' | 'store'> &
  Pick<SessionTrashHost, 'appsHub'> & {
    /** Another project's apps attached on demand (#371 part A); null exactly when `appsHub` is */
    readonly appAccess: AppAccess | null
  }

/**
 * The screen's preferences (UiPreferences) and its workspace layout, kept in the store for every window: read as one
 * record, written back with only what changed, and the session tools switch applied to every live session (#382).
 * Moved out of the session manager as it was (#428); what it reaches of the manager is `UiPreferenceStoreHost`.
 */
export class UiPreferenceStore {
  constructor(private readonly host: UiPreferenceStoreHost) {}

  saveWorkspace(layout: Record<string, unknown>): void {
    this.host.store.saveWorkspace(layout)
  }

  loadWorkspace(): Record<string, unknown> | null {
    return this.host.store.loadWorkspace<Record<string, unknown>>()
  }

  /**
   * Screen preferences (UiPreferences) — read as one blob, and written back accepting **only what
   * changed.**
   *
   * Corrupted JSON is treated the same as if it did not exist (parseUiPreferences), and said once on
   * stderr with the row it came from. The app failing to start because of a single broken setting is
   * worse than losing one value the person had chosen.
   */
  uiPreferences(): UiPreferences {
    const stored = this.storedUiPreferences()
    const prefs = parseUiPreferences(stored)
    /*
     * The text size moved here from the workspace snapshot (#312 step 5), where the screen kept
     * it as a step index. Moved once: the first read that finds no `textSize` in the record takes
     * the snapshot's step and writes it into the record, and from then on the record has the
     * field, so a snapshot an older window still writes never overrides a size chosen since.
     */
    if (!('textSize' in stored)) {
      const legacy = textSizeFromLegacyStep(this.loadWorkspace()?.textScale)
      if (legacy !== null) {
        prefs.textSize = legacy
        this.host.store.setAppSetting(UI_PREFS_KEY, JSON.stringify({ ...stored, textSize: legacy }))
      }
    }
    return prefs
  }

  /**
   * Writes the patch **over the stored record, not over this build's reading of it** (#384). Another
   * build reads and writes the same row: during a host swap, and after a person goes back a release.
   * A field this build does not know, or a value it cannot read (a theme mode a newer build added),
   * stays as it was unless the patch sets it, so changing the text size in an older build does not
   * reset what a newer one chose.
   */
  setUiPreferences(patch: UiPreferencesPatch): UiPreferences {
    const current = this.uiPreferences()
    this.host.store.setAppSetting(UI_PREFS_KEY, JSON.stringify({ ...this.storedUiPreferences(), ...patch }))
    // The session tools switch also decides the apps a session attached through them (#382): recount every live one
    if (patch.sessionTools !== undefined && patch.sessionTools !== current.sessionTools) {
      // Off ends what was allowed "once"; "always" and the person's own folder come back with the switch (#382)
      if (!patch.sessionTools) this.host.appAccess?.dropOnce(this.host.meta.keys())
      for (const id of this.host.meta.keys()) this.host.appsHub?.sessionAppsChanged(id)
    }
    return { ...current, ...patch }
  }

  /** The stored record as written, every field kept; `{}` for none or for one that is not a JSON object */
  private storedUiPreferences(): Record<string, unknown> {
    const raw = this.host.store.appSetting(UI_PREFS_KEY)
    if (raw === null) return {}
    const v = parseJson(raw)
    if (isObj(v)) return v
    if (!this.brokenPrefsSaid) {
      this.brokenPrefsSaid = true
      console.error(`[agent-host] app_settings.${UI_PREFS_KEY} is not a JSON object; screen preferences read as their defaults until the next change`)
    }
    return {}
  }

  private brokenPrefsSaid = false
}
