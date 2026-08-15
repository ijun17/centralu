/** 순환 의존 금지 + 레이어 규칙 이중 방어 (docs/architecture.md §6) */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn', from: { orphan: true, pathNot: ['\\.d\\.ts$', 'index\\.ts$', 'main\\.tsx?$'] }, to: {} },
    {
      name: 'core-no-io',
      comment: 'core는 순수 도메인 — IO 금지',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { path: '^(packages/(agent-host|ui|platform)/src|node_modules/(ws|better-sqlite3|react))' },
    },
    {
      name: 'ui-no-platform-impl',
      comment: 'ui는 ports만 — 구현체 금지',
      severity: 'error',
      from: { path: '^packages/ui/src' },
      to: { path: '^packages/platform/src/(web|tauri|mock)' },
    },
    {
      name: 'host-no-frontend',
      comment: 'agent-host는 protocol만 공유',
      severity: 'error',
      from: { path: '^packages/agent-host/src' },
      to: { path: '^packages/(ui|core|platform)/src' },
    },
    {
      name: 'protocol-is-leaf',
      comment: 'protocol은 의존 0 (zod 제외)',
      severity: 'error',
      from: { path: '^packages/protocol/src' },
      to: { path: '^packages/(?!protocol)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // src-tauri/target·resources는 Rust·번들 산출물이라 파싱 대상이 아니다 (M2에서 생김)
    exclude: {
      path: '(spike|dist|node_modules|src-tauri/(target|gen|resources)|adapters/codex/generated|\\.test\\.tsx?$)',
    },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
}
