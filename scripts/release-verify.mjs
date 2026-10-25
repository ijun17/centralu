/**
 * The order of a release's first two steps (#1501): verify the tree as it is committed, at the placeholder, then
 * stamp the version into it for the build.
 *
 * The guard tests read the carriers and expect the placeholder (`tooling/brand.test.ts`, the release-bump and
 * host-package tests): verified after the stamp, 17 of them failed on every Linux job of the beta.38 rehearsal.
 * They stay as strict as they were; the release verifies what main holds, and only the build sees the version.
 * The verify child gets no `CENTRALU_VERSION` for the same reason: that variable is what makes a build stamp.
 *
 * Kept apart from release-npm.mts, which runs on import, so a test can run it with a fake `run`.
 *
 * @param {object} o
 * @param {string[]} o.scripts   pnpm scripts to run, in order (`verify`, or a platform's own list)
 * @param {boolean} o.skipVerify a rehearsal on this tree already verified it (release.yml guard)
 * @param {(cmd: string, args: string[], env: NodeJS.ProcessEnv) => void} o.run  runs a command, throws on failure
 * @param {() => void} o.stamp   stamps the version into the tree and holds it (`holdStamp`)
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export function verifyThenStamp({ scripts, skipVerify, run, stamp, env = process.env }) {
  if (!skipVerify) {
    const { CENTRALU_VERSION: _version, ...unstamped } = env
    for (const script of scripts) run('pnpm', [script], unstamped)
  }
  stamp()
}
