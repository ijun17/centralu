# 릴리스

> 영어 원본: [releasing.md](releasing.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

Centralu의 한 버전이 사용자에게 도달하는 방법을 다룬다. 배포 채널은 npm뿐이다. 다운로드 페이지도, 업데이트 서버도 없다.

## CI runner and action pins

All workflows use explicit hosted runner labels, including matrix values; the guard in
`tooling/workflow-runners.test.ts` rejects floating `ubuntu-latest`, `macos-latest` and
`windows-latest` labels. General Linux jobs use `ubuntu-24.04`. Native Linux bundles keep
`ubuntu-22.04` / `ubuntu-22.04-arm` for their glibc floor; macOS stays on `macos-14`
(arm64), and Windows on `windows-2022`.

Confirmed from the **Runner Image** sections of [build run 38417790949](https://github.com/ijun17/centralu/actions/runs/38417790949)
and [local signing run 38431334485](https://github.com/ijun17/centralu/actions/runs/38431334485)
on 2026-10-14. An OS label pins the OS generation, not GitHub's weekly image revision.
The Ubuntu 26 migration of `ubuntu-latest` starts on 2026-10-19 (#639); a separate PR
should try `ubuntu-26.04` across the matrix before changing these pins.

JavaScript actions use Node 24 releases pinned to full commit SHAs, with version
comments. This action runtime is separate from the host/build Node 22 selected by
`setup-node`. When updating pins, check upstream release notes and `action.yml`, and
exercise the artifact upload/download pair together.

## 패키지가 이런 모양인 이유

npm에는 다섯 개의 패키지가 올라간다:

| 패키지 | 내용 | 설치 대상 |
|---|---|---|
| `centralu` | 런처 스크립트, 몇 KB | 지원하는 모든 플랫폼 |
| `@centralu/darwin-arm64` | `Centralu.app` | macOS, Apple Silicon |
| `@centralu/linux-x64` | `Centralu.AppImage`, `icon.png`, `host/` | Linux, x86-64 |
| `@centralu/linux-arm64` | `Centralu.AppImage`, `icon.png`, `host/` | Linux, arm64 |
| `@centralu/win32-x64` | `Centralu\` 폴더: `centralu.exe`, `resources\host\` | Windows, x86-64 — 0.1.0-beta.9부터 |

**플랫폼 패키지는 0.1.0-beta.10부터 스코프 이름(`@centralu/…`)이다.** 스코프 없는 `centralu-win32-x64`를 처음 올릴 때(0.1.0-beta.8) `403 … Package name triggered spam detection`으로 거부되었다. `@centralu` 스코프는 소유자의 npm 조직 것이라 그 아래 이름은 누구도 가져가거나 선점할 수 없다. 0.1.0-beta.9까지 macOS와 Linux는 `centralu-darwin-arm64`, `centralu-linux-x64`, `centralu-linux-arm64`로 나갔고, 이 패키지들은 사용 중단 표시를 단 채 레지스트리에 남아 그것을 핀한 옛 shim이 계속 설치되게 한다. shim 자체는 사람들이 치는 이름이라 스코프 없는 `centralu`로 두고, 조직의 `developers` 팀을 통해 관리한다. 사용자는 플랫폼 패키지 이름을 칠 일이 없다.

Linux 패키지는 번들 호스트를 한 번 더, 풀린 채로 AppImage 옆의 `host/`로 싣는다. `centralu serve`(원격 모드의 화면 없는
호스트, [agent-host.ko.md](agent-host.ko.md) §4.7)가 그것을 시스템 Node로 돌린다. AppImage 안의 사본은 AppImage를
마운트하거나(서버에 흔히 없는 FUSE) 시작할 때마다 풀어야만 닿는다. 약 11 MB가 든다. macOS와 Windows에는 두 번째 사본이
필요 없다: `Centralu.app/Contents/Resources/resources/host`와 `Centralu\resources\host`는 이미 평범한 폴더다.
`scripts/release-npm.mts`가 `src-tauri/resources/host`에서 복사하고, `main.mjs`, (이 머신용) `bundle-info.json`, 두
네이티브 모듈이 있는지 확인한다.

`centralu`는 나머지를 `optionalDependencies`로 선언하고 각각에 `os`/`cpu` 필드를 달아 둔다. 그래서 npm은 설치를 수행하는 머신에 맞는 번들 딱 하나만 설치한다. esbuild와 swc가 쓰는 것과 같은 구성이며, 이유는 크기다: Linux 머신에 macOS 번들을 내려받을 사람은 없다.

이 구성에서 아래 절차의 모양을 결정하는 귀결이 두 가지 나온다:

- **핀은 범위가 아니라 정확한 버전이다.** 범위를 쓰면 플랫폼 패키지가 혼자 업데이트되어, 런처와 그것이 실행하는 앱의 버전이 서로 어긋날 수 있다. 그래서 모든 플랫폼 패키지는, 그것들을 가리키는 `centralu` shim이 나가기 *전에* 릴리스 버전으로 존재해야 한다.
- **번들은 그것이 배포될 플랫폼에서만 빌드할 수 있다.** `scripts/release-npm.mts`는 이 머신에서 빌드하지 않은 번들의 패키징을 거부한다. 모든 검사 — 코드 서명, 실행 비트, 머신 타입 — 가 실제 아티팩트를 읽기 때문이다. 크로스 빌드 스위치는 의도적으로 없다: 검증되지 않은 것밖에 만들어낼 수 없기 때문이다.

배포는 되돌릴 수 없다. npm은 24시간이 지나면 unpublish를 막는다. 릴리스 스크립트가 기본적으로 리허설만 하고, 아무것도 자동으로 배포되지 않는 이유가 그것이다.

## CI가 하는 일

- `.github/workflows/build.yml` — 모든 push와 PR에서 모든 플랫폼을 빌드하고 번들을 아티팩트로 업로드한다. 프로젝트에 Linux 머신을 가진 사람이 없으므로, Linux 빌드가 실제로 돌아가는 곳은 여기뿐이다. 써 보려면 아티팩트를 내려받는다. GitHub 아티팩트는 zip이라 실행 비트가 사라지므로, 압축을 푼 뒤 AppImage에 `chmod +x`를 해 준다.
- macOS에서 CI는 `--bundles app`을 넘겨 빌드하고, 앱의 실행 비트와 서명을 보존한 `Centralu-app.tar.gz`를 업로드한다. DMG는 더 이상 만들거나 업로드하지 않는다(#628): `bundle_dmg.sh`의 간헐적인 실패가 정상 빌드를 막았고, 그 이미지를 사용하는 워크플로도 없기 때문이다. `release.yml`은 `release-npm.mts`로 앱을 따로 빌드한다. npm이 배포하는 것은 스테이징을 마친 `.app`이며 DMG가 아니므로, 릴리스에는 재시도할 DMG 단계도 없다.
- 같은 워크플로가 **windows-x64**(#14)도 빌드해 아티팩트 두 개를 올린다: 포터블 폴더 `centralu-windows-x64`(`Centralu\centralu.exe` 옆에 `Centralu\resources\host\`)와 NSIS 설치 파일 `centralu-windows-x64-setup`(사용자별 설치, 관리자 권한 불필요). 둘 다 서명되어 있지 않다. 별도의 잡들이 `pnpm verify`의 네 부분을 돌리며, 다른 플랫폼처럼 모두 막는다: `windows tests`는 lint, 의존성 규칙, 타입을, `windows tests (vitest 1/2)`와 `(vitest 2/2)`는 단위 테스트를 `vitest --shard`로 반씩 나란히 돌린다(#1035: 한 잡일 때 16.5분으로 매 실행에서 가장 길었다). `windows tests`라는 이름은 첫 잡에 남아, 나누기 전 main의 워크플로에서 읽은 필수 집합도 그것을 찾는다(단위 테스트 단계는 #307의 W2 목록이 고쳐질 때까지 막지 않았다). npm 패키지 `@centralu/win32-x64`는 같은 폴더를 싣고, `release.yml`의 Windows 잡이 따로 다시 빌드한다(아래 [Windows](#windows-14-w3) 참고).
- 같은 워크플로가 Playwright 시나리오(`e2e/`)를 ubuntu-24.04에서 데스크톱 앱이 그려지는 두 엔진, WebKit과 Chromium으로 돌린다. 엔진마다 나란히 도는 샤드로 나눈다(`e2e (webkit i/n)`, `e2e (chromium i/n)` 잡). CI에서 실패한 테스트는 한 번 더 돈다(Playwright `retries: 1`, 2026-10-19 오너 결정. 그 전에는 실패한 샤드 전체가 잡 안에서 다시 돌아 매번 6분쯤 들었다). 재시도에서야 통과한 테스트는 초록이 아니라 flaky이고 여전히 고칠 테스트다: `e2e/flaky-report.ts`가 그 테스트에 `::warning::`을, 샤드의 요약에 표를 남기고 `e2e report`를 돌게 한다. 샤드가 실패하거나 flaky 테스트가 있으면 `e2e report`가 엔진마다 샤드 리포트를 트레이스가 담긴 HTML 리포트 하나로 합치고(Flaky 필터가 실패한 시도를 보여 준다), 요약에 엔진별 flaky 테스트를 적고, 엔진별 폴더가 든 `e2e-report` 아티팩트로 올린다.
- **시간 제한**(2026-10-19: e2e 샤드 하나가 35분 멈춰 머지 배치를 붙잡았다). 실제 일을 하는 잡마다 `timeout-minutes`가 있고, 값은 최근 full 실행 20번 중 가장 느린 초록 실행에 절반쯤 더한 것이다: e2e 샤드 15분(가장 느린 것 9.7), `verify` 20(10.8), Windows 단위 테스트 25(13.1). Rust 빌드는 캐시를 놓친 실행을 위해 더 둔다(번들 30, 키퍼 end to end 20). 모든 숫자는 `build.yml`의 `e2e` 잡 위 주석에 있다. 제한에 걸린 잡은 GitHub의 "has exceeded the maximum execution time" 주석과 함께 끝나고, 머지 큐는 이를 테스트 실패가 아니라 인프라 실패로 센다(한 번 다시 돌린다).
- **Fail fast**(2026-10-19 오너 결정): 수동 실행(머지 큐의 배치, 또는 사람이 직접 `gh workflow run build.yml`)에서 `verify`가 실패하면 `fail fast` 잡이 실행의 나머지를 곧바로 취소한다. 그런 실행에서는 아무것도 머지되지 않는데, 나머지 잡이 배치와 공유 러너를 10분쯤 더 붙잡고 있었다. 그때 `verify`는 이미 끝났으므로 실행 전체는 `cancelled`로 끝나도 그 체크는 `failure`로 남는다: 큐는 그 실패한 체크로 이 실행을 이유 없이 취소된 실행과 구별하고, 다시 돌리지 않는다. 결정은 `changes`가 한다(`fail_fast`, `.github/scripts/ci-changes.mjs`): PR 실행(quick tier, 또는 릴리스 범프의 full tier), main 자신의 실행, `packages/protocol/src/brand.ts`를 바꾸거나 파일을 알 수 없는 수동 실행은 모두 잡을 끝까지 돌린다. 그래서 **릴리스 범프의 실행은 이것으로 취소되지 않는다**. 잡은 자기 실행만 id로 취소하고 concurrency 그룹은 건드리지 않는다.
- **두 단계(tier)** (2026-10-18 오너 결정): PR은 **quick tier**만 돈다. `changes`, `verify`, Windows 단위 테스트(`windows tests (vitest i/n)`)다. 2026-10-11부터 10-18까지 `verify`를 통과하고도 실패한 PR 실행 94개 중 53개를 Windows 테스트가 잡았다. 나머지 잡은 빠지고 아무것도 보고하지 않는다. **full tier**(모든 잡)는 main 푸시, 수동 실행(`workflow_dispatch`: 사람, 또는 main guard의 bisect), 릴리스 bump PR(버전을 선언하는 `packages/protocol/src/brand.ts`를 바꾸는 PR)에서 돈다. `full tier` 잡은 full 실행에서만 통과하고 quick 실행에서는 skipped다. skipped 잡은 통과로 치므로 보드는 이 체크로 둘을 구분한다. **변경은 빠른 tier를 통과하면 랜딩한다** (#1259, 2026-10-19 오너 결정): 머지 큐는 main 위에 만든 batch(하나짜리 포함)를 수동 실행으로 돌리되 quick tier를 요청하고(입력 `tier: quick`. 릴리스 범프나 main에 있는 커밋은 그래도 full로 돈다), 그 결과로 랜딩한다. full tier는 랜딩한 뒤 main에서 돈다. **화면을 바꾸는 batch는 먼저 무거운 잡을 돌린다** (#1538, 2026-10-26 오너 결정): UI 시나리오가 볼 수 있는 변경(창, 호스트와 프로토콜의 테스트 밖 파일, 시나리오, 빌드, 시나리오가 그리거나 읽는 그 밖의 파일: `ci-changes.mjs`의 `screenFiles`가 유일한 정의이고 큐는 main에서 읽을 뿐 사본을 두지 않으며, `tooling/build-workflow.test.ts`가 `e2e/`와 `apps/web`이 import하고 읽는 파일을 훑어 이를 확인한다)이 들어 있으면 큐가 그 실행을 full tier로 시작하고(`tier: full`, `everything: false`라 파일이 영향 없는 잡은 그대로 뺀다) 실행이 끝났고 두 브라우저의 e2e 샤드가 보고되고 성공하고 시나리오를 실제로 돌린 경우(`pnpm e2e (shard …)` 단계. 건너뛴 샤드의 대역 잡도 같은 이름으로 보고한다)에만 랜딩한다(project.json `ci.screen`). 판단할 수 없는 batch나 tier가 기록되지 않은 batch(옛 보드가 만든 것)는 화면을 바꾸는 것으로 친다. 나머지 batch는 위처럼 빠른 tier 뒤에 랜딩하고 main guard가 안전망이다. 보드는 batch가 어느 tier를 돌렸는지 말한다(batch 줄, 이벤트, 세션이 받는 메시지). 실행 중에 main이 움직여서(큐 밖의 머지) 멈춘 batch의 PR은 새 main 위에서 알아서 다시 묶이며, 머리(head)당 최대 3번이다(#1548). `merge_when_green`은 여전히 quick 실행만 있는 PR을 거절하고, 큐가 같은 브랜치에서 batch를 돌리는 중이면 그렇다고 말하고 `intoBatch: true` 없이는 머지하지 않는다(릴리스 범프는 이 길로 간다). main의 full 실행이 실패하면 보드의 main guard가 마지막으로 완전히 초록이던 커밋 이후의 커밋 중 원인을 찾아, 큐 맨 앞에 revert PR을 넣고(릴리스 범프는 되돌리지 않는다) 이슈를 남긴다. 설정 단계(브라우저 설치, 체크아웃, 캐시)에서만 실패한 실행은 먼저 한 번 다시 돌리며, 러너 자신의 실패 때문에 되돌리지는 않는다. 릴리스는 여전히 완전히 초록인 커밋을 요구한다: 릴리스의 CI 관문은 그 커밋에 대한 main 자신의 push 실행만 보고, batch의 quick 실행은 증거로 쓰지 않는다(아래). PR에 full tier를 직접 돌리려면(UI 작업을 큐에 넣기 전 등) `gh workflow run build.yml --ref <branch>`.
- 첫 잡 `changes`(`.github/scripts/ci-changes.mjs`)는 tier를 정하고, full tier 안에서는 실행이 main에 더하는 파일을 보고(PR의 base 브랜치가 무엇이든 main과의 merge-base와 비교하므로, 쌓인 PR은 스택 전체로 판단한다. 이름 바꾸기는 옛 경로와 새 경로 둘 다로 센다) 영향을 줄 수 없는 잡을 뺀다. 문서만 바꾸면 `verify`, `windows tests`, WebKit UI 시나리오만 돈다. 테스트만 바꾸면 번들, keeper 종단 테스트, 콘텐츠 검증기를 건너뛴다. 창(`packages/ui`, `core`, `platform`, `apps/web`)만 바꾸면 keeper, 콘텐츠 검증기, 원격 Node의 호스트 테스트를 건너뛴다. 빌드나 CI 설정(`tsconfig*.json`, `package.json`, lockfile, vite 설정, `.github/`)을 바꾸면 모두 돈다. **main에 이미 있는 커밋은 모두 돈다.** full 실행에서 빠진 체크도 제 이름으로 보고된다(`skipped`, 또는 matrix 잡이면 이름이 같은 `…-skipped` 대역). quick 실행에서는 둘 다 돌지 않는다. 브랜치 보호나 ruleset이 필수 체크를 정한다면 `changes`와 `full tier`를 넣어야 한다. 수동 실행(`workflow_dispatch`)은 `everything`을 끄지 않는 한 모두 돌리고, 끄면 파일이 필요로 하는 것만 돌린다(여전히 full tier).
- `.github/workflows/release.yml` — **릴리스 그 자체.** `v*` 태그 push가 모든 패키지를 순서대로, 한 번의 실행에서 배포한다. `workflow_dispatch`는 태그 없이 같은 것을 리허설한다(`dry_run`, 기본 켜짐). 아래에서 설명한다. 태그 push는 같은 트리에서 리허설이 성공했으면 플랫폼 잡과 shim의 `pnpm verify`를 건너뛴다(#1042, 2026-10-18 오너 결정: 약 13분). `guard`가 GitHub API로 태그된 커밋과 트리가 같은 커밋에서 성공한 `release.yml`의 `workflow_dispatch` 실행을 찾는다(`scripts/release-rehearsal.mjs`). 그래서 손으로 push한 태그는 그런 리허설 없이는 아무것도 건너뛰지 않고, GitHub이 답하지 않으면 verify를 돌린다. macOS, ubuntu-22.04, arm64에서 verify가 도는 곳은 여전히 리허설이다. 그래서 거기서만 다른 것이 결과를 정하면 안 된다: `pnpm typecheck`는 tsc에 고정된 4 GB 힙을 준다(package.json). Node의 기본값은 기계 메모리의 4분의 1이라, 7 GB인 macos-14 러너에서는 tsc에 모자란다(0.1.0-beta.43 리허설이 거기서 힙이 바닥났다).

브랜치 push나 머지는 여전히 아무것도 배포하지 않는다. **`v*` 태그는 이제 배포한다** — 태그가 존재하는 이유가 그것이다.

### Reusing the bump PR's CI (#629)

For `rehearse` and `tag`, the board can use the bump PR's green required checks while
main's checks are pending or absent. The PR must be merged into main from
`release.branchPrefix` plus the current version, main's head must be its single-parent
squash merge commit, and `git rev-parse <sha>^{tree}` must match for main and the PR head.
Even a later commit with an unchanged tree invalidates this evidence. Every required
check on that exact PR head must be reported and green; missing, pending or failed
checks refuse it, and so does a run that did not pass the `full tier` check, when the required
set names it: a quick run skips every job but `changes`, `verify` and the Windows unit tests, and a
skipped job reads as passed. `bump` still requires main's own green CI.

Main's green checks are used directly. A failing main check blocks reuse, including a
run that was pending at rehearsal and fails before tagging: every call reads CI again.
Both steps and `release_status` name their evidence, for example
`CI: PR #624's run on the same tree`, or explain why main's CI is required. Status's
next step waits for CI when neither source qualifies.

Release CI reads only GitHub Actions check suites belonging to the configured CI
workflow files, matching their run's commit and event: push-to-main for main, and
pull-request runs for the PR head. PR evidence must match its number, base branch,
head branch and commit; when GitHub drops a merged PR from the run, a unique matching
commit-to-PR association is required. Release/rehearsal checks with the same job names
cannot replace build checks; check names alone are not evidence of their source.

Tagging does not authorize publication. Before every `npm-publish` approval (platform
jobs and the later shim job), `approve` requires CI on the tagged commit, using only the tagged
commit: its **own** CI green, or, while that is pending or absent, the bump PR's run on the
same tree (#1042, owner decision 2026-10-18). The PR evidence counts on the rules above (the
merged bump PR for the tagged version, its squash commit the tagged commit, `git rev-parse
<sha>^{tree}` identical for both, every required check reported and green on the PR head, the
`full tier` check passed, the audited workflows): the tagged commit is then exactly the files
that run tested, and main's push build (about 14 minutes) adds nothing to them. Any other tree
waits for main's own run, as before. A failed or cancelled own run still refuses: PR evidence
never overrides a failure. Unrelated later commits on main do not gate platform or shim approval
and cannot strand a partially published release. Pending or absent CI with no PR evidence, and
failed CI, refuse approval, and tagged `release_status` explains this gate before suggesting
approval. Direct approval in GitHub's UI is outside this tool's enforcement.

Generated `chore(release):` bump commits on main use a concurrency group per commit
in `build.yml`; ordinary main pushes keep cancelling superseded ordinary builds,
but cannot cancel a bump's build. Already-cancelled builds and other cancellations
still refuse approval with the tagged SHA and a recovery command:
`gh run rerun <run-id> --repo ijun17/centralu`. The tag stays on that commit. Once the
new attempt succeeds, approval accepts it; an older cancelled attempt cannot override
the newer success. Tagged status shows the same recovery instructions.

`ci_status` with a ref also filters checks to the configured build workflows, so
newer passing release checks cannot hide a failed build. PR merge checks retain their
existing behavior.

Workflow event audit (2026-10-13):

| Workflow and jobs | Event-dependent behavior | Required for this CI gate? |
| --- | --- | --- |
| `build.yml`: `changes`, `bundle`, `verify`, `fail-fast`, `content-verify`, `windows-tests`, `windows-tests-unit`, `e2e`, `e2e-chromium`, `e2e-report`, `ux-tasks`, `host-tests-remote-node`, `keeper`, `keeper-linux`, and the `…-skipped` stand-ins | No job or step branches on push-to-main versus PR. OS, cancellation and earlier-job outcomes select some steps; concurrency isolates release bumps and never cancels a run on main (#1259) without changing test behavior. `changes` (2026-10-17, `.github/scripts/ci-changes.mjs`, reviewed by hand: it reads one fact of the event, whether a pull request is a draft, after deciding a release bump) runs everything for a commit already on main and leaves out of a pull request the jobs its files cannot affect. Tiers (2026-10-18): a pull request runs the quick tier, from the history alone (not on main) and the `everything` input (empty unless a manual run); a manual run with the `tier` input `quick` (the merge queue's batch, #1259) runs the quick tier unless it is a release bump or on main, from the same history (reviewed by hand); a pull request that changes the version's source file is a release bump and runs the full tier, every job, so a bump PR's run is the same set of jobs as main's (`tooling/build-workflow.test.ts` checks the version's source file, and runs the script as the job does). The board takes a bump PR's run only when its `full tier` check passed. A draft pull request runs `changes` alone (#1066: a stack's lower pull requests are drafts); a bump PR runs in full even as a draft, since the bump is decided first. `verify` fetches the newest bundle record a push to main uploaded (measuring main when none has one) and uploads its own, on every event (#1181, `.github/scripts/bundle-base.mjs`, reviewed by hand: it picks main by the run that uploaded, never by this run's event). `fail-fast` (2026-10-19) reads no event context: it runs when `verify` failed and `changes` answered `fail_fast=true`, which the script gives only to a manual run (the `everything` input) off main whose files are known and leave the version's source alone (reviewed by hand), so neither a push to main nor any pull request run, a bump's included, is cut short. | Yes: the configured CI workflow, unless branch protection specifies the set. |
| `release.yml`: `guard`, `platform`, `shim` | Tag push or manual dispatch; `guard` validates the tag on push and dry-run controls publishing. Neither main push nor PR runs it. | No; rehearsal remains a separate tag prerequisite. |
| `shell-release.yml`: `guard`, `build`, `publish` | Manual dispatch only. | No. |
| `local-content-sign.yml`: `validate`, `sign` | Manual dispatch only; real signing requires main. | No. |
| `drift.yml`: `claude-sdk`, `codex-contract`, `codex-types`, `surface` | Schedule or manual dispatch only. `surface` files or updates an issue (`issues: write`). | No. |
| `discord-notify.yml`: `notify` | Issue, PR and discussion notifications (`pull_request_target`, not build CI). | No. |

Before reusing PR evidence, the tool audits the configured `ci.workflows` files from
main's fetched commit against the required check names. A required job with event/branch
context (including inline shell scripts), one outside a shared push/PR workflow, or a required name it cannot
map to an audited job requires main's own run and says why. This is conservative:
unsupported workflow shapes do not grant an exemption. Required job conditions are unchanged; the release-bump concurrency exception above
protects builds that may be tagged while pending.

The automated event audit does not follow scripts called by workflow steps, package
scripts, imported modules, local actions, or reusable workflows. Those need manual
review for event-dependent behavior (including environment variables) when they
change. A clean inline scan is not proof that called code behaves identically. If a
required called script behaves differently on push-to-main and pull requests, wait
for main's own green run before invoking `rehearse` or `tag`; the automated fallback
cannot establish equivalence for that script. Publication still waits for main's
own CI through the approval gate above, or for the same bump PR evidence on the tagged commit's
very tree.

## 1회성 설정

1. **Bypass 2FA**가 켜진 npm 토큰을 만든다 (npmjs.com → Access Tokens → Granular). UI에서 예전에 *automation* 토큰이라 부르던 것이 지금은 이 체크박스다. publish 타입 토큰은 여전히 일회용 코드를 요구하는데, 워크플로에는 그것을 입력해 줄 사람이 없다: 첫 릴리스에서 풀 빌드가 끝난 뒤에야 이것이 맨몸의 `EOTP`로 드러났다(#29).
2. Repo → Settings → Environments → **New environment**, 이름은 `npm-publish`. 자신을 required reviewer로 추가한다. 토큰은 그 환경에 시크릿 `NPM_TOKEN`으로 추가한다 — repo 레벨이 아니라 환경 안에 두어야 다른 워크플로가 접근할 수 없다.

## 버전 릴리스하기

프로젝트 보드 앱(`.centralu/apps/project-board`)이 이 단계들을 도구로 갖고 있다(#386): `release_status`는 릴리스가 어디까지 왔고 다음이 무엇인지 말하고, `release`는 `step`으로 `bump`, `rehearse`, `tag`, `approve`를 받는다. 각 단계는 maintain이나 admin 권한이 있는 로그인만 쓸 수 있고, 먼저 모든 것을 확인하며(GitHub의 main과 같은 main에 있는 깨끗한 체크아웃, main의 CI green, 태그가 없는 버전, 태그 전에 성공한 리허설) 이유를 모두 들어 거부하고, `confirm: true` 없이는 아무것도 하지 않는다. 보드의 "Release" 대화상자가 같은 상태를 보여 준다.

bump는 원격 main에서 git이 추적하는 모든 텍스트 파일을 검사한다. 확장자로 거르지 않고 e2e도 포함한다. 목록에 없는 버전 참조는 `파일:줄`로 보고한다. 정확한 현재 버전뿐 아니라 뒤에 `.local.N`이나 `+build`(점으로 구분한 빌드 식별자도 가능)가 붙은 값, 템플릿 문자열 안의 값, 따옴표 없는 값도 찾는다. 다른 프리릴리스나 메타데이터는 같은 버전으로 보지 않는다: `1.0.0-beta.21`, `1.0.0-rc`, `1.0.0+other`는 `1.0.0`을 고정한 참조가 아니다. 숫자나 영문자가 이어진 다른 버전(`beta.21`을 검사할 때의 `beta.210`)도 제외한다. `package.json`에서는 최상위 `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` 필드의 값이 `^`, `~`, `>=`, `workspace:`로 시작할 때만 의존성 범위로 보고 제외한다. 정확한 버전 핀, 패키지 자신의 `version`, 스크립트와 그 밖의 필드는 원래 줄 번호를 유지해 검사한다. 자동 치환은 여전히 `release.versionFiles`에 선언된 작은따옴표나 큰따옴표로 감싼 버전 전체만 바꾼다. 실행 코드와 테스트에서 조합하는 값은 `APP_VERSION`에서 유도한다.

과거 기록과 의도적으로 고정한 버전은 `.centralu/apps/project-board/project.json`의 `release.ignore`에 명시한다. 이 경로 허용 목록은 `versionFiles`와 같은 패턴을 쓴다: `*`는 경로 한 구간 안에서, `**`는 폴더 0개 이상에 걸쳐 일치한다. 이 저장소는 `docs/**/*.md`, `**/CHANGELOG*`, `**/release-notes/**/*.md`, `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/npm-shrinkwrap.json`, `**/*.lock`을 허용한다. 이 파일들은 `versionFiles`에도 선언되어 있을 때만 검사한다. `versionFiles`가 우선이므로 `Cargo.lock`에 있는 앱 자신의 버전은 여전히 현재 버전이어야 하고 bump 때 함께 바뀐다.

과거 버전을 의도적으로 고정한 fixture는 `"fixtures/pinned-version.json"`처럼 정확한 경로를 `release.ignore`에 넣고, fixture나 테스트에서 고정한 이유를 설명한다. `tooling/project-board-release.test.ts`는 회귀 테스트에서 안정 버전과 프리릴리스 버전을 의도적으로 고정하므로 명시적으로 허용한다. 그 밖의 fixture와 테스트는 기본적으로 제외하지 않는다. 파일 전체를 건너뛰므로 예외는 좁게 둔다. `release`에 `step: "bump"`를 주고 `confirm`을 생략하면 push하거나 릴리스 PR을 열지 않고 이 검사를 실행한다. main 브랜치가 아닌 경우처럼 다른 릴리스 준비 조건에 걸린 이유도 함께 보고한다.

손으로 하는 단계:

1. `packages/protocol/src/brand.ts`의 `APP_VERSION`을 올리고, 같은 버전을 `.centralu/apps/project-board/project.json`의 `release.versionFiles`에 있는 모든 파일에 반영한다: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`(과 `Cargo.lock`), `apps/desktop/package.json`, 그리고 모든 `packaging/npm/*/package.json`(shim의 핀 포함). 하나라도 어긋나면 `tooling/brand.test.ts`가 실패하고, 버전을 가진 파일이 그 목록에 없으면 `tooling/project-board-release.test.ts`가 실패한다. 커밋하고 push한다 — 릴리스 스크립트는 더러운 트리에서는 실행을 거부하므로, 배포되는 것과 git에 있는 것이 서로 다를 수 없다.

   보드의 `bump`는 다른 빌드가 러너 대부분(`release.runners`의 4분의 3, 여기서는 GitHub의 20)을 쓰고 있으면 경고한다: bump PR의 잡 24개가 그 뒤에서 기다리게 되고, 0.1.0-beta.26에서 5–7분이 들었다(#1035).

2. **리허설한다.** Actions → `release` → Run workflow, `dry_run`은 체크된 채로 둔다. 모든 플랫폼을 빌드하고 모든 패키지를 pack하되 아무것도 배포하지 않는다. 머지한 뒤가 아니라 bump 풀 리퀘스트의 CI가 도는 동안 그 브랜치에서 돌린다(#1035, 임계 경로에서 약 27분): main의 버전이 아직 릴리스된 버전인 동안 보드의 `rehearse`가 그렇게 한다. `guard`는 그 브랜치의 `brand.ts`에서 버전을 읽고 ref는 태그 push에서만 확인하므로 어느 브랜치에서 실행해도 리허설이 된다(`scripts/release-guard.mjs`, `tooling/release-guard.test.ts`가 돌린다). 브랜치에서의 배포는 `npm-publish` 환경의 브랜치 정책(main과 `v*`만)이 거부한다. squash는 main에 트리가 같은 새 커밋을 만들고, `tag`는 bump PR의 CI를 받아들이듯(#629) 커밋 트리가 main과 같은 bump 브랜치의 성공한 리허설을 받아들인다. 브랜치가 main에 맞춰져 있을 때만 리허설한다: 그렇지 않으면 squash가 다른 파일을 빌드하게 되므로 `rehearse`가 거부한다. 승인도 요구하지 않는다: `npm pack`에는 토큰이 필요 없고, 리허설에 게이트를 두면 시도할 때마다 승인이 하나씩 든다 — 첫 릴리스에서 그런 식으로 세 번을 썼다.

   각 패키지의 `npm pack` 출력을 읽는다. shim 잡은 플랫폼 패키지들이 이 버전으로 레지스트리에 없다는 노란 경고로 끝나는데, 그것은 리허설이라는 사실 그대로일 뿐 결함이 아니다.

3. **태그를 단다.** 태그가 곧 릴리스다:

   ```bash
   git tag v0.1.0-beta.3 && git push origin v0.1.0-beta.3
   ```

   `release.yml`은 무언가를 빌드하기 전에 태그를 `APP_VERSION`과 대조한다. 그래서 잘못된 커밋에 단 태그나 버전 범프보다 앞서 나간 태그의 비용은 Rust 릴리스 빌드 네 번이 아니라 몇 초다. 고치려면: `git push --delete origin <tag>`, 수정하고, 다시 태그를 단다.

4. **승인한다.** 배포는 `npm-publish` 환경에서 대기한다. GitHub은 두 번 묻는다: 함께 대기하는 네 플랫폼 잡에 대해 한 번, 모두 성공한 뒤 shim 잡에 대해 다시 한 번. 그 두 번째 승인이 아직 무언가를 되돌릴 수 있는 마지막 순간이다.

   보드의 `approve`는 매번 게이트를 확인한다: 태그된 커밋 자신의 CI가 green이고(그것이 아직 pending이면 트리가 똑같은 bump PR의 실행으로 대신한다, #1042), shim 앞에서는 그 실행의 다른 잡이 모두 성공했으며 모든 플랫폼·호스트 전용 패키지가 이 버전으로, 태그된 커밋(`gitHead`)에서 배포되어 레지스트리에 있어야 한다. `wait: true`(와 `confirm: true`)를 주면 그 게이트를 기다렸다가 통과하는 순간 승인한다. 사람이 나중에 알아차리기를 기다리지 않는다(#1035: 0.1.0-beta.26에서 플랫폼 앞 5–6분, shim 앞 14분). 최대 `waitMinutes`(기본 45, 많아야 60)까지 기다리고, 시간이 다 되면 아무것도 승인하지 않고 무엇을 아직 기다렸는지 말한다. 저절로 통과할 수 없는 것(실패한 CI, 실패한 플랫폼 잡, 다른 커밋의 패키지)은 `wait` 없이와 같이 곧바로 거부한다. 태그 뒤에 한 번, 플랫폼 승인 뒤에 한 번 더 부른다. 두 승인은 그대로 남는다. 게이트는 태그된 커밋의 필수 체크를 main이 아니라 그 커밋 자신의 `build.yml`에서 읽는다: main에 나중에 생긴 잡은 태그된 커밋에서 보고되지 않는다. 그 커밋의 빌드 실행이 모두 끝났는데도 빠진 필수 체크가 있으면 곧바로 거부한다. 기다리는 호출은 처음 읽은 것(버전, 태그된 커밋, 릴리스 실행)만 승인한다. 그중 하나가 바뀌거나, GitHub이 아직 대기 중인 잡을 보여 주지 않아 플랫폼과 shim을 구별할 수 없으면 승인하지 않는다. 취소된 호출은 아무것도 승인하지 않는다.

5. 한 번도 설치한 적 없는 머신에서 확인한다: `npm i -g centralu@beta && centralu`.

### 태그 방식 (#1501)

릴리스마다 세 번 돌던 전체 CI(마지막 머지 뒤의 main, bump PR, bump squash 뒤의 main)가 한 번이 된다: 버전은 빌드할 때 태그에서 찍히므로 어느 파일에도 없고, bump PR도 bump 커밋도 없다. 태그는 이미 완전히 초록인 main의 커밋에 붙는다. 단계로 들어간다: 먼저 guard와 보드의 경로(두 방식을 모두 받으며, 전환 전까지 아무것도 바뀌지 않는다), 그다음 찍기와 전환, 마지막으로 옛 경로 제거. 설계와 리뷰는 #1501에 있다. **이 저장소는 전환 뒤 태그 방식이다**(`release.scheme: "tag"`, `brand.ts`가 버전을 가져온다): 위의 bump 단계는 0.1.0-beta.37까지의 릴리스를 설명하며, 옛 경로를 지울 때까지 남는다.

- **빌드의 버전이 오는 곳.** git에는 버전이 없다. `scripts/app-version.mjs`가 정한다: `CENTRALU_VERSION`, 없으면 HEAD에서 닿는 최신 `v[0-9]*` 태그, 그것도 없으면 패키징 빌드는 거부한다(shallow checkout, fork). 버전을 담는 파일은 자리표시자 `0.0.0-dev`로 커밋된다(찍힌 채 커밋되면 `tooling/brand.test.ts`가 실패한다): `packages/protocol/src/version.generated.ts`(UI, 호스트, 스크립트의 `APP_VERSION`), `tauri.conf.json`, `apps/desktop/package.json`, `Cargo.toml`과 `Cargo.lock`, shim의 고정 버전을 포함한 모든 `packaging/npm/*/package.json`. `scripts/stamp-version.mjs`가 `version.generated.ts`, `tauri.conf.json`, npm 매니페스트에 버전을 쓰고, `--restore`가 자리표시자로 되돌린다. `release-npm.mts`는 `pnpm verify`를 커밋된 그대로, 자리표시자 상태에서 `CENTRALU_VERSION` 없이 돌린 뒤(가드 테스트는 자리표시자를 기대한다: 먼저 찍으면 beta.38 리허설의 모든 Linux 잡에서 17개가 실패했다) 빌드 전에 찍고(`verifyThenStamp`, `scripts/release-verify.mjs`), 그 버전으로 콘텐츠 매니페스트에 서명한다. `pnpm app`(`scripts/app-build.mts`)은 찍고, 빌드하고, 실패나 Ctrl-C에도 되돌린다. `local-update`는 버리는 클론에 찍는다. `bundle.mjs`는 그 버전 필드만 다른 트리를 dirty로 보지 않는다. Rust에는 아무것도 컴파일되어 들어가지 않는다: 창은 찍힌 `tauri.conf.json`을 실행 중에 읽고(`package_info()`) 키퍼에 `--app-version`으로 넘기며, 빌드된 호스트를 돌리는 키퍼는 이제 이것을 요구한다. `pnpm dev`, `pnpm host`, `pnpm app:dev`와 테스트는 `0.0.0-dev`로 돈다: 그런 호스트는 `dev`이고, 연결된 머신에 아무것도 설치하지 않고, "자동 업데이트"에 무엇이 저장되어 있든 릴리스를 스스로 설치하지 않으며(`installsByItself`), 업데이트 줄은 최신 릴리스를 더 새 버전으로 보여 준다. `version.generated.ts`는 처음 설계처럼 gitignore하고 설치 때 쓰는 대신 커밋된다: `pnpm pre-pr`는 설치하지 않은 worktree에서 타입 검사를 하므로, 파일이 없으면 실패한다. 찍는 스크립트는 `bundle.mjs`가 그냥 node로 돌리므로 `.mjs`다. CI의 `bundle` 잡은 태그를 가져와 가장 새 태그를 빌드 전에 찍으므로, 그 산출물은 커밋이 잘려 나온 릴리스를 담는다(태그 없는 fork는 자리표시자를 유지한다).

- **어느 방식인가.** `release.yml`의 guard(`scripts/release-guard.mjs`)가 `brand.ts`를 `sourceScheme`(보드의 `versions.mjs`, `project.json`의 `release.source`)으로 읽는다: 리터럴 `APP_VERSION`이 있으면 위의 brand 방식이다. 태그 방식에는 긍정적인 근거가 필요하다: `./version.generated.js`에서 `APP_VERSION`을 가져오는 줄, 또는 파일에 `APP_VERSION`이 아예 없는 것. 그 밖의 선언(다른 따옴표, 타입 표기, 계산된 값)은 실행을 멈춘다: "tag"로 짐작하면 어떤 버전의 태그든 배포되기 때문이다. 보드는 `project.json`의 `release.scheme`을 따르며(기본 "brand", 전환하면 "tag"), 릴리스할 각 커밋을 같은 함수로 읽는다.
- **태그 push만 배포한다.** 태그 방식에서 수동 실행은 `dry_run`이 무엇이든 언제나 리허설이다: 자유로운 버전의 수동 배포는 태그 없는 버전을 npm에 남긴다. 리허설은 `version` 입력, 없으면 최신 태그 다음 prerelease를 빌드하고, 보드가 어느 버전의 리허설인지 알 수 있도록 `rehearse <version>`이라는 이름을 갖는다(`run-name`).
- **guard가 태그에 요구하는 것**(트리가 더 이상 버전을 묶지 않으므로, 손으로 push한 태그도 이것을 지나야 한다): 최신 `v[0-9]*` 태그일 것, 이전 태그가 태그된 커밋의 조상일 것, checkout이 shallow가 아닐 것(guard의 checkout은 전체 히스토리, `fetch-depth: 0`: shallow면 이전 태그가 보이지 않아 그에 대한 검사가 묻지도 않고 통과한다), 커밋이 기본 브랜치에 있을 것, 버전이 레지스트리에 있는 `centralu`의 모든 버전보다 뒤일 것, 이전 태그가 보이지 않으면 레지스트리에 `centralu`가 하나도 없을 것, 이전 버전의 `centralu`가 레지스트리에 있을 것(동시에 두 태그가 dist-tag를 두고 경쟁하지 않도록), `centralu@<version>`이 없거나 바로 이 커밋에서 배포된 것일 것(같은 릴리스의 재실행). guard의 `version`은 플랫폼과 shim 잡에 잡 수준의 `CENTRALU_VERSION`으로 전해져 `pnpm install`도 본다.
- **보드.** `bump`는 거부한다. `release_status`, `rehearse`, `tag`는 최신 태그 다음 prerelease(또는 `version`)와, 그 태그 이후 main의 커밋 중 자기 push 실행의 CI가 전체 tier까지 완전히 초록인 가장 새로운 것(또는 `commit`)을 쓰되, `brand.ts`가 아직 버전을 선언하는 커밋은 건너뛴다(guard가 그 태그를 거부해 번호만 소모된다). 최신 태그가 아직 릴리스되지 않았으면(실행이 성공하지 않았고 shim이 레지스트리에 없으면) 둘 다 거부한다. guard도 거부할 것이기 때문이다. `tag`는 그 커밋(또는 같은 트리)에서 그 버전의 리허설이 성공했어야 하며, 메시지가 릴리스 노트인 annotated 태그를 push한다: bump PR이 없으므로 노트는 태그에 남는다(소유자 기본값, 2026-10-24: GitHub Release 없음). `approve`는 태그된 커밋 자신의 CI만 읽는다. shim의 게이트는 그대로다. 상태는 최신 태그의 릴리스 실행이 성공하거나 그 shim이 레지스트리에 올라갈 때까지 그 태그를 따른다.
- **원격 dev 빌드**(`pnpm remote-dev`)는 그곳 작업 사본의 HEAD에서 닿는 최신 릴리스 태그에서 잘라 낸다. `app-version.mjs`가 로컬 빌드의 버전을 정하는 방식과 같다: `<tag>.local.N`. 태그가 없는 클론은 `git fetch --tags`를 안내하며 거부한다(전환 전 커밋은 자기 버전을 아직 담고 있어 그것을 쓴다). 자리표시자는 기준이 되지 않는다: `0.0.0-dev.local.N`은 모든 릴리스보다 오래된 버전이 되기 때문이다. 전환 전의 허브는 그런 작업 사본을 그냥 거부한다. 실행되는 스크립트는 허브의 것이기 때문이다.

### 잡 그래프가 보장하는 것

```
guard ──┬── linux-x64 (ubuntu-22.04) ──────┐
        ├── linux-arm64 (ubuntu-22.04-arm) ─┤
        ├── darwin-arm64 (macos-14) ────────┤
        └── win32-x64 (windows-2022) ───────┴── centralu (shim)
```

shim은 플랫폼 패키지들을 *정확한* 버전으로 핀하므로, 그 전부가 이미 레지스트리에 올라가 있어야만 나갈 수 있다. matrix 잡에 대한 `needs`는 **모든** 항목의 성공을 의미한다 — 플랫폼이 추가되어도, 누가 갱신을 기억하지 않아도 이 성질은 계속 참이다. `scripts/release-npm.mts`는 shim을 배포하기 전에 레지스트리를 직접 다시 확인하므로, 그래프는 유일한 방어선이 아니라 첫 번째 방어선이다.

`tooling/release-workflow.test.ts`는 matrix와 shim의 `optionalDependencies`를 양방향으로 같은 목록에 묶어 둔다: 빌드할 잡이 없는 핀은 반쯤 배포된 릴리스를 좌초시키고, shim이 핀하지 않는 플랫폼의 잡은 자기 앱을 찾지 못하는 런처를 사용자에게 배포한다.

### 잡이 중간에 실패했을 때

되돌려지는 것도 없고, 되돌릴 필요도 없다. 같은 실행(run)에서 실패한 잡을 다시 실행한다: 플랫폼 잡은 자기 빌드와 배포를 다시 돌리고, shim 잡은 모든 플랫폼이 green이 되면 혼자서 다시 돈다. 이 버전으로 이미 레지스트리에 있는 패키지는 재배포 시 잡이 실패할 뿐(`EPUBLISHCONFLICT`) 피해를 입히지 않는다 — 정말로 다시 빌드해야 하는 버전이라면 다음 prerelease로 올린다.

The shim probes every platform and host-only package immediately, then up to twenty more
times, 30 seconds apart (ten minutes of waits), matching the update installer's retry (#586).
The previous nine waits (4 min 30 s) expired before 0.1.0-beta.18 became visible. A rehearsal
probes once and warns without waiting.

Before rehearsing, run `node .centralu/apps/project-board/bin/wait-checks.mjs --ref main`;
`--ref <sha>` also works.
The ref is resolved once; output includes its pinned SHA, such as `repo@main (abc1234)`.
It allows workflow runs to register and waits for active runs to complete before deciding
on checks, including jobs that register late.
The `<pr|owner/repo#pr>` form still waits for a pull request.
The default deadline is 90 minutes; use `--timeout-minutes <minutes>` with either form to
change it. Waiting for approval (`waiting` or `action_required`) ends immediately with an
action-needed message. No workflow runs and no checks for two minutes means "nothing to wait
for". Cancelled runs have their own outcome; "superseded by a newer push (cancelled)" is shown
only when a newer run on the same workflow, branch, event, and repository has a different SHA.
A failed `gh` request gets three retries after 1, 2, and 4 seconds. Polling, retries, and `gh`
subprocesses all share the overall deadline.

| Exit | Meaning |
|---|---|
| 0 | Checks passed |
| 1 | Checks failed |
| 2 | Invalid arguments or GitHub error after retries |
| 3 | Approval or other action required |
| 4 | Nothing to wait for after the registration grace period |
| 5 | Cancelled, with supersession reported when confirmed |
| 6 | Overall timeout |

Release tools still enforce the required-check set.

### 수동 배포

여전히 지원되며, Actions가 죽었을 때의 대비책이기도 하다. Apple Silicon Mac에서:

```bash
pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
pnpm release:npm --publish             # publishes @centralu/darwin-arm64, then centralu
```

Linux와 Windows는 먼저 CI에서 나와야 한다 (`dry_run`을 끈 `release.yml`). 두 번째 명령은 핀된 플랫폼 패키지 중 하나라도 이 버전으로 레지스트리에 없는 동안에는 shim 배포를 거부하기 때문이다.

릴리스 빌드는 `.app`만 만들고, 일반 `pnpm app` 빌드가 함께 만드는 `.dmg`는 만들지 않는다. 릴리스는 배포하는 것만 빌드해야 하고, Tauri의 `bundle_dmg.sh`는 코드와 무관한 이유로 실패할 수 있기 때문이다: `osascript`로 Finder를 조작하므로, GUI 세션이 없으면 Automation 접근이 거부될 수 있다. PR과 main의 CI도 이제 `.app`만 빌드한다. 기본 로컬 Tauri 설정에는 여전히 `.dmg`가 포함되지만, CI와 npm 릴리스 모두 DMG를 배포하지 않는다. 로컬 DMG는 `bundle-stage.mts`가 실행되기 전에 만들어지므로, 스테이징된 셸과 서명된 콘텐츠를 싣지 않는다.

플래그:

| 플래그 | 하는 일 |
|---|---|
| `--skip-build` | `target/release/bundle`에 이미 있는 번들을 재사용한다 |
| `--otp=123456` | 일회용 코드. 2FA 계정에서 코드를 요구하는 토큰을 쓸 때 |
| `--platform-only` | shim이 아니라 플랫폼 패키지만 — 각 플랫폼 잡이 실행하는 것 |
| `--shim-only` | shim만. 번들도, 특정 호스트도 필요 없어 어디서든 돌아간다. 순서를 마지막으로 지키게 하는 것은 레지스트리 검사다 |
| `--also-latest` | `latest` dist-tag도 이 prerelease를 가리키게 한다 |

`--also-latest`는 `release.yml`에서 기본으로 켜져 있고 **1.0에서 꺼야 한다.** 이것이 존재하는 이유는, 안정 릴리스가 없는 동안에는 `latest`가 비어 있어서 태그 없는 `npm i -g centralu`가 "No matching version found for centralu@latest"로 곧바로 실패하기 때문이다. 안정 릴리스가 생긴 뒤에도 `latest`를 prerelease로 옮기면, 안정판을 원한 모든 사람에게 베타를 쥐여 주게 된다: 1.0 버전 범프와 동시에 워크플로 `guard` 잡의 `also_latest=true`와 input의 기본값을 `false`로 바꾼다.

## 플랫폼 추가하기

1. `scripts/release-npm.mts`의 `TARGETS`에 항목을 추가한다 — 번들 위치, 복사 방법, 그리고 복사본이 온전하고 실행 가능하며 올바른 머신용임을 증명하는 검사들. 그 플랫폼에 대응물이 없다는 이유로 검사를 건너뛰지 말고, 그 검사가 무엇을 대신하고 있었는지를 찾는다. (Linux에는 코드 서명이 없으므로 대신 AppImage 매직을 검사한다: 서명 검사의 요점은 "이 파일이 우리가 생각하는 그 파일이고 잘려 있지 않다"였다.)
2. `os`/`cpu`/`files`를 맞춘 `packaging/npm/<id>/package.json`을 추가한다.
3. `packaging/npm/centralu/package.json`의 `optionalDependencies`와 `os`에 추가한다.
4. 버전 핀이 강제되도록 `tooling/brand.test.ts`의 목록에 추가한다.
5. 런처가 이를 찾아서 실행하도록 가르친다: `packaging/npm/centralu/bin/platform.mjs`의 `TARGETS`에 항목을 넣고(`tooling/launcher-platform.test.ts`가 shim의 핀과 대조한다), 실행에 필요한 것은 `centralu.mjs`에 넣는다.
6. 모든 push가 빌드하도록 `.github/workflows/build.yml`의 matrix에 추가한다.
7. 모든 릴리스가 배포하도록 `.github/workflows/release.yml`의 matrix에 추가한다.
   3번과 7번은 함께 들어가야 한다 — `tooling/release-workflow.test.ts`는 어느 한쪽만 있으면 실패하는데, 그것이 요점이다: 잡 없는 핀은 반쯤 배포된 릴리스를 좌초시키고, 핀 없는 잡은 자기 앱을 찾지 못하는 런처를 사용자에게 배포한다.

## Windows (#14, W3)

위의 일곱 단계는 0.1.0-beta.8을 위해 한꺼번에 들어갔다. 이유는 아래 linux-arm64 절과 같다: 핀은 그것이 가리키는 것을 배포하는 바로 그 변경에서만 추가할 수 있다.

**패키지.** `@centralu/win32-x64`(`os: win32`, `cpu: x64`)는 W1(#307)부터 `build.yml`이 올리던 포터블 폴더를 싣는다: `Centralu\centralu.exe` 옆에 `Centralu\resources\host\`. Tauri는 설치된 것이 없으면 exe 옆에서 리소스를 찾으므로, 폴더는 npm이 풀어 놓은 자리에서 그대로 실행된다. 네이티브 Node를 쓰는 ARM64 Windows는 이 패키지를 건너뛰고, 런처는 아직 지원하지 않는 플랫폼이라고 알린다. 그쪽으로는 아무것도 배포하지 않는다.

**릴리스 잡.** `release.yml` 플랫폼 matrix의 `win32-x64`, `windows-2022`에서, 다른 잡과 같은 `npm-publish` 게이트 뒤에서 돈다. `scripts/release-npm.mts`는 다른 타깃처럼 실행하되 세 가지가 다르며, 각각 그 자리에 주석이 있다:

- `tauri build --no-bundle`로 빌드한다. 배포되는 것은 NSIS 설치 파일이 아니고, 릴리스는 배포하는 것만 빌드한다.
- `pnpm verify` 대신 `pnpm lint`, `pnpm depcruise`, `pnpm typecheck`를 돌린다. 단위 테스트에는 Windows에서 알려진 실패가 있다(#307의 W2 목록). 전체 `pnpm verify`는 같은 커밋으로 다른 모든 플랫폼 잡과 shim 잡에서 돌고, 그것들이 모두 통과해야만 shim이 나갈 수 있다. W2 목록이 비면 이 예외를 없앤다.
- 코드 서명과 실행 비트 대신 PE 헤더를 검사한다: `MZ`와 `PE\0\0`(우리가 생각하는 그 파일인지), 서브시스템이 GUI인지(콘솔 서브시스템 exe는 실행할 때마다 콘솔 창을 연다), 머신이 x86-64인지, `main.mjs`, `conpty.node`, `conpty/conpty.dll`이 옆에 있는지.

**Windows에서 런처가 하는 일** (`packaging/npm/centralu/bin/platform.mjs`, 모든 OS에서 `tooling/launcher-platform.test.ts`가 검사한다):

| 명령 | 하는 일 |
|---|---|
| `centralu` | 레지스트리에서 WebView2 Runtime을 확인한다. 없으면 창 없이 끝나 버릴 exe를 실행하는 대신 내려받을 링크를 출력하고 끝낸다. 있으면 `centralu.exe`를 **detached**로 실행한다 — 설치된 복사본이 있으면 그것을, 없으면 npm 패키지 안의 것을. 그리고 3초 동안 지켜본다: 그 안에 0이 아닌 코드로 끝나면 WebView2 링크와 `host.log` 경로를 담은 메시지를 출력한다 |
| `centralu install` | 폴더를 `%LOCALAPPDATA%\Programs\Centralu`로 복사하고 시작 메뉴 바로 가기(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Centralu.lnk`)를 만든다. 새 복사본은 옛 복사본 옆에서 조립된 뒤 폴더 이름 바꾸기 두 번으로 바꿔 끼워지므로, 복사가 실패해도 동작하던 설치는 그대로 남는다. 바꿔 끼우기는 앱이 실행 중이어도 된다(아직 쓰이는 옛 복사본은 나중 설치가 쓸어 낼 때까지 `Centralu.old-<시각>`으로 남는다). 어떤 프로세스의 작업 디렉터리가 폴더 안에 있을 때만 거부된다 |
| `centralu update` | `npm i -g centralu@<latest>`(`npm`이 `npm.cmd`라서 셸을 거친다), 그리고 설치된 복사본이 있으면 갱신한다 |
| 앱 안의 업데이트 | 호스트가 같은 두 단계를 셸 없이 돌린다([agent-host.ko.md](agent-host.ko.md) §4.5). 그 뒤 "Restart Centralu to finish updating". 0.1.0-beta.12까지의 빌드는 여기서 `spawn npm ENOENT`로 실패하므로, 그 빌드에서는 터미널에서 `centralu update`를 한 번 |
| `centralu uninstall` | 복사본과 바로 가기를 지운다. `%USERPROFILE%\.centralu`는 건드리지 않는다 |

Linux처럼 패키지를 가리키는 바로 가기가 아니라 macOS처럼 복사본을 두는 이유: Windows는 실행 중인 프로그램의 파일을 바꿔치기하지 못하게 한다. 앱이 npm 패키지 안에서 실행 중이면 `npm i -g centralu@newer`는 EBUSY로 실패한다. 복사본에서 실행하면 패키지는 자유롭게 업데이트된다. 어느 쪽이든, 앱이 아직 실행 중이라서 Windows가 거부했을 때는 런처가 그렇게 말해 준다.

detached는 선택이 아니다. libuv는 detached가 아닌 모든 자식을, 부모가 끝나면 자식도 죽이는 job object에 넣는다. 그래서 붙어 있는 앱은 런처가 반환되거나 콘솔 창이 닫히는 순간 같이 닫힌다. `windowsHide`는 끈 채로 둔다: 프로세스를 SW_HIDE로 시작시키는데, GUI 프로그램은 그것을 첫 창에 적용해 버린다.

**서명 없음: SmartScreen.** Windows 코드 서명은 없다. SmartScreen은 브라우저가 다운로드에 붙이는 mark-of-the-web을 기준으로 삼는데 npm은 그것을 붙이지 않으므로, npm 설치는 경고 없이 실행될 것으로 예상한다. macOS quarantine과 같은 논리지만 Windows에서는 측정하지 않았다. zip으로 내려받은 CI 아티팩트에는 그 표시가 붙는다. SmartScreen이 "Windows의 PC 보호" 창을 띄우면 **추가 정보 → 실행**을 누른다. Smart App Control(깨끗하게 새로 설치한 Windows 11에서만 기본으로 켜진다)은 그런 버튼 없이 서명 없는 exe를 아예 막을 수 있는데, 이 exe를 막는지는 모른다.

**WebView2.** Windows 11에는 런타임이 들어 있고, 최신 Windows 10에도 대개 있다. NSIS 설치 파일은 그것을 설치해 주지만 npm 설치는 그럴 수 없으므로, 런처가 먼저 확인하고(Microsoft 배포 가이드의 레지스트리 위치 세 곳) Evergreen Bootstrapper를 가리킨다. `reg.exe`를 실행할 수 없으면 확인 결과는 "모름"이 되고 앱은 그대로 실행된다. 확인 장치가 고장 났다고 실행을 막아서는 안 되기 때문이다.

**실행해 본 것과 아직 증명되지 않은 것.** Windows 11에서(2026-10-08, 임시 npm prefix): `npm i -g centralu`, 바로 가기를 포함한 `centralu install`, 0.1.0-beta.10에서 beta.12로의 `centralu update`, 그리고 같은 구간의 앱 안 업데이트 경로를, 설치된 폴더에 실행 중인 앱의 핸들을 쥔 대역을 두고 각각 돌렸다. 돌리지 않은 것: 실제 앱(WebView2 포함)이 열린 상태의 업데이트(대역은 exe와 호스트의 네이티브 모듈이었다), 그리고 긴 프로필 이름에서의 경로(기본 npm prefix 아래 약 180자로, 평범한 이름이라면 `MAX_PATH` 안).

## linux-arm64 (#29)

위의 일곱 단계는 0.1.0-beta.3 기준으로 모두 끝났다. 그중 셋(1, 2, 6번)은 미리 준비해 두는 데 비용이 들지 않아 일찍 들어갔고, 나머지 넷은 아래 이유로 그 패키지를 배포하는 릴리스를 기다려야 했다. 이 이력은 남겨 둘 가치가 있다: 앞으로 추가될 모든 *다음* 플랫폼도 같은 모양으로 움직여야 하기 때문이다.

**러너가 왜 동작하는지, 그리고 왜 무조건 꽂아 두지는 않는지.** GitHub은 `ubuntu-22.04-arm`을 호스팅한다 — `build.yml`이 x64에 이미 쓰고 있는 `ubuntu-22.04` 핀과 같은 배포판 버전이라, matrix 항목을 그쪽으로 향하게 해도 더 새 배포판의 arm64 이미지를 썼을 때처럼 arm64 사용자의 최소 glibc 요구가 올라가지 않는다. 이 레이블은 2025-08-07 public 리포지토리에 GA로 풀렸고
([GitHub changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)),
무료이며, private 리포지토리 GA는 2026-01-29에 뒤따랐다
([GitHub changelog](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/)) —
거기서도 쓸 수는 있지만 public 리포 사용처럼 무료는 *아니다*: 플랜에 포함된 분(minute)을 소모한 뒤에는 분당 과금된다 (Tauri의 CI 가이드도 독립적으로 같은 두 레이블을 가리킨다: <https://v2.tauri.app/distribute/pipelines/github/>). `ijun17/centralu`는 이 글을 쓰는 시점에 public 리포라 러너가 무료이므로, `build.yml`의 matrix 항목을 켰고(`bb403d1`) 빌드는 green이다(run 32381990293). 오늘의 공개 여부에 조건을 거는 무언가가 아니라 평범한 matrix 항목으로 적어 둔 이유는, `build.yml`이 사람이 매 실행을 승인하는 일 없이 모든 push와 모든 PR에서 돌기 때문이다: **리포가 다시 private으로 돌아가는 일이 생기면 먼저 그 항목을 주석 처리해야 한다** — 그것이 이 문단이 대신해 줄 수 없는 단 한 가지이고, 그러지 않으면 공개 여부 전환이 조용한 청구서로 바뀐다. `release.yml`은 사정이 다르다: 배포는 이미 `npm-publish` 환경 뒤에 게이트되어 있어 사람이 이미 실행을 선택해야 한다.

**왜 기다렸는지, 그리고 왜 0.1.0-beta.3에서 기다림이 끝났는지.**
`packaging/npm/centralu/package.json`의 `optionalDependencies`는 정확한 버전을 핀하고, `scripts/release-npm.mts`의 `assertPinnedPlatformsPublished`는 핀된 플랫폼 중 하나라도 릴리스 버전으로 레지스트리에 없는 동안에는 shim 배포를 거부한다. 따라서 평범한 날에 `centralu-linux-arm64`를 핀했다면, *다음* darwin/x64 릴리스가 아무것도 빌드한 적 없는 패키지 뒤에 끼어 멈췄을 것이다 — 그 가드가 막으려고 존재하는 바로 그 함정이, 사용자의 설치 대신 이 리포를 겨냥하게 되는 셈이다. 핀은 그것이 가리키는 것을 배포하는 바로 그 변경에서만 추가할 수 있고, `release.yml`이 그 하나의 변경을 가능하게 한다: arm64 잡이 패키지를 배포하고, shim 잡은 그것이 끝나기 전에는 시작하지 않는다. 그래서 아래 네 가지 수정이 beta.3에서 커밋 하나로 들어갔고, `tooling/release-workflow.test.ts`는 어떤 부분 상태에서도 실패한다.

1. `packaging/npm/centralu/package.json`의 `optionalDependencies`에
   `"centralu-linux-arm64": "<version>"`(지금은 `@centralu/linux-arm64`) (`os`에는 이미 `linux`가 있었다).
2. `tooling/brand.test.ts`의 `platforms` 배열에 `{ dir: 'linux-arm64', bundle: `${APP_NAME}.AppImage` }` —
   parked-package 테스트를 대체한다.
3. `packaging/npm/centralu/bin/centralu.mjs`의 `TARGETS`에
   `'linux-arm64': { pkg: 'centralu-linux-arm64', artifact: `${APP_NAME}.AppImage` }`.
4. `.github/workflows/release.yml`의 `linux-arm64` matrix 항목.

**아직 증명되지 않은 것.** run 32381990293은 #29의 빌드 관련 두 질문에 증거로 답했다: `node-pty`(어느 아키텍처에도 Linux prebuild가 없어 러너에서 node-gyp이 컴파일한다)와 `better-sqlite3` 모두 arm64에서 빌드되고, AppImage 툴링은 x64와 일관된 크기의 번들을 만들어 낸다. 하지만 green 빌드가 *실행된다*는 것까지 증명하지는 않으며, 어느 Linux 아키텍처에서도 아무도 실행해 본 적이 없다. 이는 beta.2로 배포된 x64 패키지에 이미 참인 것과 같은 사실이고, README도 양쪽 모두에 그렇게 적고 있다.

## 유지관리자의 로컬 업데이트 (#610)

`pnpm local-update`는 보통 유지관리자가 선택한 머신에서 macOS arm64 콘텐츠를 빌드하고 설치한다.
`.github/workflows/local-content-sign.yml`로 보내는 것은 `content-manifest.json`(UTF-8 기준 최대
60,000바이트)뿐이며, 명령은 실행 파일을 업로드하지 않는다. 이것은 의도한 작업 경로이지 머신을
제한하는 장치는 아니다: 서명된 매니페스트와 그에 맞는 파일은 같은 키를 신뢰하고 지금까지 시작한
최고 버전이 더 낮은 다른 `darwin-arm64` 머신에도 복사할 수 있다. 서명은 특정 머신에 묶이지 않는다.
일반 사용자에게 배포하는 업데이트 경로는 여전히 전체 npm 릴리스다.

```bash
pnpm local-update --plan        # 설치된 버전을 읽고 버전 범위를 확인한다
pnpm local-update --dry-run     # 로컬 빌드 + 임시 키 서명; 워크플로 실행이나 설치는 하지 않는다
pnpm local-update               # 빌드, 워크플로 실행, 승인 대기, 검증, 설치
# 다른 위치에서 실행하는 복사본이라면:
pnpm local-update --target /path/to/Centralu.app
```

기본 대상은 `/Applications/Centralu.app`으로, `centralu install`이 교체하는 바로 그 복사본이다.
명령은 시스템 임시 폴더 아래의 일회용 체크아웃에서 빌드하고, UI/호스트, Rust 워크스페이스와
Tauri 번들에 로컬 버전을 넣은 뒤 릴리스의 `tauri build --bundles app` 경로를 돌린다(호스트와
프런트엔드 번들링도 포함한다). 증분 업데이트에는 임시 Cargo 캐시를 다시 쓴다. 커밋하지 않은 변경과
아직 push하지 않은 소스도 허용한다: 서명된 매니페스트에 원래 커밋과 dirty 플래그, 기준 버전,
신고된 설치 버전, 다음 릴리스의 상한과 고유 요청 id를 기록한다. 빌드용 로컬 버전을 넣으면서 생기는
변경은 원래의 dirty 플래그를 바꾸지 않는다. 추적 중인 파일과 ignore되지 않은 미추적 파일을
복사하며, ignore된 빌드 입력은 복사하지 않는다. 스냅샷을 뜨는 동안에는 체크아웃을 바꾸지 않는다.
호스트는 시작하지 않으며, 모든 빌드 자식 프로세스에는 임시 `CC_DATA_DIR`를 준다.

**버전 범위는 빌드 전과 설치 직전에 두 번 확인한다.** `<current>.local.N`은 설치된 복사본보다
높고 다음 릴리스보다 낮아야 한다. 기존 SemVer 규칙에서, 예를 들어
`0.1.0-beta.20 < 0.1.0-beta.20.local.1 < 0.1.0-beta.21`이다. `N`은 양수이고 설치된 로컬
복사본의 번호에서 하나씩 올라간다. `--version`으로 번호를 직접 지정할 수도 있다.
`beta.19.local.128`에서 `beta.20` 체크아웃으로 옮기면 `beta.20.local.1`부터 시작한다.
다음 릴리스는 릴리스 버전의 마지막 숫자 식별자를 하나 올린 값이다(`beta.20` → `beta.21`).
잘못된 버전, 예전 `-local.N` 표기, 설치된 버전과 같거나 더 낮은 후보, 다음 릴리스 이상인 후보는
거부한다. 이 형식에는 prerelease 기준 버전이 필요하다: 안정 버전 `1.2.3` 뒤에 `.local.N`을 붙이면
SemVer가 아니므로, 셸/키퍼의 버전 규칙을 바꾸는 대신 거부한다.

명령은 `main`에서 워크플로를 실행하므로, 워크플로가 먼저 그 브랜치에 병합되어 있어야 한다.
작은 잡 하나가 JSON을 검증하고 그 바이트 그대로 업로드한다. 실행 요약에는 매니페스트 해시,
버전과 신고된 소스 정보가 나온다. 허용하는 것은 format 1, shell 1, `darwin-arm64`뿐이며,
파일 목록은 크기가 제한되고 정렬되어 있어야 한다. 키퍼와 필수 호스트 진입점, 안전한 경로,
파일 크기, SHA-256 해시와 실행 비트도 확인한다. 두 검증 단계 모두 체크아웃한 main 커밋에서
기준 버전을 읽는다: 그 커밋에서 닿는 최신 릴리스 태그다(`readReleaseBase`, #1501; 두 잡 모두 태그를
위해 전체 히스토리를 체크아웃한다). 신고된 기준 버전이 그 값과 같은지 확인한 뒤 그 값에서 다음 릴리스와 상한을 계산한다. 업로드한 정보만으로 `beta.999` 같은 미래의
기준 버전을 고를 수는 없다. 서명 잡은 다운로드한 뒤 다시 검증하고, `release.yml`과 같은
`scripts/content-manifest.mts`의 `signatureBytes`로 서명한다. 의존성을 설치하지 않으며
업로드된 코드를 실행하지도 않는다. 수정하지 않은 워크플로는 실제 서명에서 `GITHUB_REF == main`을
확인하고 기존 `CONTENT_SIGNING_KEY`를 쓰며, `npm-publish` 승인을 기다린다. 워크플로 코드에 있는
이 main 확인은 보조 장치이고, 실제로 막는 것은 환경의 배포 정책이다. 2026-10-13부터 이 환경은
`main` 브랜치와 `v*` 태그만 받는다(저장소 파일이 아니라 GitHub 설정이다). 그래서 다른 브랜치에서
워크플로를 고치면 승인을 받아도 키를 얻지 못한다. 환경을 다시 만들 일이 있으면 이 정책도 함께 둔다.
npm 토큰이나 개인 키가 로컬 명령으로 넘어오지는 않으며, 셸의 신원, 공개 키와 키퍼의 신뢰 규칙도
바꾸지 않는다.

**로컬 콘텐츠 서명 (#610).** main에서 워크플로를 실행하고 `npm-publish`를 승인할 수 있는 사람은
검토되지 않은 임의의 dirty-tree 코드를 릴리스 키로 서명받을 수 있다. 매니페스트의 커밋, dirty
플래그와 설치 버전은 모두 자기 신고다. 서명이 증명하는 것은 목록의 해시이지, 검토된 소스
체크아웃이 아니다. 승인은 소유자의 `gh` 토큰으로 한다. 검토 당시 환경은 필수 검토자가 한 명이고,
자기 승인을 허용하며, 관리자는 보호를 우회할 수 있다: 실행과 승인에 같은 토큰을 쓸 수 있다.
로컬 서명은 특정 머신에 묶이지 않으며, 같은 키를 신뢰하고 지금까지 시작한 최고 버전이 더 낮은
어떤 `darwin-arm64` 머신에서도 그에 맞는 파일과 함께 검증된다. 이 신뢰 경계는
[Signed content](security-boundaries.md#local-content-signing-610)에 설명되어 있다.

명령은 실행 URL을 출력하고 기다리며, 스스로 승인하지는 않는다. 유지관리자나 그 에이전트가
검증 잡의 요약을 읽고 대기 중인 배포를 승인한다:

```bash
gh api repos/ijun17/centralu/actions/runs/RUN_ID/pending_deployments
# 응답에서 npm-publish 환경 id를 가져온다:
gh api --method POST repos/ijun17/centralu/actions/runs/RUN_ID/pending_deployments \
  -F 'environment_ids[]=ENVIRONMENT_ID' -f state=approved \
  -f comment='Approve the reviewed local content manifest'
```

내려받는 것은 `local-content-signature`뿐이다. 명령은 `packaging/shell/keys.json`의 키로
매니페스트의 정확한 바이트와 모든 로컬 파일을 검증하고, `shell.lock`에 핀된 기존 셸을 번들에 넣어
번들을 준비하고 확인한 뒤 `ditto`와 npm 런처의 원자적 교체로 복사한다. 승인 거절, 실행 실패,
서명 불일치, 또는 기다리는 동안 더 높은 버전이 설치된 경우에는 교체 전에 멈춘다. 빌드 산출물은
명령이 출력한 임시 폴더에 남긴다. 중간에 끊기면 `lock` 폴더가 남을 수 있다: 이전 명령이 끝난 것을
확인한 뒤 그 폴더만 지운다. 명령은 앱이나 키퍼를 종료하지 않는다.

교체한 대상에서 실행하는 창은 포커스를 받을 때와 화면에 보이는 동안 5초마다 자기 번들을 확인하고,
npm 설치 이벤트가 없어도 **Apply now**를 보여 준다. 자동 적용은 기존 설정과 유휴/타이핑 확인을
그대로 따른다. 무엇을 실행할지는 여전히 기존 키퍼의 검증과 인계가 결정한다.

**이 변경을 처음 적용할 때.** 이 PR보다 먼저 빌드한 창은 호스트가 npm 설치 상태
(`restart_required`)를 알린 뒤에만 번들을 확인한다. 로컬 설치는 그런 호스트 이벤트를 보내지 않으며,
디스크의 파일을 바꾼다고 그 창에 이미 로드된 UI 코드가 바뀌지는 않는다. 이미 **Apply now**가
보인다면 그 버튼을 쓴다: 별도의 최초 재시작은 필요 없다. 그렇지 않으면 창을 닫고 다시 열어 새로
설치한 창을 한 번 로드한다. 에이전트가 실행 중이면 먼저 Settings → Background →
**Keep agents running after Centralu quits**를 켜고 **Quit completely**가 아닌 **Quit**를 쓴다.
그렇지 않으면 에이전트가 끝날 때까지 기다린다. 다시 연 창은 기존 키퍼에 붙으며, 그 창의
**Switch to this build**로 새 키퍼/호스트를 적용한다. 이것은 새 창 코드를 처음 적용하는 것이지,
추가 **Restart completely**, 셸 재빌드나 권한 초기화가 아니다. 이후 로컬 설치는 그 창이 감지하고
**Apply now**를 보여 준다. 예전 창의 재실행을 요청하는 기존 CLI나 앱 링크 엔드포인트는 없으며,
명령은 그 창을 강제로 종료하거나 npm 설치 이벤트를 꾸며 내지 않는다.

워크플로가 기본 브랜치에 들어간 뒤, 실제 키 없이 워크플로를 리허설하려면:

```bash
# 로컬 dry run이 출력한 매니페스트 경로를 쓴다. 바이트를 그대로 보존한다.
node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.stringify({manifest:readFileSync(process.argv[1],"utf8"),dry_run:"true"}))' \
  /temporary/build/content/content-manifest.json | gh workflow run local-content-sign.yml --ref main --json
```

`dry_run`의 기본값은 true다. 환경과 그 시크릿을 쓰지 않고 메모리에서 만든 임시 키로 서명하며,
같은 프로세스 안에서 서명을 검증한다. 그 아티팩트는 의도적으로 신뢰되지 않으며 `local-update`로
설치할 수 없다. CI 단계는 로컬에서도 리허설할 수 있다:
`node --experimental-strip-types scripts/content-manifest.mts sign-local /temporary/content-manifest.json --dry-run`.
