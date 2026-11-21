// What a first worktree likely lacks (#1512): it has only tracked files, so no ignored `.env` and, unless the lockfiles
// match, no installed dependencies. The dialog offers both as chips; nothing is picked for the person.

/** The install command a project folder's lockfile names, or null when it has none the dialog knows */
export function installCommandFor(rootFileNames: readonly string[]): string | null {
  const has = (n: string) => rootFileNames.includes(n)
  if (has('pnpm-lock.yaml')) return 'pnpm install'
  if (has('yarn.lock')) return 'yarn install'
  if (has('bun.lock') || has('bun.lockb')) return 'bun install'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci'
  return null
}

/** The ignored entries that are environment files (`.env`, `.env.local`, …): secrets and settings git does not carry over */
export function envFilesOf(ignoredPaths: readonly string[]): string[] {
  return ignoredPaths.filter((p) => /^\.env(\.|$)/.test(p))
}
