# 릴리스

> 영어 원본: [releasing.md](releasing.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

Centralu의 한 버전이 사용자에게 도달하는 방법을 다룬다. 배포 채널은 npm뿐이다. 다운로드 페이지도, 업데이트 서버도 없다.

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
- 같은 워크플로가 **windows-x64**(#14)도 빌드해 아티팩트 두 개를 올린다: 포터블 폴더 `centralu-windows-x64`(`Centralu\centralu.exe` 옆에 `Centralu\resources\host\`)와 NSIS 설치 파일 `centralu-windows-x64-setup`(사용자별 설치, 관리자 권한 불필요). 둘 다 서명되어 있지 않다. 별도의 `windows tests` 잡이 `pnpm verify`의 네 부분을 돌리며, 다른 플랫폼처럼 모두 막는다(단위 테스트 단계는 #307의 W2 목록이 고쳐질 때까지 막지 않았다). npm 패키지 `@centralu/win32-x64`는 같은 폴더를 싣고, `release.yml`의 Windows 잡이 따로 다시 빌드한다(아래 [Windows](#windows-14-w3) 참고).
- `.github/workflows/release.yml` — **릴리스 그 자체.** `v*` 태그 push가 모든 패키지를 순서대로, 한 번의 실행에서 배포한다. `workflow_dispatch`는 태그 없이 같은 것을 리허설한다(`dry_run`, 기본 켜짐). 아래에서 설명한다.

브랜치 push나 머지는 여전히 아무것도 배포하지 않는다. **`v*` 태그는 이제 배포한다** — 태그가 존재하는 이유가 그것이다.

## 1회성 설정

1. **Bypass 2FA**가 켜진 npm 토큰을 만든다 (npmjs.com → Access Tokens → Granular). UI에서 예전에 *automation* 토큰이라 부르던 것이 지금은 이 체크박스다. publish 타입 토큰은 여전히 일회용 코드를 요구하는데, 워크플로에는 그것을 입력해 줄 사람이 없다: 첫 릴리스에서 풀 빌드가 끝난 뒤에야 이것이 맨몸의 `EOTP`로 드러났다(#29).
2. Repo → Settings → Environments → **New environment**, 이름은 `npm-publish`. 자신을 required reviewer로 추가한다. 토큰은 그 환경에 시크릿 `NPM_TOKEN`으로 추가한다 — repo 레벨이 아니라 환경 안에 두어야 다른 워크플로가 접근할 수 없다.

## 버전 릴리스하기

1. `packages/protocol/src/brand.ts`의 `APP_VERSION`을 올리고, 같은 버전을 `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/package.json`에도 반영한다. 하나라도 어긋나면 `tooling/brand.test.ts`가 실패한다. 커밋하고 push한다 — 릴리스 스크립트는 더러운 트리에서는 실행을 거부하므로, 배포되는 것과 git에 있는 것이 서로 다를 수 없다.

2. **리허설한다.** Actions → `release` → Run workflow, `dry_run`은 체크된 채로 둔다. 모든 플랫폼을 빌드하고 모든 패키지를 pack하되 아무것도 배포하지 않는다. 승인도 요구하지 않는다: `npm pack`에는 토큰이 필요 없고, 리허설에 게이트를 두면 시도할 때마다 승인이 하나씩 든다 — 첫 릴리스에서 그런 식으로 세 번을 썼다.

   각 패키지의 `npm pack` 출력을 읽는다. shim 잡은 플랫폼 패키지들이 이 버전으로 레지스트리에 없다는 노란 경고로 끝나는데, 그것은 리허설이라는 사실 그대로일 뿐 결함이 아니다.

3. **태그를 단다.** 태그가 곧 릴리스다:

   ```bash
   git tag v0.1.0-beta.3 && git push origin v0.1.0-beta.3
   ```

   `release.yml`은 무언가를 빌드하기 전에 태그를 `APP_VERSION`과 대조한다. 그래서 잘못된 커밋에 단 태그나 버전 범프보다 앞서 나간 태그의 비용은 Rust 릴리스 빌드 네 번이 아니라 몇 초다. 고치려면: `git push --delete origin <tag>`, 수정하고, 다시 태그를 단다.

4. **승인한다.** 배포는 `npm-publish` 환경에서 대기한다. GitHub은 두 번 묻는다: 함께 대기하는 네 플랫폼 잡에 대해 한 번, 모두 성공한 뒤 shim 잡에 대해 다시 한 번. 그 두 번째 승인이 아직 무언가를 되돌릴 수 있는 마지막 순간이다.

5. 한 번도 설치한 적 없는 머신에서 확인한다: `npm i -g centralu@beta && centralu`.

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

### 수동 배포

여전히 지원되며, Actions가 죽었을 때의 대비책이기도 하다. Apple Silicon Mac에서:

```bash
pnpm release:npm                       # rehearsal: build, copy, verify, npm pack
pnpm release:npm --publish             # publishes @centralu/darwin-arm64, then centralu
```

Linux와 Windows는 먼저 CI에서 나와야 한다 (`dry_run`을 끈 `release.yml`). 두 번째 명령은 핀된 플랫폼 패키지 중 하나라도 이 버전으로 레지스트리에 없는 동안에는 shim 배포를 거부하기 때문이다.

릴리스 빌드는 `.app`만 만들고, 일반 `pnpm app` 빌드가 함께 만드는 `.dmg`는 만들지 않는다. 이것은 두 겹으로 의도된 것이다: 릴리스는 배포하는 것만 빌드해야 하고, DMG 단계는 코드와 무관한 이유로 실패할 수 있는 단계다 — Tauri의 `bundle_dmg.sh`는 `osascript`로 Finder를 조작하므로, 뒤에 GUI 세션이 없는 셸(에이전트, ssh 세션)은 Automation 접근이 거부되어 64로 종료한다. 올바르게 빌드되고 서명된 `.app`이 이미 놓여 있는데 그것 때문에 릴리스를 잃는 것은 할 만한 거래가 아니다. CI는 여전히 `.dmg`를 빌드하며, DMG의 진짜 고장은 거기서 드러나야 한다.

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
- 코드 서명과 실행 비트 대신 PE 헤더를 검사한다: `MZ`와 `PE\0\0`(우리가 생각하는 그 파일인지), 서브시스템이 GUI인지(콘솔 서브시스템 exe는 실행할 때마다 콘솔 창을 연다), 머신이 x86-64인지, `main.mjs`와 `conpty.node`가 옆에 있는지.

**Windows에서 런처가 하는 일** (`packaging/npm/centralu/bin/platform.mjs`, 모든 OS에서 `tooling/launcher-platform.test.ts`가 검사한다):

| 명령 | 하는 일 |
|---|---|
| `centralu` | 레지스트리에서 WebView2 Runtime을 확인한다. 없으면 창 없이 끝나 버릴 exe를 실행하는 대신 내려받을 링크를 출력하고 끝낸다. 있으면 `centralu.exe`를 **detached**로 실행한다 — 설치된 복사본이 있으면 그것을, 없으면 npm 패키지 안의 것을. 그리고 3초 동안 지켜본다: 그 안에 0이 아닌 코드로 끝나면 WebView2 링크와 `host.log` 경로를 담은 메시지를 출력한다 |
| `centralu install` | 폴더를 `%LOCALAPPDATA%\Programs\Centralu`로 복사하고 시작 메뉴 바로 가기(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Centralu.lnk`)를 만든다. 새 복사본은 옛 복사본 옆에서 조립된 뒤 바꿔 끼워지므로, 복사가 실패하거나 앱이 실행 중이어도 동작하던 설치는 그대로 남는다 |
| `centralu update` | `npm i -g centralu@<latest>`(`npm`이 `npm.cmd`라서 셸을 거친다), 그리고 설치된 복사본이 있으면 갱신한다 |
| `centralu uninstall` | 복사본과 바로 가기를 지운다. `%USERPROFILE%\.centralu`는 건드리지 않는다 |

Linux처럼 패키지를 가리키는 바로 가기가 아니라 macOS처럼 복사본을 두는 이유: Windows는 실행 중인 프로그램의 파일을 바꿔치기하지 못하게 한다. 앱이 npm 패키지 안에서 실행 중이면 `npm i -g centralu@newer`는 EBUSY로 실패한다. 복사본에서 실행하면 패키지는 자유롭게 업데이트된다. 어느 쪽이든, 앱이 아직 실행 중이라서 Windows가 거부했을 때는 런처가 그렇게 말해 준다.

detached는 선택이 아니다. libuv는 detached가 아닌 모든 자식을, 부모가 끝나면 자식도 죽이는 job object에 넣는다. 그래서 붙어 있는 앱은 런처가 반환되거나 콘솔 창이 닫히는 순간 같이 닫힌다. `windowsHide`는 끈 채로 둔다: 프로세스를 SW_HIDE로 시작시키는데, GUI 프로그램은 그것을 첫 창에 적용해 버린다.

**서명 없음: SmartScreen.** Windows 코드 서명은 없다. SmartScreen은 브라우저가 다운로드에 붙이는 mark-of-the-web을 기준으로 삼는데 npm은 그것을 붙이지 않으므로, npm 설치는 경고 없이 실행될 것으로 예상한다. macOS quarantine과 같은 논리지만 Windows에서는 측정하지 않았다. zip으로 내려받은 CI 아티팩트에는 그 표시가 붙는다. SmartScreen이 "Windows의 PC 보호" 창을 띄우면 **추가 정보 → 실행**을 누른다. Smart App Control(깨끗하게 새로 설치한 Windows 11에서만 기본으로 켜진다)은 그런 버튼 없이 서명 없는 exe를 아예 막을 수 있는데, 이 exe를 막는지는 모른다.

**WebView2.** Windows 11에는 런타임이 들어 있고, 최신 Windows 10에도 대개 있다. NSIS 설치 파일은 그것을 설치해 주지만 npm 설치는 그럴 수 없으므로, 런처가 먼저 확인하고(Microsoft 배포 가이드의 레지스트리 위치 세 곳) Evergreen Bootstrapper를 가리킨다. `reg.exe`를 실행할 수 없으면 확인 결과는 "모름"이 되고 앱은 그대로 실행된다. 확인 장치가 고장 났다고 실행을 막아서는 안 되기 때문이다.

**아직 증명되지 않은 것.** Windows에서 `npm i -g centralu`를 실행해 본 사람은 없다: 런처도, 바로 가기도, 앱이 열린 상태의 업데이트도. 릴리스 잡은 dry run으로만 돌았다. 기본 npm prefix 아래 경로 깊이는 약 180자로, 평범한 프로필 이름이라면 `MAX_PATH` 안이지만 긴 이름으로는 확인하지 않았다.

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
