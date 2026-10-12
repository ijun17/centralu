# 사용성 — 화면을 판단하는 법

> 영어 원본: [usability.md](usability.md) — 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

Centralu의 화면이 충분히 좋은지 무엇으로 판단하는지, 이미 내린 결정, 그리고 화면을 바꾸는 PR이
보여 줘야 할 것. 측정 도구 자체는 [ux-metrics.md](ux-metrics.md)(영어만)에 있고, 이 문서는 그 도구를
쓰는 판단이다.

## 목표

**한 작업에 드는 조작과 결정을 가장 적게, 개발자가 아닌 사람도 첫날부터 쓸 수 있게.** 이 앱을 쓰는
사람은 여러 에이전트를 한꺼번에 돌리고, 모두가 프로그래머는 아니다. 작업은 눈으로 보고 찾을 수 있어야
하고, 찾은 다음에는 싸야 한다. 키를 이미 아는 사람의 속도는 그다음이고, 그것을 대신하지 않는다.

## 원칙과 결정

| 원칙 | 결정과 이유 |
|---|---|
| **보이는 경로로 판단한다** | 작업은 모든 단계가 화면에 보이는 경로로 판단한다: 버튼, 메뉴, 행, 옆에 찍힌 안내. 단축키(⌘K, 조합 키, 한 글자 키)는 들은 사람만 알기 때문에 숙련자용 덤이다. 따로 보고하고, 작업이 싸다는 근거로 쓰지 않는다. 보이는 경로가 없는 작업은 통과가 아니라 발견이다 (주인, 2026-10-12, [#518](https://github.com/ijun17/centralu/issues/518); #529에서 구현) |
| **다음 키를 받을 필드가 키보드를 갖는다** | 세션을 만든 뒤, 세션을 바꾼 뒤, 다음 단계가 입력인 양식을 연 뒤에는 커서가 이미 그 필드에 있다. 포커스가 빠지면 매번 손 이동과 클릭 한 번(약 1.4초)이 들고, `fill()`을 쓰는 테스트에는 보이지 않는다 ([#528](https://github.com/ijun17/centralu/issues/528), CONTRIBUTING "Where the keyboard goes") |
| **IME 조합 중에는 키가 잘못 발동하지 않는다** | 한국어·일본어·중국어 음절을 끝내는 Enter와 조합을 취소하는 Esc는 입력기의 것이다. 글자를 칠 수 있는 곳에서 Enter, Esc, 화살표, Tab에 반응하는 처리기는 모두 `composingKey`(`packages/ui/src/app/keys.ts`)를 거친다. 이것은 WKWebView의 `keyCode` 229도 잡는다 ([#496](https://github.com/ijun17/centralu/pull/496)) |
| **진입점은 사람이 이미 있는 곳에** | 포인터와 그것이 다룰 내용 가까이에 있는 컨트롤은 닿기 싸고(Fitts의 법칙) 찾기 쉽다. 먼 메뉴보다 바꿀 행이나 패널 위의 동작을, 마우스를 올려야만 나타나는 컨트롤보다 보이는 컨트롤을 고른다 (#529: 열린 프로젝트의 `+`) |
| **단계마다 선택지를 적게** | 선택마다 결정이 들고, 목록이 길수록 더 든다(Hick–Hyman 법칙). 기본값을 묻는 대화상자보다 대화상자가 필요 없는 알맞은 기본값이, 항목이 많은 메뉴보다 적은 메뉴가 낫다 |

## 절차

화면에 무언가를 더하거나 바꾸는 PR은:

1. **작업 시나리오를 더하거나 고친다**(`e2e/ux/*.task.ts`): 보이는 경로, 그리고 있으면 그 옆에
   단축키 경로. 사람이 자주 하는 작업은 시나리오를 갖는다.
2. **보이는 경로의 전후 숫자를 붙인다.** `pnpm ux:report --compare <before> <after>`의 결과를 PR의
   **Usability** 칸에 넣고, 화면이 바뀌지 않았으면 `n/a`라고 쓴다.
3. **올리는 예산마다 이유를 댄다**(PR 설명에). 작업이 싸지면 예산을 내려 얻은 것을 지킨다. CI의
   `ux tasks` 작업은 예산을 넘은 작업을 실패시킨다.

## 방법 요약

자세한 내용, 값, 출처: [ux-metrics.md](ux-metrics.md).

- **Keystroke-Level Model**(KLM): 작업은 연산자(K 키, P 가리키기, B 버튼, H 손 이동, M 마음의 준비)의
  줄이고, 시간은 그 합이다. 숙련자가 실수 없이 하는 시간을 예측하며, 한 작업의 두 버전을 비교하는 데
  쓴다.
- **Fitts의 법칙**은 화면 위 대상의 거리와 너비로 가리키기 하나하나의 값을 매긴다.
- **Hick–Hyman 법칙**은 n개 중 하나를 고르는 값을 매긴다. 앞의 M이 이미 그 결정을 대신하므로 메모로만
  보고한다.

## 아직 재지 않는 것

KLM이 보지 못하는 것과, 언제 더할지:

| 재지 않는 것 | 잡아낼 것 | 언제 |
|---|---|---|
| 처음 쓰는 사람의 학습 용이성 | 앱을 본 적 없는 사람이 경로를 찾기나 하는지, 얼마나 걸리는지 | 1.0 전에: 개발자가 아닌 사람 몇 명과 첫 실행을 함께 하며 시간을 재고 적는다 |
| 실사용 중 한 문항 SEQ(Single Ease Question) | 작업을 마친 직후 얼마나 어렵게 느꼈는지, 7점 척도로 | 팀 밖의 사용자가 생기면: 핵심 작업 뒤에 한 번 묻는다 |
| 인지적 워크스루 | 처음 온 사람이 다음에 무엇을 할지 모를 곳을, 아무것도 돌리지 않고 한 단계씩 | 새 흐름을 만들기 전에, 그리고 보이는 경로가 긴 작업에 |
| 실수와 복구 | 잘못 든 길과 그 값 | 위의 첫 실행 관찰과 함께 |
| 읽기와 기다림 | 읽는 데 드는 시간, 느린 호스트나 원격 기계 | 기다림은 목이 아니라 실제 호스트에서 잰다 ([ux-metrics.md](ux-metrics.md) "Waits") |

## 참고 문헌

- Card, S. K., Moran, T. P., & Newell, A. (1983). *The Psychology of Human-Computer Interaction*.
  Lawrence Erlbaum.
- Fitts, P. M. (1954). The information capacity of the human motor system in controlling the
  amplitude of movement. *Journal of Experimental Psychology*, 47(6), 381–391.
- Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental
  Psychology*, 4(1), 11–26. Hyman, R. (1953). Stimulus information as a determinant of reaction
  time. *Journal of Experimental Psychology*, 45(3), 188–196.
- ISO 9241-11:2018, Usability: definitions and concepts.
- Nielsen, J. (1994). 10 Usability Heuristics for User Interface Design. Nielsen Norman Group.
- Sauro, J., & Lewis, J. R. (2016). *Quantifying the User Experience* (2nd ed.). Morgan Kaufmann.
  (SEQ, 그리고 작은 연구의 표본 크기.)
- Wharton, C., Rieman, J., Lewis, C., & Polson, P. (1994). The cognitive walkthrough method: a
  practitioner's guide. In *Usability Inspection Methods*. Wiley.
