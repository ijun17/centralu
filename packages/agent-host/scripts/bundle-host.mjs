import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The host's own script and what its folder says of it, as `bundle.mjs` makes them: one place for both, so a test that
 * starts the host the way it ships (`tooling/launcher-serve.test.ts`, #2144) builds the same `main.mjs` and the same
 * `bundle-info.json` as a release.
 */

/** `main.mjs`: the host in one ES module, its native addons (better-sqlite3, node-pty) left to resolve beside it */
export async function bundleHostScript({ root, outfile, buildId }) {
  await build({
    entryPoints: [join(root, 'packages/agent-host/src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['better-sqlite3', 'node-pty'],
    // Resolves the workspace alias to source (bundles directly, without a build step)
    alias: {
      '@cc/protocol': join(root, 'packages/protocol/src/index.ts'),
      '@cc/common': join(root, 'packages/common/src/index.ts'),
    },
    define: {
      __CC_BUILD__: JSON.stringify(buildId),
    },
    banner: {
      // Lets the ESM bundle load a CJS dependency (better-sqlite3) via require
      js: "import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
  })
}

/**
 * `protocolVersion` is the WebSocket protocol the bundled host speaks. The keeper (#280) records
 * it for each host it runs, so a window can see that a running host from another build speaks a
 * different protocol before it tries to talk to it. Read from the source rather than imported:
 * this script runs on plain Node, and the constant lives in TypeScript.
 */
function protocolVersion(root) {
  const src = readFileSync(join(root, 'packages/protocol/src/envelope.ts'), 'utf8')
  const m = /export const PROTOCOL_VERSION = (\d+)/.exec(src)
  if (!m) throw new Error('could not find PROTOCOL_VERSION in packages/protocol/src/envelope.ts')
  return Number(m[1])
}

/** `bundle-info.json`'s text: what the launcher and the keeper read of a host folder before they start it */
export function bundleInfoText({ root, buildId }) {
  return (
    JSON.stringify(
      {
        commit: buildId,
        protocolVersion: protocolVersion(root),
        // The host answers a `prove` before hello (#838): `centralu serve` reads this to say `proof` in the connection line
        hostProof: 1,
        // The host takes its token as the first line on stdin (#538): a keeper hands it over there instead of in the environment
        tokenOnStdin: 1,
        // The host checks full credentials against serve.json's verifiers, given its key on stdin (#1405): the `centralu serve` of
        // 0.1.0-beta.45 reads this to hand it the key and make each full credential at --pair, rather than keep one token for it
        verifiers: 1,
        // The host signs a key `prove` and takes a hub's key hello (#1711): `centralu serve --pair-key` reads this to report the
        // key a host started next signs with when none runs
        keyPairing: 1,
        builtAt: new Date().toISOString(),
        runtime: 'system-node',
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ) + '\n'
  )
}
