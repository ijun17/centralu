// Machine-read values that identify the app; user-facing copy stays literal. A value is here when its copies could
// drift with the build still passing; where TypeScript cannot reach (index.html, tauri.conf.json, Cargo.toml, Rust),
// `tooling/brand.test.ts` checks them.

import { APP_VERSION } from './version.generated.js'

export const APP_NAME = 'Centralu'

/** Must match `identifier` in `tauri.conf.json` */
export const APP_ID = 'app.centralu'

/** `0.0.0-dev` unless a packaging build stamped it; never committed stamped (#1501, `tooling/brand.test.ts`) */
export { APP_VERSION }

export const APP_SLUG = 'centralu'

/** Introduces the app to an external CLI (`clientInfo`) */
export const CLIENT_INFO = { name: APP_SLUG, title: APP_NAME, version: APP_VERSION } as const

/** Matches the app's name: the person sees it in a bug report's `host.log` path and in worktree paths */
export const DATA_DIR = '.centralu'

/**
 * Where a new project is made by default (`~/Centralu`): visible, unlike the data folder, since it holds the person's
 * work and an uninstall that removes the data folder must not take it along
 */
export const PROJECTS_DIR = APP_NAME

/** Kept apart so a dev host does not mix with the packaged app */
export const DATA_DIR_DEV = '.centralu-dev'

/**
 * Cannot be deleted: the host migrates it once before opening the database (`agent-host/src/main.ts`), and until then
 * it is the only copy of the person's history
 */
export const DATA_DIR_LEGACY = { prod: '.control-center', dev: '.control-center-dev' } as const // legacy-name
