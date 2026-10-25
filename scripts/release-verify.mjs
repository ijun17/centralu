import { execFileSync } from 'node:child_process'

/**
 * The order of a release's first two steps (#1501): verify the tree as it is committed, at the placeholder, then
 * stamp the version into it for the build.
 *
 * The guard tests read the carriers and expect the placeholder (`tooling/brand.test.ts`, the release-bump and
 * host-package tests): verified after the stamp, 17 of them failed on every Linux job of the beta.38 rehearsal. They stay
 * as strict as they were; the release verifies what main holds, and only the build sees the version. The verify child
 * gets no `CENTRALU_VERSION` for the same reason: that variable is what makes a build stamp. The child is started here,
 * with that environment, so no caller can start it with the full one.
 *
 * Kept apart from release-npm.mts, which runs on import, so a test can run it with a fake `exec`.
 *
 * @param {object} o
 * @param {string[]} o.scripts   pnpm scripts to run, in order (`verify`, or a platform's own list)
 * @param {boolean} o.skipVerify a rehearsal on this tree already verified it (release.yml guard)
 * @param {string} [o.cwd]
 * @param {boolean} [o.shell]    `pnpm` is a .cmd file on Windows, which node starts only through a shell
 * @param {() => void} o.stamp   stamps the version into the tree and holds it (`holdStamp`)
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {string} [o.platform]
 * @param {(cmd: string, args: string[], options: object) => unknown} [o.exec]
 */
export function verifyThenStamp({ scripts, skipVerify, cwd, shell = false, stamp, env = process.env, platform = process.platform, exec = execFileSync }) {
  if (!skipVerify) {
    const unstamped = withoutVersion(env, platform)
    for (const script of scripts) exec('pnpm', [script], { cwd, stdio: 'inherit', encoding: 'utf8', shell, env: unstamped })
  }
  stamp()
}

/** `env` without CENTRALU_VERSION; on Windows variable names ignore case, so `Centralu_Version` goes too */
export function withoutVersion(env, platform = process.platform) {
  const same = (k) => (platform === 'win32' ? k.toUpperCase() === 'CENTRALU_VERSION' : k === 'CENTRALU_VERSION')
  return Object.fromEntries(Object.entries(env).filter(([k]) => !same(k)))
}
