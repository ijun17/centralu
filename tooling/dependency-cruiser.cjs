/** 순환 의존 금지 + 레이어 규칙 이중 방어 (docs/architecture.md §6) */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      comment: '아무도 안 쓰는 파일은 지운다. 예외는 "임포트가 아닌 방식으로 쓰이는 것"뿐이다',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          'index\\.ts$',
          'main\\.tsx?$',
          // codex가 `node <경로>`로 **직접 띄우는** 다리다. 임포트가 없는 것이 정상이고,
          // 경로는 bridge-path.ts가 런타임에 찾고 bundle.mjs가 번들에 복사한다
          'adapters/codex/orchestrator-bridge\\.mjs$',
        ],
      },
      to: {},
    },
    /*
     * 앱 계층 (#81): 격리는 "완전"이 아니라 **단방향 + 소유권**이고, 그 단방향을
     * 관례가 아니라 여기서 강제한다. 앱은 통행증(api/contract)으로만 코어를 만지고,
     * 코어가 앱을 아는 것은 registry(와 계약 타입) 한 줄뿐이다 — 그래야 앱을
     * 뜯어내도 코어에 흉터가 없다.
     */
    {
      name: 'ui-app-guest-pass',
      comment: 'UI 앱 내부는 api/contract 통행증으로만 코어에 (#81)',
      severity: 'error',
      from: { path: '^packages/ui/src/apps/', pathNot: ['^packages/ui/src/apps/(api|contract|registry)\\.tsx?$'] },
      to: { path: '^packages/ui/src/(store|features|app)/' },
    },
    {
      name: 'ui-core-blind-to-apps',
      comment: 'UI 코어가 앱에서 가져올 수 있는 것은 registry·contract뿐 (#81)',
      severity: 'error',
      from: { path: '^packages/ui/src', pathNot: ['^packages/ui/src/apps/'] },
      to: { path: '^packages/ui/src/apps/', pathNot: ['^packages/ui/src/apps/(registry|contract)\\.tsx?$'] },
    },
    {
      name: 'host-app-guest-pass',
      comment: 'host 앱 내부는 contract가 주는 것 밖의 코어에 손대지 않는다 (#81)',
      severity: 'error',
      from: { path: '^packages/agent-host/src/apps/', pathNot: ['^packages/agent-host/src/apps/(contract|registry)\\.ts$'] },
      to: { path: '^packages/agent-host/src/(sessions|dev-services|adapters)/' },
    },
    {
      name: 'host-core-blind-to-apps',
      comment: 'host 코어가 앱에서 가져올 수 있는 것은 registry·contract뿐 (#81)',
      severity: 'error',
      from: { path: '^packages/agent-host/src', pathNot: ['^packages/agent-host/src/apps/'] },
      to: { path: '^packages/agent-host/src/apps/', pathNot: ['^packages/agent-host/src/apps/(registry|contract)\\.ts$'] },
    },
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
    /*
     * 타입 전용 임포트(`import type`)도 의존으로 센다.
     * 이게 없으면 타입만 내보내는 파일(adapters/contract.ts)이 "아무도 안 쓰는 파일"로
     * 잡힌다 — 실제로는 여섯 곳이 쓰고 있다. 가짜 경고가 섞이면 경고를 안 보게 된다.
     */
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
}
