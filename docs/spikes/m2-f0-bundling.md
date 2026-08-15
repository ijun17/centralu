# F-0 번들링 스파이크 결과 (2026-08-15)

> **통과.** 배포 `.app`이 번들된 사이드카로 깨끗한 경로에서 동작한다.
> M2의 단일 최대 미지수를 첫날에 제거했다 — 이제 A~E가 실패해도 도그푸딩 경로는 살아 있다.

## 결정 (F-0a): 시스템 Node 실행

| 후보 | 판단 |
|---|---|
| ① Node SEA | **기각** — better-sqlite3가 네이티브 애드온이라 `.node`를 blob에 넣을 수 없고, 주입 후 macOS 재서명까지 필요하다. 도그푸딩 대비 비용이 과하다 |
| ② **시스템 Node** | **채택** — 번들 JS + prebuild `.node` + schema.sql만 동봉하면 끝난다. 도그푸딩은 내 머신 한정이므로 Node 존재를 전제해도 된다 |
| ③ Bun 컴파일 | 보류 — N-API 로딩에 별도 처리가 필요하고 ②보다 이득이 없다 |

교체 지점은 두 곳으로 격리했다: `packages/agent-host/scripts/bundle.mjs`(산출물 만들기)와
`sidecar.rs`의 `host_command()`(실행 방식). 배포 대상이 넓어지면 이 둘만 바꾼다.

## 산출물

```
apps/desktop/src-tauri/resources/host/
  main.mjs                       2.0MB  esbuild 번들 (better-sqlite3만 external)
  schema.sql                            store가 산출물 옆에서 먼저 찾는다
  node_modules/better-sqlite3/          package.json + lib + darwin-arm64 prebuild만
  bundle-info.json                      런타임·플랫폼 기록
```
앱 전체 10MB. `pnpm bundle:host`로 만들고 `tauri build`의 beforeBuildCommand가 자동 실행한다.

## 실측 결과

- 번들 host 단독 실행 (깨끗한 경로 `/tmp`): ready 줄 출력, SQLite·스키마 정상
- `.app` + `.dmg` 빌드 성공
- `/tmp/cc-clean/`에 복사한 `.app` 실행 → **번들 사이드카를 spawn**
  (`/opt/homebrew/bin/node .../Resources/resources/host/main.mjs --port 0 --watch-parent`)
- UI 연결됨, 기존 프로젝트·세션 SQLite에서 복원
- **SIGKILL 후 좀비 0** — M1.5의 stdin EOF 자가 종료가 번들에서도 작동

## 해결한 함정 4가지

1. **schema.sql 경로** — 소스 트리 상대 경로로 읽고 있어 번들에서 깨졌다.
   → 후보 목록(산출물 옆 → 소스 트리) 중 존재하는 것을 고르도록 변경.
2. **네이티브 애드온** — esbuild가 묶을 수 없다. → external 처리 + prebuild만 골라 동봉
   (26MB 전체 복사 회피). `prebuilds/`와 `build/Release/` 양쪽에 두어 로더 구현 차이를 방어.
3. **ESM 번들의 CJS require** — better-sqlite3가 CJS라 `createRequire` 배너를 주입.
4. **GUI 앱의 PATH** — `.app`은 로그인 셸 PATH를 물려받지 못해 `node`를 못 찾는다.
   → `/opt/homebrew/bin/node` 등 흔한 위치를 직접 탐색.

## 남은 것 (F에서 마감)

- 코드 서명·노터라이제이션 없음 — **도그푸딩(내 머신) 범위 밖으로 명시**. 배포하려면 필요하다.
- Node 미설치 환경 안내 없음 — 지금은 spawn 실패 → "agent-host를 시작하지 못했습니다"로만 뜬다.
  F-1에서 "Node가 필요합니다" 안내로 구체화한다.
- `bundle-info.json`은 기록용일 뿐 런타임에서 읽지 않는다 (main.mjs 존재로 prod를 판정).
