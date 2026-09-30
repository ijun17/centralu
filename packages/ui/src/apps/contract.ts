import type { ComponentType } from 'react'
import type { AppId } from '@cc/protocol'

/**
 * An app's UI-side contract (#81) — the shape of a module registered in the compile-time
 * registry.
 *
 * There is no dynamic loading: an app is a React component that lives in the repository, and
 * isolation is enforced not through how it loads but through one-way dependency (an app touches
 * core only through api.ts, and core knows nothing about it beyond a single line in the registry)
 * and ownership (state, tools and slots belong to the app, so toggling it off leaves no residue).
 * The enforcement is a dependency-cruiser rule — CI, not convention.
 *
 * id is an open string (M4 P-1). It used to be closed here to a union with a single member,
 * `'control'` — that was true while the registry was one compiled array, but an external app
 * discovered at runtime has no way to join that union. The definition lives alongside the wire
 * types (`@cc/protocol`), and this file only re-exports it: the name an app author reads still
 * comes from this file.
 */
export type { AppId }

export type AppModule = {
  id: AppId
  /** The name that appears on its row in Settings > Apps */
  title: string
  /** The right rail on the orchestrator screen */
  railPanel?: ComponentType
  /** A dedicated screen (a spot for board apps to use — empty for now) */
  view?: ComponentType
  /** Settings > Apps > this app's settings */
  settingsPanel?: ComponentType
}
