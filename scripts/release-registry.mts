/**
 * What `release-npm.mts` asks the registry before it publishes, kept apart from that script (which
 * runs a release when imported) so `tooling/release-registry.test.ts` can ask it.
 *
 * **A re-run finishes a release instead of failing on it.** A platform job that publishes and then
 * fails (on a later package, or a dist-tag) used to fail again on re-run at its first publish,
 * `EPUBLISHCONFLICT`, so the shim could never go out without a version bump. A package already on the
 * registry at this version **from this commit** is now skipped. npm records the commit a package was
 * published from as `gitHead` (read back from 0.1.0-beta.14: every package names the release commit).
 * The tarball's integrity cannot stand in for it: a rebuild is not byte for byte the same (the macOS
 * bundle is signed again, the AppImage carries build times), so "same integrity" would never hold. A
 * package at this version from **another** commit still fails: that is a version published twice from
 * different code, which only a bump can fix.
 */
import { execFileSync } from 'node:child_process'

/** What the registry holds at one exact version */
export type Published = { state: 'absent' } | { state: 'present'; gitHead: string | null }

/**
 * Reads `npm view <name>@<version> version gitHead --json`. npm answers a version it does not have
 * with exit 1 and `{ "error": { "code": "E404" } }`; any other failure (the network, a refused token)
 * throws, so a registry that did not answer is never taken for "not published"
 */
export function parseView(stdout: string, ok: boolean, id: string): Published {
  let parsed: unknown
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : null
  } catch {
    throw new Error(`npm view ${id} answered something that is not JSON: ${stdout.slice(0, 200)}`)
  }
  const error = (parsed as { error?: { code?: string; summary?: string } } | null)?.error
  if (!ok || error) {
    if (error?.code === 'E404') return { state: 'absent' }
    throw new Error(`npm view ${id} failed: ${error?.summary ?? error?.code ?? 'no answer'}`)
  }
  // `npm view` with two fields answers an object; a version npm has but with no fields answers nothing
  if (!parsed) return { state: 'absent' }
  const gitHead = (parsed as { gitHead?: unknown }).gitHead
  return { state: 'present', gitHead: typeof gitHead === 'string' ? gitHead : null }
}

/** `name@version` on the registry, as `parseView` reads it */
export function viewPublished(name: string, version: string, viaShell: boolean): Published {
  const id = `${name}@${version}`
  try {
    const out = execFileSync('npm', ['view', id, 'version', 'gitHead', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: viaShell })
    return parseView(out, true, id)
  } catch (e) {
    const out = (e as { stdout?: string }).stdout
    if (typeof out !== 'string') throw e
    return parseView(out, false, id)
  }
}

/** Publish it, skip it (an earlier attempt of this release published it), or stop with why */
export function publishStep(p: Published, head: string, id: string): { do: 'publish' } | { do: 'skip' } | { do: 'stop'; why: string } {
  if (p.state === 'absent') return { do: 'publish' }
  if (p.gitHead === head) return { do: 'skip' }
  return {
    do: 'stop',
    why:
      `${id} is already on the registry, published from ${p.gitHead ? `commit ${p.gitHead.slice(0, 12)}` : 'an unknown commit'}, not from this one (${head.slice(0, 12)}).\n` +
      '  A published version cannot be replaced. Bump to the next prerelease and release that.',
  }
}

/**
 * The names not yet visible on the registry, asked again while any are missing, `tries` times in
 * all, `delayMs` apart. The shim job once failed on packages published a minute earlier that the
 * registry did not show yet (0.1.0-beta.14); a short wait tells "not visible yet" from "not published"
 */
export async function stillMissing(
  names: string[],
  isPublished: (name: string) => boolean,
  o: { tries: number; delayMs: number; sleep?: (ms: number) => Promise<void>; onWait?: (missing: string[]) => void },
): Promise<string[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let missing = names.filter((n) => !isPublished(n))
  for (let i = 1; i < o.tries && missing.length; i++) {
    o.onWait?.(missing)
    await sleep(o.delayMs)
    missing = missing.filter((n) => !isPublished(n))
  }
  return missing
}
