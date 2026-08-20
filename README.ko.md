# Centralu

돌고 있는 Claude Code · Codex CLI 세션 전부를 한 창에서.

<!--
  여기에 스크린샷이 들어가야 한다. (영문 README와 같은 이미지)

  보여줘야 하는 것은 대화가 아니라 분류다. 서로 다른 상태의 세션이 동시에 있는
  사이드바 — 하나는 승인 대기, 하나는 응답 대기, 하나는 작업 중 — 인박스 카운터,
  그리고 포커스 뷰에 열린 세션 하나에 승인 카드가 떠 있는 화면.

  유휴 세션 하나짜리 화면은 아무것도 증명하지 못한다. 다른 챗 UI와 구분이 안 된다.
-->

베타입니다. [어디서 도는지](#어디서-도나)를 먼저 보세요.

대화는 당신 기계에만 남습니다. `~/.centralu/store.db`에 쓰이고, 어디로도 가지
않습니다. 계정도 없고 로그인할 서버도 없습니다.

[English README](README.md)

## 뭐가 좋아지나

에이전트 셋이 돌고 있다고 해봅시다. 하나는 명령 승인을 기다리며 멈춰 있고, 하나는
아까 끝나서 놀고 있고, 하나는 아직 일하는 중입니다. 터미널 탭으로는 셋을 다
눌러봐야 그걸 압니다.

Centralu는 셋을 한 화면에 놓고, 지금 당신이 필요한 쪽을 가리킵니다.

- 창을 옮기지 않고 승인하고, 질문에 답하고, 다음 지시를 보냅니다
- 무언가 기다리기 시작하면 소리와 독 배지로 알려줍니다. 앱이 에디터 뒤에 묻혀 있어도요
- "승인에 막힘"과 "끝나고 기다림"을 다르게 보여줍니다 — 앞엣것은 시간이 새고 있고, 뒤엣것은 오후 내내 둬도 됩니다
- 지금까지의 모든 대화를 검색할 수 있습니다. 재시작 전 것도요
- 다른 세션들을 읽고 일을 나눠주는 오케스트레이터 세션을 둘 수 있습니다

코드는 쓰지 않습니다. 그리고 무엇도 대신 승인하지 않습니다 — 승인이 필요한 순간이
바로 사람이 봐야 하는 순간이라서요.

## 필요한 것

Centralu는 에이전트를 직접 돌리지 않고, 이미 쓰고 계신 CLI를 부립니다. 아래가
없으면 앱은 뜨는데 세션을 열 수가 없습니다.

| | |
|---|---|
| **Node 22 이상** | 호스트 사이드카가 이 위에서 돕니다. 없거나 낡았으면 켤 때 무엇이 필요한지 앱이 말해줍니다 |
| **`claude` CLI** + 로그인 | Claude Code 세션용 — `npm i -g @anthropic-ai/claude-code` |
| **`codex` CLI** + 로그인 | Codex 세션용 — `npm i -g @openai/codex`. 안 쓰면 없어도 됩니다 |

둘 중 하나만 있어도 시작할 수 있습니다. 첫 화면이 무엇을 찾았는지 보여주고, 없는
쪽은 설치 명령까지 적어줍니다.

## 설치

```bash
npm i -g centralu   # 베타 — centralu@beta 로 베타 줄에 고정할 수도 있습니다
centralu            # 실행
centralu install    # /Applications에 넣기 — Spotlight와 Launchpad에 뜨게
centralu update     # 새 버전이 나왔을 때
```

`install`이 따로 있는 건 일부러입니다. 설치 스크립트가 묻지도 않고 남의
`/Applications`에 뭘 써넣는 일은 이 프로젝트가 하지 않습니다. `centralu uninstall`은
그걸 되돌리고, 대화 기록은 건드리지 않습니다.

> **왜 다운로드가 아니라 npm인가.** macOS는 앱을 열어보고 위험한지 판단하지
> 않습니다. `com.apple.quarantine` 딱지가 붙었는지만 봅니다. 그 딱지는 파일을
> 받아온 쪽이 붙입니다. 브라우저는 붙이고, npm은 안 붙입니다. 그래서 같은 빌드가
> 다운로드하면 "확인할 수 없습니다" 경고로 맞이하고, npm으로 깔면 그냥 열립니다.
> 짐작이 아니라 재본 겁니다 — 방법과 숫자는
> [베타 릴리스 점검표 §2](docs/plans/beta-release-checklist.md)에 있습니다.

## 어디서 도나

| | |
|---|---|
| **macOS, Apple Silicon** | npm에 올라가 있고, 우리가 매일 쓰는 환경입니다 |
| **Linux, x86-64** | 0.1.0-beta.2부터 npm에 있습니다. 실행 보고는 아직 없습니다 — 첫 번째가 되어주세요 |
| **Windows · Linux arm64 · Intel Mac** | 아예 빌드가 안 됩니다 ([#14](https://github.com/ijun17/centralu/issues/14), [#29](https://github.com/ijun17/centralu/issues/29)) |

리눅스 줄엔 설명이 좀 필요합니다. 여기엔 리눅스 기계가 없어서, npm에 올라간 패키지도
CI에서 빌드·검사만 거쳤지 사람이 띄워본 적은 없습니다. 컴파일된다와 돌아간다는 다른
주장이고, 증명된 건 아직 앞엣것뿐입니다.

리눅스를 쓰신다면 `npm i -g centralu`로 AppImage가 설치됩니다 —
[#14](https://github.com/ijun17/centralu/issues/14)에 어땠는지 남겨주세요. 아무 일도
안 일어났더라도요.

## 라이선스

[MIT](LICENSE). 이슈와 PR 모두 환영합니다. 다만 CLA가 있으니
[CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어주세요.

## 문서

[docs/product-spec.md](docs/product-spec.md)가 나머지 전부가 따르는 기준이고,
[docs/README.md](docs/README.md)가 그 지도입니다. `docs/` 일부는 아직 한국어입니다
— 번역은 [#27](https://github.com/ijun17/centralu/issues/27)에서 진행 중입니다.
