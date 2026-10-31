import type { AutoCompact, UiPreferences, UiPreferencesPatch } from '@cc/protocol'
import { NUDGE_MARGIN, parseUiPreferences, readAutoCompact, readNotifyPolicy, textSizeFromLegacyStep } from '@cc/protocol'
import { parseJson } from '../dev-services/store/json.js'
import { isObj } from '../json-value.js'
import { rpcError, type RpcError } from '../rpc-error.js'
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
 * The fields of the auto-compact setting an older build does not know (#1451, #1492), each stored beside the record so an
 * older build's save of `autoCompact` cannot erase it. `controlled` and `share` stay inside it, where every build reads them.
 */
const COMPACT_BESIDE = {
  idleShare: 'autoCompactIdleShare',
  nudge: 'autoCompactNudge',
  nudgeFirst: 'autoCompactNudgeFirst',
  nudgeSecond: 'autoCompactNudgeSecond',
} as const satisfies Record<Exclude<keyof AutoCompact, 'controlled' | 'share'>, string>
const COMPACT_BESIDE_FIELDS = ['idleShare', 'nudge', 'nudgeFirst', 'nudgeSecond'] as const satisfies readonly (keyof typeof COMPACT_BESIDE)[]

/**
 * What the screen preferences reach of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type UiPreferenceStoreHost = Pick<DelegationHost, 'emit' | 'meta' | 'store'> & Pick<SessionTrashHost, 'appsHub'>

/**
 * The screen's preferences (UiPreferences) and its workspace layout, kept in the store for every window: read as one
 * record, written back with only what changed. The session tools switch it once applied to every live session (#382)
 * is always on now (2026-10-20).
 * Moved out of the session manager as it was (#428); what it reaches of the manager is `UiPreferenceStoreHost`.
 */
export class UiPreferenceStore {
  constructor(private readonly host: UiPreferenceStoreHost) {}

  saveWorkspace(layout: Record<string, unknown>): void {
    this.host.store.settings.saveWorkspace(layout)
  }

  loadWorkspace(): Record<string, unknown> | null {
    return this.host.store.settings.loadWorkspace()
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
    // Not over a broken row (#384): it has no `textSize` either, and a read must not replace what it could not read
    if (!('textSize' in stored) && !this.brokenRow()) {
      const legacy = textSizeFromLegacyStep(this.loadWorkspace()?.textScale)
      if (legacy !== null) {
        prefs.textSize = legacy
        this.host.store.settings.setAppSetting(UI_PREFS_KEY, JSON.stringify({ ...stored, textSize: legacy }))
      }
    }
    /*
     * The notification switches moved here from the workspace snapshot (#1306), the same way and for the same reason as the
     * text size: the first read that finds no `notifyPolicy` in the record takes the snapshot's (the defaults, when the
     * window never saved one) and writes it, and from then on the record has the field, so a snapshot an older window still
     * writes never overrides a switch chosen since. The window keeps writing the snapshot too (an older build reads it); this
     * record is the one read here. The row is read again for the write: the text size above may just have been added to it.
     */
    if (!('notifyPolicy' in stored) && !this.brokenRow()) {
      const carried = readNotifyPolicy(this.loadWorkspace()?.notifyPolicy)
      prefs.notifyPolicy = carried
      this.host.store.settings.setAppSetting(UI_PREFS_KEY, JSON.stringify({ ...this.storedUiPreferences(), notifyPolicy: carried }))
    }
    /*
     * "Allow auto from a linked computer" fails closed (#1273 review, owner decision 2026-10-19): its only job is to
     * restrict, and a damaged record must not bring back what the person turned off. Absent still reads as on (the
     * default); a row that is not an object, or a value that is not true or false, reads as off.
     */
    if (this.brokenRow() || ('hubAuto' in stored && typeof stored.hubAuto !== 'boolean')) prefs.hubAuto = false
    /*
     * "Let sessions look at other sessions" is always on (owner decision 2026-10-20): the field stays in the record for older
     * builds, and a false one stored before, or sent by an older window, is not read
     */
    prefs.sessionTools = true
    /*
     * The resting-session share (#1451) and the notices' settings (#1492) are stored beside the auto-compact record, not in
     * it. An older build writes `autoCompact` back as the two fields it knows, so a third inside it was erased by any save
     * there (measured on the previous build); a top-level field of the record is kept by every build (`{ ...stored, ...written }`).
     */
    const beside: Record<string, unknown> = {}
    for (const field of COMPACT_BESIDE_FIELDS) if (COMPACT_BESIDE[field] in stored) beside[field] = stored[COMPACT_BESIDE[field]]
    if (Object.keys(beside).length > 0) prefs.autoCompact = readAutoCompact({ ...(prefs.autoCompact ?? {}), ...beside })
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
    // The switches are merged one by one (#1306): a patch carries only those that change, and two writers (the window, the
    // orchestrator) changing different ones do not undo each other. `current` has the field once the read above carried it; a
    // row that is not a JSON object has none, and the switches then start from the snapshot's, as the window shows them
    // The session tools switch is always on (2026-10-20): what an older window sends for it is not stored
    const { notifyPolicy: switches, autoCompact: compact, sessionTools: _alwaysOn, ...rest } = patch
    const base = current.notifyPolicy ?? readNotifyPolicy(this.loadWorkspace()?.notifyPolicy)
    const notifyPolicy = switches ? { ...base, ...switches } : undefined
    // The auto-compact setting is merged one field at a time too (#1376), over what is stored, field by field read
    const before = readAutoCompact(current.autoCompact)
    const asked: AutoCompact | undefined = compact ? { ...before, ...withoutUndefined(compact) } : undefined
    // The whole setting that would result is judged, not the patch (#1504 review): the two notice shares sit in order, below the
    // tool's own compaction share, and a patch that moves both is judged on the new share. A person's choice that does not fit
    // is refused; a share moved under a second share chosen before is not a choice, and takes it down (`settledSecond`).
    if (compact && asked && asked.nudgeSecond !== null && (compact.nudgeSecond != null || compact.nudgeFirst !== undefined)) {
      const second = Math.round(asked.nudgeSecond * 100)
      if (asked.nudgeSecond > asked.share - NUDGE_MARGIN + 1e-9) {
        throw refusal(`The second reminder (${second}%) must be at least ${Math.round(NUDGE_MARGIN * 100)} points below the share agents compact at (${Math.round(asked.share * 100)}%): the tool's own compaction would come first.`)
      }
      if (asked.nudgeSecond <= asked.nudgeFirst + 1e-9) {
        throw refusal(`The second reminder (${second}%) must be above the first (${Math.round(asked.nudgeFirst * 100)}%).`)
      }
    }
    const merged = asked ? readAutoCompact(asked) : undefined
    // The record keeps the two fields every build knows; the others go beside it (`COMPACT_BESIDE`)
    const compactKeys = Object.keys(withoutUndefined(compact ?? {}))
    const autoCompact = merged && compactKeys.some((k) => !(k in COMPACT_BESIDE)) ? { controlled: merged.controlled, share: merged.share } : undefined
    const besides: Record<string, unknown> = {}
    // A field the patch sets, and the second share when it was held to a share that moved
    if (compact && merged) for (const field of COMPACT_BESIDE_FIELDS) if (compact[field] !== undefined || merged[field] !== before[field]) besides[COMPACT_BESIDE[field]] = merged[field]
    const written = {
      ...rest,
      ...(notifyPolicy ? { notifyPolicy } : {}),
      ...(autoCompact ? { autoCompact } : {}),
      ...besides,
    }
    const stored = this.storedUiPreferences()
    /*
     * A damaged "Allow auto from a linked computer" reads as off (`uiPreferences`), and stays off once rewritten (#1273
     * review): a broken row reads back as `{}`, so saving any other setting over it would drop the field, and absent
     * reads as on. Written as off, unless this change sets it
     */
    const damaged = this.brokenRow() || ('hubAuto' in stored && typeof stored.hubAuto !== 'boolean')
    const kept = damaged && patch.hubAuto === undefined ? { hubAuto: false } : {}
    this.host.store.settings.setAppSetting(UI_PREFS_KEY, JSON.stringify({ ...stored, ...kept, ...written }))
    // Every window hears it (`prefs_changed`): one that did not make the change reads the record again
    // A patch that only carried the session tools switch (always on, not stored) changed nothing
    if (Object.keys(written).length) this.host.emit({ type: 'prefs_changed' })
    const { autoCompact: _two, ...shown } = written
    for (const key of Object.values(COMPACT_BESIDE)) delete (shown as Record<string, unknown>)[key]
    return { ...current, ...shown, ...(merged ? { autoCompact: merged } : {}) }
  }

  /** The stored record as written, every field kept; `{}` for none or for one that is not a JSON object */
  private storedUiPreferences(): Record<string, unknown> {
    const raw = this.host.store.settings.appSetting(UI_PREFS_KEY)
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

  /** Whether the row is there but is not a JSON object */
  private brokenRow(): boolean {
    const raw = this.host.store.settings.appSetting(UI_PREFS_KEY)
    return raw !== null && !isObj(parseJson(raw))
  }
}

/** The host understood the change and said no: the `refused` code, not a fault of the host (`internal`) */
function refusal(message: string): RpcError {
  return rpcError(message, 'refused', { retryable: false, data: { reason: 'bad_value' } })
}

/** A patch's fields that are set: `undefined` is no change, `null` is (the second notice's share back to the default) */
function withoutUndefined(o: Partial<AutoCompact>): Partial<AutoCompact> {
  return {
    ...(o.controlled !== undefined ? { controlled: o.controlled } : {}),
    ...(o.share !== undefined ? { share: o.share } : {}),
    ...(o.idleShare !== undefined ? { idleShare: o.idleShare } : {}),
    ...(o.nudge !== undefined ? { nudge: o.nudge } : {}),
    ...(o.nudgeFirst !== undefined ? { nudgeFirst: o.nudgeFirst } : {}),
    ...(o.nudgeSecond !== undefined ? { nudgeSecond: o.nudgeSecond } : {}),
  }
}
