/**
 * `pnpm app`: a local release build of the macOS app, then the shell and content staged into it and
 * the app opened.
 *
 * The version (#1501): git holds none, so this stamps the one `app-version.mjs` resolves
 * (`CENTRALU_VERSION`, else the newest release tag reachable from HEAD, as `brand.ts` said before)
 * into the carriers for the build, and puts `0.0.0-dev` back afterwards, also when the build fails
 * or is interrupted. A placeholder build would be refused by the downgrade floor of a data folder
 * that has run a release, and would offer that release as an update to itself.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { APP_NAME } from '../packages/protocol/src/brand.js'
// @ts-expect-error — dependency-free JavaScript, shared with bundle.mjs
import { PLACEHOLDER, resolveAppVersion, ROOT } from './app-version.mjs'
// @ts-expect-error — as above
import { stampVersion } from './stamp-version.mjs'

const stamp = stampVersion as (root: string, version: string) => string[]
const root = ROOT as string

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status ?? r.signal}`)
}

let version: string
try {
  version = (resolveAppVersion as () => string)()
} catch (e) {
  console.error(`app: ${(e as Error).message}`)
  process.exit(1)
}

const restore = () => stamp(root, PLACEHOLDER as string)
// An interrupt still puts the placeholder back: a stamped carrier left in the tree would be committed
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}

const env = { ...process.env, CENTRALU_VERSION: version }
const bundle = join(root, 'apps/desktop/src-tauri/target/release/bundle/macos', `${APP_NAME}.app`)
try {
  console.log(`Building ${APP_NAME} ${version}`)
  stamp(root, version)
  try {
    run('pnpm', ['--filter', '@cc/desktop', 'exec', 'tauri', 'build'], env)
  } finally {
    restore()
  }
  run('pnpm', ['exec', 'tsx', 'scripts/bundle-stage.mts', bundle], env)
  run('open', [bundle], env)
} catch (e) {
  console.error(`app: ${(e as Error).message}`)
  process.exitCode = 1
}
