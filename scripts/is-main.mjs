import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether the module at `metaUrl` (its `import.meta.url`) is the script node was started with. `process.argv[1]` keeps
 * the path as given while `import.meta.url` has its symlinks resolved, so comparing them as they are never matched under
 * macOS's temporary folder (`/var` -> `/private/var`), or a symlinked or junctioned checkout: the command ended at once
 * with exit 0 and printed nothing, which looks like success. Both sides are compared as real paths.
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1)
  } catch {
    return false
  }
}
