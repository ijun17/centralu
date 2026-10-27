/**
 * What no ESLint pass reads: eslint.config.js adds `**\/*.cjs` to it (the main pass has never read those); the guard pass
 * (tooling/eslint-guard-pass.js) reads them.
 */
export const IGNORES = [
  // tmp/: disposable probes and captures made during dogfooding. They never stay in the
  // repository, so no rule needs to check them either.
  // .claude/: agents' git worktrees, each a whole checkout of this repository. Linted from
  // here, none of the path-scoped blocks match them (3,422 false errors on 2026-10-03,
  // with two agents at work); each worktree runs its own lint.
  '.claude/**',
  // Build output: the dist folder at the root of an app or a package (vite's outDir). A folder named dist inside a src is source.
  'apps/*/dist/**',
  'packages/*/dist/**',
  '**/node_modules/**',
  'spike/**',
  'tmp/**',
  '**/src-tauri/target/**',
  '**/src-tauri/gen/**',
  '**/adapters/codex/generated/**',
  '**/src-tauri/resources/**',
  'apps/desktop/content-verify/**',
  '**/*.app/**',
  // The app template's runtime — a minified build artifact (scripts/build-app-runtime.mjs) —
  // and its copy in each project app committed here.
  'packages/agent-host/app-template/runtime/**',
  '.centralu/apps/*/runtime/**',
  // .centralu/ is git-ignored except apps/ (.gitignore); anything else there is someone's
  // local material, such as a Claude Code mod being tried out, not code this repo checks.
  '.centralu/*',
  '!.centralu/apps',
]
