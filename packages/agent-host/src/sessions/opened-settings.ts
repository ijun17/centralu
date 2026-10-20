import type { SessionHandle } from '../adapters/contract.js'

/**
 * Takes the settings a tool's conversation turned out to run with when it was opened (#1369,
 * `SessionHandle.takeOpenedSettings`) into the session's record, before the session is registered as running.
 *
 * A conversation started elsewhere keeps the model it was started with, and a Codex thread resumed without a model runs
 * that one: the record said another, and the screen showed the record. The record follows what runs, so the screen
 * never names a model other than the one running.
 *
 * `launched` is what the process received (read once, before it came up, see `wake`): it becomes what the process
 * runs, so a later comparison of the record against it (`settingsDrifted`) means what it says. A field the person
 * changed while the process came up (the record no longer equals `launched`) keeps their value in the record: the
 * restart that follows applies it over the tool's.
 * A field the record leaves on the tool's default (null) is adopted only for a conversation taken over from elsewhere
 * (`imported`): a session started here on the default keeps showing "default", and Codex answers a default with a
 * concrete value that is not a choice anyone made.
 * Returns whether the record changed, for the caller to save and announce.
 */
export function adoptOpenedSettings(
  handle: Pick<SessionHandle, 'takeOpenedSettings'>,
  record: { model: string | null; effort: string | null },
  launched: { model: string | null; effort: string | null },
  imported: boolean,
): boolean {
  const opened = handle.takeOpenedSettings?.()
  if (!opened) return false
  let changed = false
  for (const key of ['model', 'effort'] as const) {
    if (opened[key] === launched[key]) continue
    if (launched[key] === null && !imported) continue
    const chosenMeanwhile = record[key] !== launched[key]
    launched[key] = opened[key]
    if (chosenMeanwhile) continue
    record[key] = opened[key]
    changed = true
  }
  return changed
}
