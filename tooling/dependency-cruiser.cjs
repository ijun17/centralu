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
      comment: 'UI 앱 런타임은 이 제품의 층을 아예 모른다 (#81 통행증, #97 방향)',
      severity: 'error',
      // 예전엔 api.ts만 예외로 스토어를 임포트했다 — 그 한 줄이 "인박스를 지우면 런타임이
      // 안 돈다"였다. 이제 통행증은 host.ts가 선언한 표면으로 위임하므로 예외가 없다
      from: { path: '^packages/ui/src/apps/' },
      to: { path: '^packages/ui/src/(store|features|app)/' },
    },
    {
      name: 'ui-core-blind-to-apps',
      comment: 'UI 코어가 앱에서 가져올 수 있는 것은 registry·contract·host뿐 (#81, #97)',
      severity: 'error',
      from: { path: '^packages/ui/src', pathNot: ['^packages/ui/src/apps/'] },
      to: { path: '^packages/ui/src/apps/', pathNot: ['^packages/ui/src/apps/(registry|contract|host)\\.tsx?$'] },
    },
    {
      name: 'host-app-guest-pass',
      comment: 'host 앱 내부는 contract가 주는 것 밖의 코어에 손대지 않는다 (#81)',
      severity: 'error',
      // contract.ts가 오케스트레이터에서 타입을 빌려 오던 예외는 #97에서 사라졌다 —
      // 그 타입들은 이제 contract.ts가 정의하고 오케스트레이터가 가져다 쓴다
      from: { path: '^packages/agent-host/src/apps/', pathNot: ['^packages/agent-host/src/apps/external/'] },
      to: { path: '^packages/agent-host/src/(sessions|dev-services|adapters)/' },
    },
    /*
     * 외부 앱 런타임 (M4 A)은 손님이 아니라 **손님을 태우는 층**이라 규칙이 하나 다르다.
     * 외부 앱은 폴더와 프로세스라서, 런타임은 터미널·명령 실행기가 이미 지키는 OS의 약속
     * 몇 가지를 똑같이 지켜야 한다: 폴더 감시(watch), 뿌리 밖으로 새지 않는 경로(path-guard),
     * 자손까지 끝내는 종료(kill-tree).
     * 그것들을 두 벌 만들면 "트리를 어떻게 죽이나"가 두 벌이 되는 사고가 되풀이된다.
     *
     * 그래서 허용은 **이름으로 좁힌다** — 제품의 뜻이 없는 물리 모듈만. 세션·어댑터는 여전히
     * 금지다(세션은 런타임의 호출자 중 하나다, #97). 저장소(store)도 금지다: 런타임은 필요한
     * 것을 `ExternalAppsDeps`로 선언하고 host가 채운다. 내장 앱(control)은 이 예외를 받지 않는다.
     */
    {
      name: 'host-app-runtime-physics-only',
      comment: '외부 앱 런타임이 코어에서 가져올 수 있는 것은 이름을 댄 물리 모듈뿐 (M4 A)',
      severity: 'error',
      from: { path: '^packages/agent-host/src/apps/external/' },
      to: {
        path: '^packages/agent-host/src/(sessions|dev-services|adapters)/',
        pathNot: ['^packages/agent-host/src/dev-services/(watch|path-guard|kill-tree)\\.ts$'],
      },
    },
    {
      name: 'host-core-blind-to-apps',
      comment: 'host 코어가 앱에서 가져올 수 있는 것은 registry·contract와 외부 앱 런타임의 문뿐 (#81, M4 A)',
      severity: 'error',
      from: { path: '^packages/agent-host/src', pathNot: ['^packages/agent-host/src/apps/'] },
      // external/runtime.ts는 외부 앱 런타임이 코어에 여는 **단 하나의 문**이다 — 그 뒤의
      // 발견·프로세스·중개는 코어가 모른다. registry가 내장 앱의 한 줄인 것과 같은 자리다
      to: {
        path: '^packages/agent-host/src/apps/',
        pathNot: ['^packages/agent-host/src/apps/(registry|contract)\\.ts$', '^packages/agent-host/src/apps/external/runtime\\.ts$'],
      },
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
