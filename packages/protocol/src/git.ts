import type { GitFileStatus } from './entities.js'

/**
 * How many files have changes, for a list of changed files (#850 item 10).
 *
 * A partly staged file is two rows of that list, one under Staged and one under Changes, and still one changed file.
 * The sidebar's number (the host's `gitSummary`) counted it once while the evidence panel's count and its collapsed
 * rail counted rows, so the two numbers a few pixels apart disagreed. Every count of changed files is this one.
 */
export function changedFileCount(files: readonly Pick<GitFileStatus, 'path'>[]): number {
  return new Set(files.map((f) => f.path)).size
}
