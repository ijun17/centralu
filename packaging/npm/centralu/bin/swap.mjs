/**
 * Replacing an installed copy of the app without a moment where there is none.
 *
 * Lives apart from `centralu.mjs` for the same reason `platform.mjs` does: the launcher runs a
 * command at import time, so a test cannot import it. The paths come in as arguments, so
 * `tooling/launcher-swap.test.ts` runs this against temporary folders instead of `/Applications`.
 */
import { existsSync, renameSync, rmSync } from 'node:fs'

/**
 * Puts a new copy at `target`: `fill(staging)` writes it beside the old one, the old one is
 * renamed aside, the new one is renamed in, and only then is the old one deleted.
 *
 * The old copy is never deleted before the new one is complete. Deleting first and copying
 * after left a person whose copy failed (a full disk, a permission, an interrupted `ditto`)
 * with no app at all, from a command they ran to update it. A copy that fails here leaves the
 * old install untouched, and a rename that fails puts the old one back.
 *
 * Returns whether something was replaced, and where the old copy was left if it could not be
 * deleted (null when it was).
 */
export function swapInto(target, fill, now = Date.now()) {
  const staging = `${target}.new`
  const aside = `${target}.old-${now}`
  rmSync(staging, { recursive: true, force: true })
  try {
    fill(staging)
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    throw e
  }
  const replaced = existsSync(target)
  if (replaced) renameSync(target, aside)
  try {
    renameSync(staging, target)
  } catch (e) {
    if (replaced) renameSync(aside, target)
    rmSync(staging, { recursive: true, force: true })
    throw e
  }
  if (!replaced) return { replaced, leftAt: null }
  try {
    rmSync(aside, { recursive: true, force: true })
    return { replaced, leftAt: null }
  } catch {
    return { replaced, leftAt: aside }
  }
}
