/**
 * The repository paths a feature map names (docs/feature-maps/README.md "Keeping a map current"): every code span that
 * starts at one of the repository's top folders. A data-folder file (`<data>/name`) and a bare name are not paths here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_PATH = /`((?:packages|apps|e2e|docs|tooling|scripts|packaging)\/[^`\s]+)`/g

/** The paths `text` names that `exists` says are not there, each once, in order */
export function missingPaths(text: string, exists: (path: string) => boolean): string[] {
  const named = [...text.matchAll(REPO_PATH)].map((m) => m[1] ?? '')
  return [...new Set(named)].filter((path) => !exists(path))
}

/** Each map in `docs/feature-maps` with the paths it names that the repository at `root` does not have */
export function staleMaps(root: string): { map: string; missing: string[] }[] {
  const folder = join(root, 'docs', 'feature-maps')
  return readdirSync(folder)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ map: name, missing: missingPaths(readFileSync(join(folder, name), 'utf8'), (path) => existsSync(join(root, path))) }))
    .filter((m) => m.missing.length > 0)
}
