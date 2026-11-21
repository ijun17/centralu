import type { GitFileStatus } from './entities.js'

/**
 * Every count of changed files (#850): a partly staged file is two rows, Staged and Changes, but one file, and counting
 * rows in one place made the sidebar and the evidence panel disagree.
 */
export function changedFileCount(files: readonly Pick<GitFileStatus, 'path'>[]): number {
  return new Set(files.map((f) => f.path)).size
}
