# 문서 지도

> 영어 원본: [README.md](README.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

**무엇을** 만들지는 `product-spec.md`가 정하고, 이 폴더의 나머지 문서는 **어떻게** 만들지를 정한다. 요구사항에 대해 둘이 어긋나면 스펙이 이기고, 만드는 방식에 대해 어긋나면 설계 문서가 이긴다.

설계 문서는 영어 원본(정본)과 한국어 번역(*.ko.md)을 함께 관리한다 — [#27](https://github.com/ijun17/centralu/issues/27) 참고. plans/와 spikes/는 과거 기록이라 번역하지 않는다.

현재 상태: **M2 완료, 도그푸딩 중** — [M2가 실제로 만들어 낸 것](plans/m2-result.md), [릴리스에 아직 필요한 것](plans/beta-release-checklist.md).

## 설계

| 문서 | 담긴 내용 | 먼저 읽을 것 |
|---|---|---|
| [product-spec.ko.md](product-spec.ko.md) | 스펙: 요구사항(FR-1–21), 화면, 로드맵, 리스크 | — |
| [architecture.ko.md](architecture.ko.md) | 변화 축, 레이어, 의존성 규칙, 디자인 패턴, 프로세스 토폴로지 | product-spec §6 |
| [folder-structure.ko.md](folder-structure.ko.md) | 모노레포를 나누는 방법, 그리고 어떤 변경의 코드가 갈 곳 | architecture |
| [tech-stack.ko.md](tech-stack.ko.md) | 라이브러리 선택과 그 이유, 그리고 손대지 말 것들의 목록 | architecture |
| [platform-abstraction.ko.md](platform-abstraction.ko.md) | Platform 포트 — 웹으로 개발한 것이 Tauri 앱이 되는 방법. 구현 매트릭스와 이를 강제하는 lint 규칙 | architecture |
| [protocol.ko.md](protocol.ko.md) | UI ↔ agent host 메시지: 스키마와 버전 규칙 | architecture |
| [agent-host.ko.md](agent-host.ko.md) | Node 사이드카의 내부: AgentAdapter, 그리고 새 툴을 추가하는 방법 | protocol |
| [state-management.ko.md](state-management.ko.md) | 프런트엔드 상태: 이벤트 → store → selector, 영속화와 복원 | architecture, protocol |
| [releasing.ko.md](releasing.ko.md) | 버전이 사용자에게 도달하는 방법: npm 패키지 구성, CI, 배포 절차 | — |

## 측정한 것의 기록

이것들은 따라야 할 계획이 아니라 실제로 일어난 일의 기록이다. 그 안의 논리가 이후 결정의 근거이기 때문에 남겨 둔다.

| 문서 | 담긴 내용 |
|---|---|
| [spikes/m0-findings.md](spikes/m0-findings.md) | M0: 권한 오버라이드, 이벤트, Codex, 토폴로지 — 넷 다 성립했다 |
| [plans/m1-plan.md](plans/m1-plan.md) · [m1-result.md](plans/m1-result.md) | M1 계획과 결과: 게이트, 측정된 성능, 구현 중에 내린 결정 |
| [plans/m1.5-plan.md](plans/m1.5-plan.md) · [m1.5-result.md](plans/m1.5-result.md) | 상시 구동 운영과 검증 프로토콜; 측정이 잡아낸 결함 5건 |
| [plans/m2-plan.md](plans/m2-plan.md) · [m2-result.md](plans/m2-result.md) | M2 계획(독립 리뷰 후 수정)과 결과: 릴리스 빌드 통과, 추가로 측정된 결함 5건, 도그푸딩 시작 방법 |
| [plans/beta-release-checklist.md](plans/beta-release-checklist.md) | 공개 릴리스를 막고 있는 것들. §2는 npm을 배포 채널로 만든 서명·격리 측정 |

## 문서를 쓰는 규칙

- 설계를 바꾸면 문서도 **코드와 같은 PR에서** 고친다. 문서와 코드가 어긋나면 틀린 쪽은 문서다.
- 모든 "결정" 표는 그 이유를 함께 담는다. 이유가 없는 결정은 다시 검토해야 할 결정이다.
- 주석과 문서는 무엇(what)이 아니라 **왜(why)**를 기록한다 — 특히 측정으로 배운 것은 측정한 숫자와 함께 남긴다.
