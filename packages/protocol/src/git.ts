import type { GitFileStatus } from './entities.js'

/**
 * How many files have changes, for a list of changed files (#850 item 10).
 *
 * A partly staged file is two rows of that list, one under Staged and one under Changes, and still one changed file.
 * Counting files in one place and rows in another makes two numbers a few pixels apart disagree (the sidebar's, from
 * the host's `gitSummary`, and the evidence panel's count and its collapsed rail), so every count of changed files is
 * this one.
 */
export function changedFileCount(files: readonly Pick<GitFileStatus, 'path'>[]): number {
  return new Set(files.map((f) => f.path)).size
}
