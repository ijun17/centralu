import { z } from 'zod'
import { readJson } from '../dev-services/store/json.js'

/** How far a request with a `then` has come; the next host reads it to know what it can still do */
export type ThenStage = 'asked' | 'sent' | 'compacted' | 'refused' | 'sending'
/**
 * A pending `then` as the store keeps it. `refused`: the request did not compact and `why` says so; the step goes all the same, as a turn that
 * says it. `at`: when the record last moved, so a host does not send what an older build left behind long ago (`THEN_KEEP_MS`)
 */
export type StoredThen = { stage: ThenStage; then: string; focusAside: string | null; ahead: boolean; why: string | null; at: number }

/** The text of the turn that carries the agent's next step */
export function thenTurn(rec: StoredThen): string {
  return [
    rec.why === null
      ? '[Centralu] The compaction you asked for with compact_self is done. This is the step you set with `then`.'
      : `[Centralu] Your compact_self request did not compact the conversation (${rec.why}), so it is as it was. This is the step you set with \`then\`. Asking again before anything changed gets the same answer.`,
    ...(rec.ahead ? ['A message from the person ran before the compaction and came first: what they asked weighs more than this step.'] : []),
    ...(rec.focusAside ? [`This tool's compact takes no focus. What you asked the summary to keep: ${rec.focusAside}`] : []),
    '',
    rec.then,
  ].join('\n')
}

/** The store side of a `then` and of the notes owed a session: per session, in the setting store, so the host after a swap or a restart finds them */
export type ThenKeep = {
  read(sessionId: string): StoredThen | null
  write(sessionId: string, record: StoredThen): void
  clear(sessionId: string): void
  /** Moves a `compacted` or `refused` record to `sending` in one transaction; true only for the caller that moved it. The other host of a swap finds it moved (or gone) and sends nothing */
  claim(sessionId: string): boolean
  /** Records that a compaction of the session went on to its next step at `at`, and answers how many did in the hour up to it (kept, so a swap does not start the count again) */
  cycle(sessionId: string, at: number): number
  notes(sessionId: string): string[]
  writeNotes(sessionId: string, notes: string[]): void
}

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
const cyclesKey = (id: string) => `compact_cycles:${id}`
const HOUR_MS = 60 * 60_000

/** A stored step reads as null when it is not one (never written, cleared, or a shape this build does not know) */
const Stored = z.object({
  stage: z.enum(['asked', 'sent', 'compacted', 'refused', 'sending']),
  then: z.string(),
  focusAside: z.string().nullable().catch(null),
  ahead: z.boolean().catch(false),
  why: z.string().nullable().catch(null),
  // A record without one reads as left long ago
  at: z.number().catch(0),
})
const Notes = z.array(z.string())
const Times = z.array(z.number())

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
        if (record?.stage !== 'compacted' && record?.stage !== 'refused') return current ?? ''
        won = true
        return JSON.stringify({ ...record, stage: 'sending' })
      })
      // A key that was not there is not left behind as an empty one
      if (!won && settings.appSetting(thenKey(id)) === '') settings.deleteAppSetting(thenKey(id))
      return won
    },
    cycle(id, at) {
      let count = 0
      settings.updateAppSetting(cyclesKey(id), (current) => {
        const times = [...readJson(current, Times, []).filter((t) => t > at - HOUR_MS && t <= at), at]
        count = times.length
        return JSON.stringify(times)
      })
      return count
    },
    notes: (id) => readJson(settings.appSetting(notesKey(id)), Notes, []),
    writeNotes(id, notes) {
      if (notes.length === 0) settings.deleteAppSetting(notesKey(id))
      else settings.setAppSetting(notesKey(id), JSON.stringify(notes))
    },
  }
}
