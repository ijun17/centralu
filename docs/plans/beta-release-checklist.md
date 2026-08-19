# 베타 배포 점검표

> 2026-08-18 작성. 배포를 **하기로** 정하기 전에 무엇이 막고 있는지 먼저 적는다.
> 아래 '지금 상태'는 추정이 아니라 저장소·산출물에서 직접 확인한 값이다.

## 지금 상태 (확인함)

| 항목 | 값 | 확인 방법 |
|---|---|---|
| 서명 | 애드혹(유효) + hardened runtime, 공증 없음 | `codesign -dvv <app>` |
| 아키텍처 | arm64 전용 (Mach-O arm64) | `file <app>/Contents/MacOS/centralu` |
| 네이티브 애드온 | `better_sqlite3.node`·`pty.node` 둘 다 arm64 | `file …/node_modules/**/*.node` |
| 런타임 | `system-node` — **사용자 맥에 Node가 있어야 한다** | `resources/host/bundle-info.json` |
| Node 하한 | esbuild target `node22` | `scripts/bundle.mjs` |
| 원격 저장소 | 없음 | `git remote -v` (빈 출력) |
| LICENSE | 없음 | `ls LICENSE*` |
| 자동 업데이트 | 미설정 | `tauri.conf.json`의 `plugins.updater` 없음 |
| 버전 | `0.1.0` / `0.1.0` / `0.0.0` (세 곳이 불일치) | tauri.conf.json · Cargo.toml · apps/desktop/package.json |
| 배포 채널 | **npm** (§2에서 실측으로 결정) — 격리 딱지가 안 붙어 경고가 없다 | `npm pack` 왕복 + `open`으로 기동 확인 |

## 1. 배포를 막는 것 (이게 안 되면 나머지는 의미 없다)

### 1-1. 서명·공증

**공증(notarization)에는 유료 인증서가 필요하다.** 무료 우회로는 없다:

| 방법 | 비용 | 배포 |
|---|---|---|
| 무료 Apple ID → Apple Development 인증서 | 무료 | ❌ 개발·내 기기용, 공증 불가 |
| 자체 서명 | 무료 | ❌ Gatekeeper는 Apple 발급 Developer ID만 신뢰 |
| Apple Developer Program → Developer ID Application | 연 $99 | ✅ 공증 가능 |

#### 무료로 이미 해결한 것 (`4f405fe`)

`signingIdentity`가 없으면 Tauri는 codesign을 **건너뛴다.** 그래서 링커가 붙인 반쪽
서명만 남아 검증이 실패했고, 다른 맥에서 이렇게 떴다:

> "손상되었기 때문에 열 수 없습니다. 휴지통으로 이동해야 합니다."

`signingIdentity: "-"` 한 줄로 문구가 바뀐다 (실측):

> "Apple은 … 악성 코드가 없음을 확인할 수 없습니다."

앞은 **막다른 길**(검증 실패)이고 뒤는 macOS의 **표준 미공증 경로**다.
hardened runtime도 함께 켜지므로 나중에 공증할 때의 전제조건이 미리 갖춰진다.

#### 유료로 가야 하는 시점

- 비공개 베타(아는 사람 몇 명, 전원 개발자) → **애드혹으로 충분**. $99 미룬다.
  게다가 §2에서 정한 npm 경로로 주면 **경고 자체가 뜨지 않는다**(실측) — 애드혹의 한계가
  사용자 눈에 닿지 않는다
- 공개 배포 / brew 탭 / 브라우저 다운로드 / 모르는 사람이 받는 순간 → 공증한다.
  그 지점부터는 '수상한 앱'으로 보이는 비용이 $99보다 크다.
  공증이 사는 것은 정확히 **"어떤 경로로 받아도 경고가 없다"**이다

