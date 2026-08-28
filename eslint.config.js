import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/** 레이어 규칙의 원본은 docs/architecture.md §2. 여기가 그 기계 강제판이다. */
export default tseslint.config(
  // tmp/: 도그푸딩 중 만드는 일회용 프로브·캡처. 저장소에 남지 않으므로 규칙도 걸지 않는다
  { ignores: ['**/dist/**', '**/node_modules/**', 'spike/**', 'tmp/**', '**/*.cjs', '**/src-tauri/target/**', '**/src-tauri/gen/**', '**/adapters/codex/generated/**', '**/src-tauri/resources/**', '**/*.app/**'] },
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
   * 훅 규칙.
   *
   * "이른 return 뒤에 훅"을 **두 번** 저질렀다 (ProjectBlock, Body). 둘 다 조건이
   * 맞는 순간에만 터지는 런타임 크래시라 타입 검사도 테스트도 잡지 못했고,
   * 두 번째는 그리드를 열자마자 화면이 하얘졌다.
   *
   * 주석으로 "훅은 먼저"라고 적어 두는 걸로는 세 번째를 막지 못한다.
   */
  {
    files: ['packages/ui/**/*.tsx', 'packages/ui/**/*.ts', 'apps/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // 의존성 누락은 "가끔 안 갱신됨"으로 나타나 원인을 찾기 어렵다 — 경고로 남긴다
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
  // core: 순수 도메인 — IO·React 금지
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'zustand'], message: 'core는 순수 도메인 — UI 라이브러리 금지' },
            { group: ['node:*', 'fs', 'path', 'ws', 'better-sqlite3'], message: 'core는 IO 금지 (docs/architecture.md §2)' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'core는 IO 금지' },
        { name: 'WebSocket', message: 'core는 IO 금지' },
        { name: 'window', message: 'core는 DOM 금지' },
        { name: 'document', message: 'core는 DOM 금지' },
      ],
    },
  },
  // ui: 포트만 안다 — 구현체·직접 IO 금지 (docs/platform-abstraction.md §6)
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@tauri-apps/*'], message: 'platform/tauri에서만 사용' },
            { group: ['@cc/platform/web', '@cc/platform/mock', '**/platform/src/web/**', '**/platform/src/mock/**'], message: 'ui는 ports만 — 구현 주입은 apps 진입점에서' },
            { group: ['ws', 'node:*'], message: 'ui는 Node API 금지' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'ui에서 네트워크 직접 호출 금지 — 포트를 거쳐라' },
        { name: 'WebSocket', message: 'ui에서 WS 직접 사용 금지 — 포트를 거쳐라' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='WebSocket']", message: 'ui에서 WS 직접 사용 금지 — 포트를 거쳐라' },
        { selector: "CallExpression[callee.name='fetch']", message: 'ui에서 fetch 금지 — 포트를 거쳐라' },
        { selector: "MemberExpression[object.name='window'][property.name='fetch']", message: 'ui에서 fetch 금지 — 포트를 거쳐라' },
      ],
    },
  },
  // Node 프로세스 코드: Node 전역 허용
  {
    files: [
      'packages/agent-host/**/*.{ts,mts,mjs}',
      'tooling/**/*.{ts,js}',
      'e2e/**/*.ts',
      '*.config.{ts,js}',
      // 배포 도구: npm 실행기와 릴리스 스크립트도 Node 프로세스다
      'packaging/**/*.mjs',
      'scripts/**/*.{mts,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.mjs'], rules: { 'no-empty': 'off', '@typescript-eslint/no-unused-expressions': 'off' } },
  // agent-host: protocol만 공유 (core/ui/platform은 프로세스 반대편)
  {
    files: ['packages/agent-host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@cc/core', '@cc/ui', '@cc/platform/*'], message: 'agent-host는 protocol만 공유 (docs/architecture.md §2)' },
            { group: ['react', 'react-dom'], message: 'agent-host는 Node 프로세스 — 브라우저 코드 금지' },
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
)
