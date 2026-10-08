import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import platformChecks from './tooling/eslint-platform-checks.js'

/**
 * The modules that may ask which OS this is, each owning one subject (docs/architecture.md §2). A new
 * entry is a new subject, not a place to park a check.
 */
export const PLATFORM_MODULES = [
  // The host's questions named for what differs: `ps`, clonefile, locked programs, path rules, install paths
  'packages/agent-host/src/os.ts',
  // Finding a tool on PATH (PATHEXT, npm shims) and starting it (`.cmd` shims, absolute paths)
  'packages/agent-host/src/env-path.ts',
  'packages/agent-host/src/tool-launch.ts',
  // Ending a process tree: groups and signals, or taskkill and parent links
  'packages/agent-host/src/dev-services/kill-tree.ts',
  // The terminal's and the Run button's shell
  'packages/agent-host/src/dev-services/terminal.ts',
  // How Claude Code is started on Windows (#353)
  'packages/agent-host/src/adapters/claude/exe-link.ts',
  // The npm launcher's platform layer
  'packaging/npm/centralu/bin/platform.mjs',
  // TODO: move the launcher's own checks into platform.mjs once remote phase 3's launcher work has
  // landed (it is changing serve.mjs and centralu.mjs now); listed so that work is not blocked.
  'packaging/npm/centralu/bin/centralu.mjs',
  'packaging/npm/centralu/bin/serve.mjs',
  // TODO: remote phase 3 is changing the hub's links; revisit what platform checks they need then.
  'packages/agent-host/src/links/**',
]