- [ ] (공개 배포 시) Apple Developer Program 가입 (연 $99)
- [ ] Developer ID Application 인증서 발급
- [ ] Tauri 빌드에 서명 환경변수 연결
      (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- [ ] `notarytool`로 공증 + `stapler`로 티켓 부착
- [ ] **다른 맥에서** 내려받아 실행 검증 — 만든 맥에서는 격리가 안 붙어 통과한다

### 1-2. 저장소·라이선스

- [ ] 원격 저장소 생성 (지금 `git remote`가 비어 있어 릴리스 URL 자체가 없다).
      개인 계정 아래로 간다 — GitHub 약관상 사람용 무료 계정은 하나뿐이고,
      브랜드가 필요해지면 그때 Organization으로 **이전**하면 별·이슈·URL이 따라간다
- [x] LICENSE 추가 — MIT. 기여자 CLA는 `CONTRIBUTING.md`에 (나중에 회사용 유료
      라이선스로 갈 길을 열어두려면 기여가 쌓이기 전인 지금이 유일한 시점이다)
- [x] 대화 기록이 **로컬에만** 저장된다는 사실 명시 (`~/.control-center/store.db`) — README 머리말

## 2. 채널 — npm으로 준다 (실측으로 뒤집힌 결정)

> 처음엔 "npm은 GUI 앱에 맞지 않는다"고 적었다. **격리 딱지를 계산에 넣기 전의 판단**이었고,
> 재보니 틀렸다. 아래는 전부 2026-08-19에 이 맥에서 직접 잰 값이다.

### 2-1. 경고를 띄우는 것은 앱이 아니라 딱지다

macOS는 앱을 열어보고 "위험하다"고 판단하지 않는다. 파일에 **`com.apple.quarantine`가
붙어 있을 때만** 개발자 신원을 따진다. 그리고 그 딱지는 **파일을 받아온 프로그램이** 붙인다.

| 받는 경로 | 격리 딱지 | 첫 실행에 뜨는 것 |
|---|---|---|
| `npm i -g` · `curl` · `git clone` | **없음** | **아무것도 안 뜬다** |
| 브라우저 다운로드 (.dmg/.zip) | 붙음 | "악성 코드가 없음을 확인할 수 없습니다" |
| 에어드롭 · 메신저 · 메일 첨부 | 붙음 | 위와 같음 |
| `brew install --cask` | 붙음(**기본값**) | 위와 같음. `--no-quarantine`을 사용자가 쳐야 한다 |

실측:

```
curl -fsSL -o probe.txt …        → quarantine 속성 0개
~/Downloads/<브라우저로 받은 파일> → 0281;6a847c46;Aside;DBB9C93A-…
```

### 2-2. `.app`을 npm으로 줄 수 있는가 — 된다

`.app`을 패키지에 넣고 `npm pack` → 풀기 → 실행까지 통째로 돌렸다:

| 확인한 것 | 결과 |
|---|---|
| 크기 | 11MB → **tarball 4.2MB** |
| 번들 안 심링크 | **0개** (tar 왕복에서 깨질 것이 없다) |
| 풀어낸 뒤 `codesign --verify --deep --strict` | `valid on disk` · `satisfies its Designated Requirement` |
| 실행 비트 | `-rwxr-xr-x` 유지 |
| 격리 딱지 | 없음 |
| **LaunchServices로 실행** (`open` = 더블클릭과 같은 경로) | 경고 없이 기동 (`[agent-host] started`) |

마지막 줄이 핵심이다. **터미널에서 실행 파일을 직접 부르면 Gatekeeper는 원래 개입하지 않으므로
그것으로는 아무것도 증명되지 않는다.** `open`으로 띄워야 더블클릭 경로를 잰 것이다.

`spctl -a -t exec`는 이 앱을 여전히 `rejected`로 판정한다. 그런데도 뜬다 —
**그 판정은 격리 딱지가 있을 때만 조회되기 때문이다.** 이 문서의 나머지가 여기서 갈린다.

### 2-3. 왜 하필 이 프로젝트에 맞는가

npm이 GUI 앱 일반에 맞는 통로라는 말이 아니다. 이 앱에 한해 조건이 맞는다:

- **이미 Node 22가 전제다**(`system-node` 런타임). 대상 사용자는 전원 npm을 가지고 있다 — 추가 전제가 0이다
- 대상이 `claude`·`codex`를 npm으로 깐 사람들이다. 가장 익숙한 통로다
- 업데이트 경로가 생긴다: `npm i -g …@latest`. 지금은 재설치가 유일한 경로다
- `curl … | sh`보다 낫다 — "이 스크립트를 믿어라"를 요구하지 않고, 버전 고정·삭제가 표준 도구로 된다

### 2-4. 대가와, 반드시 지켜야 할 조건

- **Launchpad·Spotlight에 안 뜬다** (`node_modules` 안에 살기 때문). 매번 명령으로 켜야 한다
  → `centralu install` 서브커맨드로 `/Applications`에 복사한다. **postinstall로 몰래 하지 않는다**
  (pnpm은 기본 차단이고, 남의 `/Applications`에 조용히 쓰는 것은 신뢰를 깎는다)
- arm64 전용 바이너리가 인텔 맥에 깔리면 안 된다 → `os`/`cpu` 필드 + 아키텍처별 optional dependency
  (esbuild·swc가 쓰는 그 구조)
- **배포 경로를 하나로 유지해야 한다.** 사용자가 `.app`을 압축해 메신저·에어드롭으로 넘기는 순간
  거기서 딱지가 붙고, 받은 쪽은 경고를 본다. 안내를 `npm i -g …` 한 줄로 통일한다
- **npm은 경고를 피하는 것이지 신뢰를 얻는 것이 아니다.** 모르는 사람에게 퍼지기 시작하면
  §1-1의 $99는 그대로 남는 문제다

### 2-5. 할 일

- [x] 패키지 이름 — **`centralu`** (2026-08-19 실측: npm 404로 비어 있다).
      옛 이름은 npm에 이미 임자가 있었고(HTTP 200), macOS 자체 기능 이름과도 겹쳤다.
      GitHub 계정명 `centralu`는 이미 임자가 있으나 저장소는 개인 계정 아래로 가므로 무관하다
- [ ] 아키텍처별 optional dependency 구조 (`@…/darwin-arm64`)
- [ ] `bin` 실행 스크립트 — 번들 안 `.app`을 `open`으로 띄운다
- [ ] `install` 서브커맨드 (`/Applications`에 복사, 되돌리는 `uninstall`도)
- [ ] 릴리스 스크립트 (`tauri build` → 번들 검증 → `npm publish`)
- [ ] GitHub Releases `.dmg`는 **보조 경로**로만 둔다. 거기서 받으면 경고를 본다는 것을 함께 적는다
- [ ] brew 탭은 서명 이후로 미룬다 — cask는 격리를 기본으로 붙이므로 지금 얹으면 실패 경험만 넓힌다

## 3. 사용자 전제조건 (설치 문서에 반드시)

이 앱은 혼자 못 돈다. 없으면 **아무 설명 없이 안 되는** 것들이다:

- [ ] Node 22 이상 (`system-node` 런타임 — 없으면 host가 아예 못 뜬다)
- [ ] `claude` CLI 설치 + 로그인
- [ ] `codex` CLI 설치 + 로그인 (codex 세션을 쓸 경우)
- [x] Node가 없을 때 **앱이 뭐라고 말하는지** — 무엇이 없는지·어디를 찾아봤는지·무엇을
      하면 되는지를 기동 화면에 적는다. 낡은 버전은 "없음"이 아니라 "올려야 함"으로 갈린다
- [x] claude·codex가 없을 때의 문구 — 첫 실행 화면에 무엇이 없는지와 설치 명령
      (`npm i -g @anthropic-ai/claude-code` / `@openai/codex`)이 함께 뜨고, "Check again"으로
      다시 본다. 도구가 하나도 없어도 **프로젝트 등록은 열어 둔다**
      (없는 CLI를 이유로 첫 화면을 막지 않는다)

> Node 의존은 배포에서 가장 큰 마찰이다. 장기적으로는 Node를 동봉하는 편이 낫다(SEA 등).
> 찾기 자체는 고쳤다 — 예전에는 homebrew 두 곳과 `/usr/bin`만 봐서 **nvm·mise·volta로
> 깐 Node는 있어도 못 찾았다.** 이제 로그인 셸에게 직접 묻는다(claude·codex 탐색과 같은 방식).

## 4. 아키텍처 결정

arm64 전용이다. 그리고 **Rust 타깃만의 문제가 아니다** — 번들에 들어간
`better_sqlite3.node`·`pty.node`가 arm64 프리빌드다. universal로 가려면 두 애드온의
x64 프리빌드도 함께 넣고 `lipo`로 합쳐야 한다.

- [ ] arm64 전용으로 갈지 결정하고, 그렇다면 **릴리스 노트에 명시** ("Apple Silicon 전용")
- [ ] universal이 필요하면 네이티브 애드온까지 포함한 작업으로 따로 잡는다

## 5. 배포 전 정리

- [x] 버전 세 곳 일치 (`tauri.conf.json`, `Cargo.toml`, `apps/desktop/package.json`) — 0.1.0.
      어긋나면 `tooling/brand.test.ts`가 잡는다
- [ ] 베타면 `0.1.0-beta.1` — 기대치를 버전이 먼저 말하게 한다
- [x] README에 전제조건·설치법·알려진 한계 / [ ] 스크린샷은 아직
- [ ] 자동 업데이트 — **Tauri updater는 쓰지 않는다.** npm과 싸운다(앱이 node_modules 안에서
      자기를 갈아치우면 npm이 아는 버전과 어긋난다) 대신 **레지스트리를 업데이트 채널로 쓴다**:
      `registry.npmjs.org/centralu/latest`에 GET → 새 버전이면 인앱 배너 → `npm i -g centralu@latest`.
      서명 키도 업데이트 서버도 필요 없으므로 §1-1과 묶을 이유가 없다
- [ ] 버그 신고 창구 + **`~/.control-center/host.log`를 첨부해달라고 안내**
      (기동 배너에 빌드 커밋이 박혀 있어 어느 빌드인지 바로 갈린다)

## 6. 도그푸딩 종료 조건

2026-08-18에 **모든 세션이 안 도는** 상태였고 원인 셋을 그날 고쳤다
(`e7ac9d2` 재시작 후 working 갇힘, `f924257` 다른 곳에서 열린 대화, `15bff4f` 사라지던 로그).
셋 다 자동 테스트가 아니라 **실제로 쓰다가** 나왔다. 그러니 시간이 아니라 사건으로 끊는다:

- [ ] 며칠 연속 사용하며 세션이 갇히거나 error로 떨어지는 일이 없다
- [ ] 앱을 여러 번 재시작해도 세션이 정상 복귀한다
- [ ] codex 세션을 VS Code와 동시에 열어도 갈림길이 제대로 뜬다
- [ ] `host.log`에 예상 못 한 것이 쌓이지 않는다
- [ ] 그 기간에 새로 나온 결함이 있으면 **고치고 카운터를 다시 시작**한다

## 7. 릴리스 당일

- [ ] `pnpm verify` + `pnpm e2e` 통과
- [ ] 클린 클론에서 빌드 (내 머신 상태에 기대고 있지 않은지)
- [ ] 빌드가 `-dirty` 없이 커밋 해시로 찍히는지 (`host.log` 기동 배너)
- [ ] 서명·공증된 `.dmg`를 **다른 맥**에서 내려받아 설치·실행
- [ ] `/Applications`에 설치해 실행 — `~/Desktop` 아래 두면 재빌드마다 macOS가
      보호 폴더 접근을 다시 묻고, 답하기 전까지 host가 `open()`에서 멈춘다 (실측)
