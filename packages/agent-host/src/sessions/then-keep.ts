import { z } from 'zod'
import { readJson } from '../dev-services/store/json.js'
import type { ThenKeep } from './self-compaction.js'

/**
 * What a host swap or restart must not lose of `compact_self`'s `then` (#2024): the setting store, a key per session. Added keys
 * only: an older build serving the same store during a swap ignores them, and the trash's purge takes them with the session
 * (`<name>:<sessionId>`, `SESSION_SETTING_OF`).
 *  - `compact_then:<session>`: the step and how far its request came (`StoredThen`).
 *  - `compact_notes:<session>`: notes the tool could not take yet, for the session's next input.
 */
export type ThenSettings = {
  appSetting(key: string): string | null
  setAppSetting(key: string, value: string): void
  deleteAppSetting(key: string): void
  updateAppSetting(key: string, next: (current: string | null) => string): void
}

const thenKey = (id: string) => `compact_then:${id}`
const notesKey = (id: string) => `compact_notes:${id}`

/** A stored step reads as null when it is not one (never written, cleared, or a shape this build does not know) */
const Stored = z.object({
  stage: z.enum(['asked', 'sent', 'compacted', 'sending']),
  then: z.string(),
  focusAside: z.string().nullable().catch(null),
  ahead: z.boolean().catch(false),
})
const Notes = z.array(z.string())

const readStep = (raw: string | null) => readJson(raw, Stored.nullable(), null)

export function settingThenKeep(settings: ThenSettings): ThenKeep {
  return {
    read: (id) => readStep(settings.appSetting(thenKey(id))),
    write: (id, record) => settings.setAppSetting(thenKey(id), JSON.stringify(record)),
    clear: (id) => settings.deleteAppSetting(thenKey(id)),
    claim(id) {
      let won = false
      settings.updateAppSetting(thenKey(id), (current) => {
        const record = readStep(current)
        if (record?.stage !== 'compacted') return current ?? ''
        won = true
        return JSON.stringify({ ...record, stage: 'sending' })
      })
      // A key that was not there is not left behind as an empty one
      if (!won && settings.appSetting(thenKey(id)) === '') settings.deleteAppSetting(thenKey(id))
      return won
    },
    notes: (id) => readJson(settings.appSetting(notesKey(id)), Notes, []),
    writeNotes(id, notes) {
      if (notes.length === 0) settings.deleteAppSetting(notesKey(id))
      else settings.setAppSetting(notesKey(id), JSON.stringify(notes))
    },
  }
}
