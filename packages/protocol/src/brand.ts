/**
 * Values that identify the app.
 *
 * **Only "machine-read values" live here.** User-facing copy stays as a literal —
 * `Centralu is …` reads better than `${APP_NAME} is …`, and once localization is needed the
 * copy has to move to a string catalog anyway, not stay a constant reference.
 *
 * There is one bar for pulling something out into a constant here: **it is duplicated, and a
 * build still passes even if the copies drift apart.** Places TypeScript cannot reach
 * (index.html, tauri.conf.json, Cargo.toml, Rust) cannot be bound to a constant, so a contract
 * test guards them instead (`tooling/brand.test.ts`).
 */

/** The human-facing name. A contract test checks that the static files match this value. */
export const APP_NAME = 'Centralu'

/** The bundle identifier — must match `identifier` in `tauri.conf.json`. */
export const APP_ID = 'app.centralu'

/**
 * Three places (tauri.conf.json, Cargo.toml, apps/desktop/package.json) and two npm packages
 * must match this value — `tooling/brand.test.ts` catches it if they drift.
 *
 * The version says beta up front. "0.1.0" reads like a finished first release, while
 * "0.1.0-beta.1" lowers expectations on its own — the reader knows even without reading the docs.
 */
export const APP_VERSION = '0.1.0-beta.11'

/** The machine-read name — unlike the display name, it stays lowercase and hyphenated. */
export const APP_SLUG = 'centralu'

/**
 * The bundle passed when introducing the app to an external CLI (codex `clientInfo`).
 * Five places were building the same object, and touching only the version would silently
 * put them out of sync.
 */
export const CLIENT_INFO = { name: APP_SLUG, title: APP_NAME, version: APP_VERSION } as const

/**
 * The name of the data folder.
 *
 * There are two places the user sees this path — when attaching `host.log` to a bug report,
 * and when looking at a worktree path. If it does not match the app name, that moment turns
 * into "what is this?".
 */
export const DATA_DIR = '.centralu'

/** The data folder for a host started in dev mode — kept separate so it does not mix with the packaged app. */
export const DATA_DIR_DEV = '.centralu-dev'

/**
 * The folder name from before the rename.
 *
 * **Cannot be deleted.** It holds the user's conversation history, and if the new folder does
 * not exist yet, this is the only copy. The host migrates it once, before opening the database
 * (`packages/agent-host/src/main.ts`).
 */
export const DATA_DIR_LEGACY = { prod: '.control-center', dev: '.control-center-dev' } as const // legacy-name
