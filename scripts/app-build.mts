/**
 * `pnpm app`: a local release build of the macOS app, then the shell and content staged into it and
 * the app opened.
 *
 * The version (#1501): git holds none, so this stamps the one `app-version.mjs` resolves
 * (`CENTRALU_VERSION`, else the newest release tag reachable from HEAD, as `brand.ts` said before)
 * into the carriers for the build, and puts `0.0.0-dev` back afterwards, also when the build fails
 * or is interrupted (`runSteps`: a signal stops the build, restores and runs nothing after). A
 * placeholder build would be refused by the downgrade floor of a data folder that has run a release,
 * and would offer that release as an update to itself.
 */
import { join } from 'node:path'
import { APP_NAME } from '../packages/protocol/src/brand.js'
// @ts-expect-error — dependency-free JavaScript, shared with bundle.mjs
import { resolveAppVersion, ROOT } from './app-version.mjs'
// @ts-expect-error — as above
import { runSteps } from './stamp-version.mjs'

const root = ROOT as string
const run = runSteps as (root: string, version: string, steps: [string, string[]][], o: { stamped: number; env: NodeJS.ProcessEnv }) => Promise<void>

let version: string
try {
  version = (resolveAppVersion as () => string)()
} catch (e) {
  console.error(`app: ${(e as Error).message}`)
  process.exit(1)
}

const bundle = join(root, 'apps/desktop/src-tauri/target/release/bundle/macos', `${APP_NAME}.app`)
console.log(`Building ${APP_NAME} ${version}`)
try {
  await run(
    root,
    version,
    [
      ['pnpm', ['--filter', '@cc/desktop', 'exec', 'tauri', 'build']],
      // The placeholder is back from here on: staging reads the version out of the built Info.plist
      ['pnpm', ['exec', 'tsx', 'scripts/bundle-stage.mts', bundle]],
      ['open', [bundle]],
    ],
    { stamped: 1, env: { ...process.env, CENTRALU_VERSION: version } },
  )
} catch (e) {
  console.error(`app: ${(e as Error).message}`)
  process.exitCode = 1
}
