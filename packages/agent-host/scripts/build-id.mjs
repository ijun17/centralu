import { execFileSync } from 'node:child_process'
import { versionOnlyDirt } from '../../../scripts/stamp-version.mjs'

/**
 * **Makes the build output state which commit it came from, on its own** (`bundle.mjs`).
 *
 * During dogfooding, answering "which commit is the running app" required matching the binary's
 * mtime against commit times — a guess, and one that breaks the moment it is rebuilt. Embedded in
 * the first line of the startup log instead. The build continues even if git is absent or fails
 * ('unknown' is better than a failed build). A tree the release stamped its version into (#1501,
 * `stamp-version.mjs`) is not dirty: it differs from the commit by those version fields alone.
 */
export function buildId(root) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    return versionOnlyDirt(root).length ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}