/** The layer rules originate in docs/architecture.md §2. This is the machine-enforced version. */
export default tseslint.config(
  // tmp/: disposable probes and captures made during dogfooding. They never stay in the
  // repository, so no rule needs to check them either.
  // .claude/: agents' git worktrees, each a whole checkout of this repository. Linted from
  // here, none of the path-scoped blocks below match them (3,422 false errors on 2026-10-03,
  // with two agents at work); each worktree runs its own lint.
  { ignores: ['.claude/**','**/dist/**', '**/node_modules/**', 'spike/**', 'tmp/**', '**/*.cjs', '**/src-tauri/target/**', '**/src-tauri/gen/**', '**/adapters/codex/generated/**', '**/src-tauri/resources/**', 'apps/desktop/content-verify/**', '**/*.app/**',
    // The app template's runtime — a minified build artifact (scripts/build-app-runtime.mjs) —
    // and its copy in each project app committed here.
    'packages/agent-host/app-template/runtime/**', '.centralu/apps/*/runtime/**',
    // .centralu/ is git-ignored except apps/ (.gitignore); anything else there is someone's
    // local material, such as a Claude Code mod being tried out, not code this repo checks.
    '.centralu/*', '!.centralu/apps'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { ecmaVersion: 2023, sourceType: 'module' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  /*
   * The hooks rule.
   *
   * "A hook after an early return" was committed **twice** (ProjectBlock, Body). Both were
   * runtime crashes that only fired the moment the condition was met, so neither type checking
   * nor tests caught them, and the second one turned the screen blank the instant the grid was
   * opened.
   *
   * Writing "hooks go first" in a comment does not stop a third one.
   */
  {
    files: ['packages/ui/**/*.tsx', 'packages/ui/**/*.ts', 'apps/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // A missing dependency shows up as "occasionally does not update", which is hard to
      // trace back to a cause — left as a warning.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['packages/**/*', 'apps/**/*'],
      'boundaries/elements': [
        { type: 'protocol', pattern: 'packages/protocol/src/**/*' },
        { type: 'core', pattern: 'packages/core/src/**/*' },
        { type: 'ports', pattern: 'packages/platform/src/ports/**/*' },
        { type: 'platform-impl', pattern: 'packages/platform/src/(web|tauri|mock)/**/*' },
        { type: 'ui', pattern: 'packages/ui/src/**/*' },
        { type: 'agent-host', pattern: 'packages/agent-host/src/**/*' },
        { type: 'app', pattern: 'apps/**/*' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'protocol', allow: ['protocol'] },
            { from: 'core', allow: ['core', 'protocol'] },
            { from: 'ports', allow: ['ports', 'protocol'] },
            { from: 'platform-impl', allow: ['platform-impl', 'ports', 'protocol'] },
            { from: 'ui', allow: ['ui', 'core', 'ports', 'protocol'] },
            { from: 'agent-host', allow: ['agent-host', 'protocol'] },
            { from: 'app', allow: ['app', 'ui', 'core', 'ports', 'platform-impl', 'protocol'] },
          ],
        },
      ],
    },
  },
  // core: a pure domain — no IO, no React.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'zustand'], message: 'core is a pure domain — no UI libraries' },
            { group: ['node:*', 'fs', 'path', 'ws', 'better-sqlite3'], message: 'core does no IO (docs/architecture.md §2)' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'core does no IO' },
        { name: 'WebSocket', message: 'core does no IO' },
        { name: 'window', message: 'core touches no DOM' },
        { name: 'document', message: 'core touches no DOM' },
      ],
    },
  },
  // ui: knows only ports — no implementations, no direct IO (docs/platform-abstraction.md §6).
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@tauri-apps/*'], message: 'only used from platform/tauri' },
            { group: ['@cc/platform/web', '@cc/platform/mock', '**/platform/src/web/**', '**/platform/src/mock/**'], message: 'ui takes only ports — implementations are injected at the apps entry point' },
            { group: ['ws', 'node:*'], message: 'ui does not use Node APIs' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'no direct network calls from ui — go through a port' },
        { name: 'WebSocket', message: 'no direct WS use from ui — go through a port' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='WebSocket']", message: 'no direct WS use from ui — go through a port' },
        { selector: "CallExpression[callee.name='fetch']", message: 'no fetch from ui — go through a port' },
        { selector: "MemberExpression[object.name='window'][property.name='fetch']", message: 'no fetch from ui — go through a port' },
      ],
    },
  },
  // Node process code: Node globals are allowed.
  {
    files: [
      'packages/agent-host/**/*.{ts,mts,mjs}',
      'tooling/**/*.{ts,js}',
      'e2e/**/*.ts',
      '*.config.{ts,js}',
      // Packaging tools: the npm launcher and release scripts are Node processes too.
      'packaging/**/*.mjs',
      'scripts/**/*.{mts,mjs}',
      // Scripts that GitHub Actions workflows run.
      '.github/scripts/**/*.mjs',
      // Project apps' servers (docs/apps.md): Node processes Centralu starts.
      '.centralu/apps/*/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.mjs'], rules: { 'no-empty': 'off', '@typescript-eslint/no-unused-expressions': 'off' } },
  // agent-host: shares only protocol (core/ui/platform live on the other side of the process).
  {
    files: ['packages/agent-host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@cc/core', '@cc/ui', '@cc/platform/*'], message: 'agent-host shares only protocol (docs/architecture.md §2)' },
            { group: ['react', 'react-dom'], message: 'agent-host is a Node process — no browser code' },
          ],
        },
      ],
      /*
       * The host logs to stderr, never stdout.
       *
       * `teeStderrToFile` is what puts host output into `~/.centralu/host.log`, and it
       * only intercepts stderr. A `.app` launched from Finder has no stdout destination
       * at all, so `console.log` in this package is not a quieter log — it is a line that
       * reaches nobody, in production only, while working perfectly in the terminal.
       * That already happened once: the v21 migration announced itself with `console.log`
       * and rewrote 349,825 rows into 57,709 leaving no trace it had run.
       *
       * stdout is not merely unused here — it is *reserved*. `main.ts` prints exactly one
       * line to it, the handshake the Tauri supervisor parses for the port and auth token,
       * which is also why the tee must never be widened to include stdout: that would copy
       * the token into a plaintext file. main.ts is exempted below for that one line.
       */
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['packages/agent-host/src/main.ts', 'packages/agent-host/**/*.test.ts', 'packages/agent-host/scripts/**'],
    rules: { 'no-console': 'off' },
  },
  { files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  /*
   * Which OS this is gets asked only in a platform module (tooling/eslint-platform-checks.js). The
   * shipped code is checked: the packages, the apps and the npm launcher. Tests skip cases by OS,
   * and build and release scripts are about one platform's artifacts, so neither is.
   */
  {
    files: ['packages/*/src/**/*.{ts,tsx,mts,mjs}', 'apps/*/src/**/*.{ts,tsx}', 'packaging/**/*.mjs'],
    ignores: ['**/*.test.{ts,tsx}', ...PLATFORM_MODULES],
    plugins: { local: platformChecks },
    rules: { 'local/platform-checks': 'error' },
  },
)
