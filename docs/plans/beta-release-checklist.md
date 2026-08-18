# 베타 배포 점검표

> 2026-08-18 작성. 배포를 **하기로** 정하기 전에 무엇이 막고 있는지 먼저 적는다.
> 아래 '지금 상태'는 추정이 아니라 저장소·산출물에서 직접 확인한 값이다.

## 지금 상태 (확인함)

| 항목 | 값 | 확인 방법 |
|---|---|---|
| 서명 | 애드혹(유효) + hardened runtime, 공증 없음 | `codesign -dvv <app>` |
| 아키텍처 | arm64 전용 (Mach-O arm64) | `file <app>/Contents/MacOS/control-center` |
| 네이티브 애드온 | `better_sqlite3.node`·`pty.node` 둘 다 arm64 | `file …/node_modules/**/*.node` |
| 런타임 | `system-node` — **사용자 맥에 Node가 있어야 한다** | `resources/host/bundle-info.json` |
| Node 하한 | esbuild target `node22` | `scripts/bundle.mjs` |
| 원격 저장소 | 없음 | `git remote -v` (빈 출력) |
| LICENSE | 없음 | `ls LICENSE*` |
| 자동 업데이트 | 미설정 | `tauri.conf.json`의 `plugins.updater` 없음 |
| 버전 | `0.1.0` / `0.1.0` / `0.0.0` (세 곳이 불일치) | tauri.conf.json · Cargo.toml · apps/desktop/package.json |

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

- 비공개 베타(아는 사람 몇 명, 전원 개발자) → **애드혹으로 충분**. $99 미룬다
- 공개 배포 / brew 탭 / 모르는 사람이 받는 순간 → 공증한다.
  그 지점부터는 '수상한 앱'으로 보이는 비용이 $99보다 크다

- [ ] (공개 배포 시) Apple Developer Program 가입 (연 $99)
- [ ] Developer ID Application 인증서 발급
- [ ] Tauri 빌드에 서명 환경변수 연결
      (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- [ ] `notarytool`로 공증 + `stapler`로 티켓 부착
- [ ] **다른 맥에서** 내려받아 실행 검증 — 만든 맥에서는 격리가 안 붙어 통과한다

### 1-2. 저장소·라이선스

- [ ] 원격 저장소 생성 (지금 `git remote`가 비어 있어 릴리스 URL 자체가 없다)
- [ ] LICENSE 추가 — 없으면 법적으로 "모든 권리 유보"라 남이 못 쓴다
- [ ] 대화 기록이 **로컬에만** 저장된다는 사실 명시 (`~/.control-center/store.db`)

## 2. 채널 — npm 아님, brew는 본인 탭

**npm은 맞지 않는다.** JS 패키지·CLI를 위한 곳이다. GUI `.app`을 postinstall로 내려받아
`node_modules`에 두는 모양이 되고, 앱 수명주기도 업데이트도 없다.

**homebrew-cask 본진도 아직 아니다.** notability 기준(사용자·스타 수)과 안정된 버전별
다운로드 URL을 요구한다. 신규 0.1.0 개인 프로젝트는 받아주지 않는다.

권하는 모양:

```
GitHub Releases (.dmg)        ← 원본. 여기서 시작한다
   └── ijun17/homebrew-tap    ← 나중에 얹는 편의 래퍼
```

- [ ] GitHub Releases로 `.dmg` 배포 (원본) — **호스팅 비용 없음**
- [ ] README에 첫 실행 안내: 시스템 설정 → 개인정보 보호 및 보안 → '확인 없이 열기',
      또는 `xattr -dr com.apple.quarantine "/Applications/Control Center.app"`
- [ ] 안정되면 본인 탭 추가 → `brew tap ijun17/tap && brew install --cask control-center`
- [ ] 탭은 **서명이 끝난 뒤에** — 서명 없는 앱을 brew로 깔면 실패 경험만 넓힌다

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

- [ ] 버전 세 곳 일치 (`tauri.conf.json`, `Cargo.toml`, `apps/desktop/package.json`)
- [ ] 베타면 `0.1.0-beta.1` — 기대치를 버전이 먼저 말하게 한다
- [ ] README에 스크린샷·전제조건·설치법·알려진 한계
- [ ] 자동 업데이트 검토. 베타는 수정을 자주 밀어야 하는데 지금은 **재설치가 유일한 경로**다
      (updater도 서명 키가 필요하므로 1-1과 함께 처리)
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
