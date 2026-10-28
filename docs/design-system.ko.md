# 디자인 시스템: 화면을 그리는 규칙

Centralu의 모든 화면이 따르는 것: 색, 모양, 선, 글자, 아이콘, 상단 바의 캡슐, 대화, 대기 카드, 움직임,
상태, 공유 컴포넌트. 규칙마다 왜 그런지와 코드의 어디에 있는지를 적는다. 값 자체는
`packages/ui/src/styles/index.css`의 토큰이다. 테마가 그 값을 정하는 법은 [themes.ko.md](themes.ko.md),
화면을 판단하는 법은 [usability.ko.md](usability.ko.md), 화면의 말은 [ux-writing.md](ux-writing.md)(초안,
영어만)에 있다. *owner, 2026-10-18* 로 표시한 결정은 화면에서 내려졌고, 적힌 자리의 코드 주석에 기록돼 있다.

## 1. 색

| 규칙 | 이유 | 코드 |
|---|---|---|
| **밝기가 중요도를 말한다.** 잉크는 모든 표면에서 `ink-signal` > `ink` > `ink-muted` > `ink-faint` 순서다. 밝은 테마에서는 대비가 같은 순서를 만든다 | 화면 틀에 색상이 없으니 남은 척도는 밝기뿐이고, 어디서나 같은 방향으로 읽히는 척도 하나는 한 번만 배우면 된다. 흑백에서도, 색각이 다른 사람에게도 읽힌다 | `index.css`의 `@theme`. 순서는 모든 프리셋에서 검사하고 사용자 테마에는 경고한다(`app/theme.ts` `urgencyBreaks`, [themes.ko.md](themes.ko.md)) |
| **흰색은 사람을 기다리는 것에만**: 승인, 질문, 봐야 할 오류. `ink-signal`(어두운 쪽은 순백, 밝은 쪽은 순흑)은 호버, 선택, 강조색, 장식에 쓰지 않는다 | 화면에서 가장 밝은 것은 나를 필요로 하는 것이어야 한다(product-spec FR-12). 흰색을 다른 데 쓰면 그것과 다툰다 | `--color-ink-signal`, `.signal`. 강조색은 이 색을 칠하지 않는다 |
| **흰 테두리가 기다림의 종류를 말한다.** 실선 흰 테두리 = 승인이나 질문이 기다린다. 점선 흰 테두리 = 봐야 할 오류(또는 멈춤). 오류가 승인보다 앞서므로 둘 다 있으면 점선이다 | 종류를 색상이 아니라 모양으로 말하니 흑백에서도 남는다. 같은 한 쌍을 어디서나 쓰니 한 번만 읽으면 된다 | 세션 표시와 패널(`.cc-mark`, `.cc-panel` `data-look`), 받은함 캡슐(`InboxPill.tsx` `edge`), 대기 카드(`ApprovalCard.tsx`, `QuestionCard.tsx`) |
| **흰색 없는 점선 = 실패했고 기다리는 것은 없다.** 실패한 도구 호출, 실패한 백그라운드 작업은 회색 점선이다 | 이미 끝난 실패는 기록이지 행동하라는 부름이 아니다 | `ChatRow.tsx`(도구 카드), `BackgroundTasks.tsx` |
| **다른 색상은 없다.** 색은 diff의 초록과 빨강(diff 안에서만), `danger`(무언가를 없애는 것, 또는 실패한 것), 터미널의 ANSI 팔레트, 파일 종류 아이콘, 포인터 아래 Windows 자체의 닫기 버튼 빨강뿐이다 | diff의 초록과 빨강은 승인을 판단하는 자리에서 거의 반사이고, 나머지는 밝기와 다툰다 | `tooling/styles.test.ts`가 이유와 함께 등록되지 않은 유채색 hex에 실패한다 |

표면은 바닥에서 위로 오른다: `surface-floor`(대화), `surface-side`(사이드바, 상단 바), `surface-raised`(바닥
위에 놓인 것: 입력창, 카드, 메뉴, 입력칸), `surface-selected`(고른 선택지), `surface-hover`(호버와 누름, 사람의
말풍선). 값과 잰 거리는 [themes.ko.md](themes.ko.md)에 있다.

## 2. 모양: 모서리 단계

모든 모서리는 이 단계 중 하나다. Tailwind 자체의 반경은 지워 두었으므로 `rounded-<단계>`는 이것들만 가리킨다.

| 토큰 | 값 | 쓰는 곳 | 이유 |
|---|---|---|---|
| `--radius-sm` (`rounded-sm`) | 3px | 체크박스, 인라인 코드 | 글줄 안의 작은 표시 |
| `--radius-md` (`rounded-md`) | 4px | 버튼과 컨트롤, 키캡, 도구 카드의 도구 타일, 세션 표시 | 누르는 것의 기본 |
| `--radius-lg` (`rounded-lg`) | 8px | 패널, 메뉴, 드롭다운, 대화상자, 도구 카드, 사이드바 타일 | 담는 것, 안에 든 것보다 한 단계 둥글게 |
| `--radius-field` (`rounded-field`) | 10px | 상단 바의 검색칸, 질문의 선택지와 답 입력칸 | 입력칸이므로 캡슐처럼 완전히 둥글지 않다(*owner, 2026-10-18*, `SearchField.tsx`) |
| `--radius-field-key` (`rounded-field-key`) | 10 − 5 = 5px | 입력칸 안의 키캡(검색칸의 ⌘K) | 입력칸의 모서리에서 키 둘레의 틈을 뺀 값이라 두 곡선이 나란히 간다 |
| `--radius-bubble` (`rounded-bubble`) | 14px | 두 화자의 말풍선, 고정된 메시지, 승인 카드와 질문 카드, 대화 자체의 카드(새 세션의 지난 대화) | 말한 것과 사람을 기다리는 것은 상자가 아니라 말로 읽힌다(*owner, 2026-10-18*, `ChatStream.tsx`, `ApprovalCard.tsx`) |
| `--radius-full` (`rounded-full`) | 완전히 둥글게 | 상단 바의 캡슐, 카드의 종류 표시, 점, 스크롤바 손잡이 | 담는 것이 아니라 상태 |

- **테두리 있는 모양 안의 모양은 바깥 모서리에서 테두리를 뺀다.** 호출하는 자리에서 토큰에 calc로 쓴다(접힌
  입력창: `rounded-b-[calc(var(--radius-lg)-1px)]`).
- **가드.** `packages/ui/src/components/`와 `styles/` 밖에서 모서리를 숫자로 쓰면(`rounded-[14px]`, 인라인
  `borderRadius`) 린트 규칙 `guard/ui-radius-scale`(`tooling/eslint-guards.js`)이 실패한다. 남겨 둔 자리의
  목록(`tooling/guard-exceptions.js`)은 줄어들 수만 있다: 파일에 실제로 있는 것보다 많이 적힌 개수도 실패한다. 새 단계는 호출 자리가 아니라
  `@theme`에, 무엇이 쓰는지와 함께 들어간다.

## 3. 테두리와 선

| 토큰 | 언제 | 이유 |
|---|---|---|
| `line` | 가는 선: 카드나 패널의 테두리, 구분선, 바닥글 위의 선, 미터 트랙 | 눈을 끌지 않고 나눈다 |
| `line-strong` | 보여야 하는 테두리: 포커스되거나 호버된 입력칸, 체크박스, 그래프 레인, 쉬고 있는 세션 표시, **답 안의 표의 모든 칸(1px)** | 답은 `surface-raised` 위 `line` 테두리 말풍선에 있으므로 가는 선의 칸은 말풍선에 묻혔다(*owner, 2026-10-18*, `.cc-md th, td`. 2px도 해 보고 되돌렸다) |
| `line-side` | 사이드바 안의 선(프로젝트 사이, 행 테두리) | `line`과 `ink-faint`에서 섞어 만들어, 어느 테마에서나 사이드바 자체의 바탕에서 구분된다(`index.css`의 `:root`) |

테두리는 1px이다. 무언가를 말하는 세션 표시는 2px이다(`.cc-mark`). 17px에서 1px의 잉크 차이는 읽기에 너무
작기 때문이다. 표의 머리는 호버 단계의 절반(`surface-hover` 50%)을 깔아, 말풍선 위에서도 밖에서도 머리로 읽힌다.

## 4. 글자

| 규칙 | 이유 | 코드 |
|---|---|---|
| 사람이나 모델이 말한 것, 그리고 컨트롤, 제목, 세션 표시의 글자(사용량 도넛의 글자도)는 **Pretendard** | 코드 글꼴의 글자는 칩 안에서 중심을 벗어났다. 표시는 이름이지 수치가 아니다(*owner, 2026-10-18*, `.cc-chip-letter`) | `--font-sans`, 번들(#731) |
| 기계가 쓴 것: 코드, 경로, 명령, 로그, 터미널, 그리고 **줄을 맞춰야 하는 숫자**: 캡슐과 접힌 프로젝트의 개수, 수치, 크기, 시간 길이는 **D2Coding** | 고정폭 숫자는 개수가 바뀌어도 자리가 움직이지 않는다. 한글이 라틴의 두 배 폭이라 코드 속 한국어도 격자에 맞는다 | `--font-mono`, `.readout`(`tabular-nums`를 더한다) |
| **크기 다섯**: `text-2xs` 10px(라벨, 개수, 시각), `text-xs` 11px(기계가 쓴 것), `text-sm` 12px(컨트롤), `text-md` 13px(사람이 읽는 것), `text-display` 19px(첫 실행 화면의 제목). 굵기는 400, 500, 600 | 기본 확대에서 읽히는 촘촘한 대역. 화면 전체는 이것들이 아니라 루트 확대로 커진다 | `@theme`. 임의 크기는 린트 규칙 `guard/ui-type-scale`이 실패시킨다([themes.ko.md](themes.ko.md)) |

## 5. 아이콘

| 규칙 | 이유 | 코드 |
|---|---|---|
| **`currentColor`로 그린 SVG, 이모지는 쓰지 않는다** | 이모지는 OS마다 다르고 색상을 지닌다. SVG는 상태의 잉크(호버, 비활성)를 따른다 | `components/icons.tsx` |
| **상단 바는 20px**: 설정 톱니, 받은함 봉투, 사용량 도넛(24px 상자 안의 20px 고리, 호버 원이 둘레에 맞도록) | 바를 따라 한 크기라 컨트롤이 한 벌로 읽힌다(*owner, 2026-10-18*, `App.tsx`, `InboxPill.tsx`) | `GearIcon`, `MailIcon`의 `size={20}`, `UsageDonuts.tsx`(`R = 9`, 선 2.5) |
| **행 안은 14px**: 행의 메뉴(`DotsIcon`), 사이드바의 접기 화살표, 백그라운드 작업 | 행 글자의 높이 | `DISCLOSURE_ICON`(`sidebar/layout.ts`) |
| **펼치기는 어디서나 화살표 하나**: `ChevronIcon`, 닫히면 오른쪽, 열리면 90° 돈다. 뒤로·앞으로도 같은 화살표다(`StepIcon`) | 한 모양이 "여기 더 있다"를 뜻하고, 회전이 "방금 열렸다"도 말한다. 글꼴 삼각형(▸▾)은 크기도 정렬도 못 맞추고 글자보다 무겁다 | `icons.tsx`의 `ChevronIcon` |
| **말 없는 아이콘은 `IconButton`**: 이름이 툴팁이자 접근성 이름, 한 문자열이다 | 어떤 아이콘 버튼엔 툴팁이 있고 어떤 것엔 없던 일이 실제로 있었다 | `components/IconButton.tsx` |

## 6. 상단 바의 캡슐

캡슐은 `rounded-full`, 1px 테두리, 반투명한 `surface-hover` 바탕이다. 공유 모양은 `Pill`이다(#1122).

| 규칙 | 이유 | 코드 |
|---|---|---|
| **아이콘과 개수, 말은 툴팁에** | 바는 여러 상태를 한꺼번에 담는다. 상태마다 문장이면 들어가지 않고 매번 읽힌다 | `InboxPill.tsx`, `BackgroundTasks.tsx`, `UpdateLine.tsx`("Update"만 말하고 버전과 효과는 툴팁에) |
| **받은함 캡슐**은 사람을 기다리는 모든 세션을 센다. 테두리는 흰 테두리 규칙을 따른다: 승인이나 질문은 실선, 오류는 점선, 그 밖은 가는 선. 잉크는 승인이나 오류가 기다리는 동안만 신호색이다 | "Waiting for input" 수치와 대화를 가리던 알림 카드를 대신했다(*owner, 2026-10-18*) | `InboxPill.tsx` |
| **엿보기**: 화면 밖에서 새로 일어난 일이 캡슐 안에 **4초**(`PEEK_MS`) 적혔다가 개수로 접힌다. 창이 앞에 있을 때만. 떠나 있는 동안 온 것은 돌아오면 가장 최근 것이 "· N more"와 함께 적힌다 | 화면을 가리지 않는 소식. 화면에 보이는 세션의 끝난 턴은 그 줄이 접힐 때 본 것으로 친다 | `InboxPill.tsx` `useNoticePeek`, `Notices.tsx` |
| **백그라운드 작업 캡슐**: 가는 선 테두리, 작업이 도는 동안 깜박이지 않는 점. 끝나면 조용하고, 실패한 작업이 있으면 점선 | 더 밝은 테두리는 너무 튀었다(*owner, 두 번*). 켜진 점은 움직임 없이 돈다는 것을 말한다 | `BackgroundTasks.tsx` |
| **사용량 캡슐**: 도구마다 도넛 하나. 연결된 기계의 도넛은 **윤곽선만** 그린 캡슐 안에 있다. 호버는 **`surface-hover` 한 단계 전체**, 사방 2px로 **고르게 들어앉은** 원 | 칠한 캡슐은 호버가 돋보일 데가 없었다. 손이 밝히는 원은 버튼의 모양이어야 한다(*owner, 2026-10-18*). 쓸 수 있는 도구가 없는 기계는 "Offline"으로 그리지 않고 뺀다. 설치됐지만 로그아웃된 도구에도 도넛이 있다: `ink-signal`의 실선 고리와 글자이며 `danger`는 쓰지 않는다(사람을 기다리는 것이지 실패가 아니다). 모든 도구의 패널 제목은 "Usage"가 아니라 에이전트 이름이다(*owner, 2026-10-28*) | `UsageDonuts.tsx` |

## 7. 대화

| 규칙 | 이유 | 코드 |
|---|---|---|
| **사람의 말풍선은 오른쪽**(`surface-hover`, 폭은 최대 75%), **에이전트의 글은 왼쪽의 전체 폭 말풍선**(`surface-raised`, `line` 테두리). 둘 다 `rounded-bubble`, **꼬리 없음** | 쪽, 폭, 명암이 이미 누가 말했는지 말한다. 꼬리 모서리는 뺐다(*owner, 2026-10-18*). 다른 세션이나 앱이 보낸 메시지는 점선이다 | `ChatRow.tsx`, `ChatStream.tsx` `AnswerBubble` |
| **말풍선에는 에이전트가 말한 것만.** 도구 호출, 추론 요약, 이미지, 승인, 표식(압축, 넘기기, 오류 한 줄)은 말풍선 **밖**, 페이지에 서서 말풍선을 나눈다 | 말풍선 속 카드는 상자 속 상자로 읽혔고, 그 속 추론은 메시지로 읽혔다 | `ChatStream.tsx` `inBubble` |
| **시각**은 사람의 말풍선 아래와 답의 **마지막** 말풍선 아래에, 영어 시계 시각으로: "3:42 PM", `text-2xs` `ink-faint` | 채팅 앱이 그렇게 쓴다. 날짜는 구분선이 한 번 말한다 | `format.ts` `formatSaidAt`, `ChatRow.tsx` `SaidAt` |
| **날짜 구분선**은 하루가 시작되는 곳에: 두 가는 선 사이에 "Saturday, October 18, 2026" | 어떤 시각도 날짜를 지고 다니지 않게 | `ChatStream.tsx` `DayDivider`, `formatDayLong` |
| **도구 카드는 열기 전까지 제목 한 줄**: 조용한 타일 위의 도구 이름, 코드 글꼴의 입력. 출력, 그리고 제목보다 더 말하는 경우의 입력 전체는 **카드를 연 뒤에만** 보인다 | 미리보기 줄은 거의 읽히지 않으면서 모든 호출을 덩어리로 만들었다(*owner, 2026-10-18*) | `ChatRow.tsx` `ToolCard` |
| **Centralu 호출은 일어난 일로 읽힌다**: 문장 하나, 더 둥근 바탕색, 더 진한 가는 선, 닿은 세션은 칩으로. 신호색은 쓰지 않는다 | 다른 도구 호출과 구분되되, 기다리는 것과 다투지 않아야 한다 | `ChatRow.tsx`, `CentraluCall.tsx`, `CentraluCallBody.tsx` |
| **스크롤바는 내용 위에 그린다**(오버레이), 가는 알약 모양으로 | 기본 막대는 자기 열을 차지해, 말풍선 옆에 여백이 한 겹 더 생겼다 | `components/OverlayScrollbar.tsx`, `.cc-scroll-overlay` |
| **고정된 메시지**(답이 스크롤되는 동안 위에 붙잡아 둔 사람의 질문)는 말풍선 모양이다 | 같은 메시지이니 모양을 지킨다 | `StickyUser.tsx` |

## 8. 대기 카드: 승인과 질문

사람을 기다리는 카드는 모두 같게 그린다(*owner, 2026-10-18*, `ApprovalCard.tsx`, `QuestionCard.tsx`):

- `rounded-bubble`, `surface-raised` 위, 사방에 **흰 테두리**(`ink-signal` 그대로: 사람을 기다리는 테두리는 신호색을
  덜어 쓰지 않는다, *owner, 2026-10-18*).
- 왼쪽 위에 **종류를 캡슐로**(`Pill size="label" edge="solid"`), 신호색 잉크로: "Awaiting approval", "Agent is asking". 옆의 조용한 한 줄이
  무엇이 막혀 있는지 말한다.
- 본문: 명령이나 질문. 질문의 선택지는 `rounded-field`이고, 고르면 흰 테두리로 밝아진다.
- 가는 선 아래 **꾸밈없는 바닥글**: 답이 키와 함께 버튼으로(Allow, Deny, Always allow).

## 9. 움직임

| 규칙 | 이유 | 코드 |
|---|---|---|
| **층은 열리는 곳에서 오고 같은 길로 떠난다**: `cc-drop`(160ms, 위에서: 상단 바의 드롭다운, 팔레트)과 `cc-drop-out`(140ms), 아래에서는 `cc-hang` / `cc-hang-out`(위로 열리는 메뉴), 그 밑의 가림막은 `cc-fade` / `cc-fade-out`(160/150ms) | 어디서 왔는지 모르게 나타나는 것은 떠 있는 것처럼 읽힌다. 온 길로 떠나면 어디로 갔는지 보인다 | `index.css`의 keyframes |
| **존재: 퇴장은 렌더 중에 정한다**, effect에서가 아니라. `usePresence(open)`은 닫힌 뒤 `LEAVE_MS`(150ms) 동안 층을 남기고, `leaving`으로 퇴장 클래스를 붙이고 누름을 막는다 | effect는 층을 닫은 프레임 뒤에 돌아서, 층이 꺼졌다가 퇴장하려고 다시 나타나며 깜박였다(*owner, 2026-10-18*, 팔레트) | `components/presence.ts` |
| **화면의 모든 변화는 애니메이션으로 보인다**(새로 만들거나 고치는 UI의 규칙이다. 사이드바의 접기가 이를 처음 따른다, #1605): 접기·펼치기, 나타나고 떠나는 것, 화면 전환, 줄이 더해지고 빠지는 것. 길이는 약 150–200ms로, 위의 층들과 같다(`cc-drop` 160ms, `LEAVE_MS` 150ms). 입력을 늦추거나 막지 않는다: 목록이 움직이는 동안에도 포인터 아래 줄은 눌린다. 포인터에 반응하는 것은 움직임이 끝나기를 기다리지 않는다. 떠나는 것은 퇴장이 끝날 때까지 DOM에 남으므로 깜박이지 않는다. 목록은 keyframe이 아니라 grid 트랙의 transition으로 접힌다. 그래서 도중에 되돌리면 있던 자리에서 이어 간다 | 한 프레임에 바뀌는 변화는 무엇이 움직였는지 다시 읽어야 한다(*owner, 2026-10-26*, #1605). 이 규칙은 한 번 일어나는 변화에 대한 것이다. 아래 "살아 있는 것만 움직인다"는 신호로서 계속되는 움직임에 대한 것이라 둘은 충돌하지 않는다 | `Fold`(`components/Fold.tsx`, `.cc-fold`: 프로젝트의 줄, 오케스트레이터의 자식. 열림 180ms, 닫힘 140ms), `usePresence` |
| **말이 바뀌는 줄**(도구의 설정 줄: Install, 진행률, Sign in, Waiting for the browser…)은 `Fold`로 접히고 펼쳐지며, 제자리에서 `.cc-setup-swap`(170ms, 움직임 줄이기에서는 이동 없는 100ms 페이드)으로 바뀐다. 진행 막대는 너비의 transition이다(`.cc-progress`, 180ms). 상단 바가 처음 그려진 뒤에 오가는 도넛은 커지며 나타나고 흐려지며 떠난다(`.cc-donut-in` 170ms, `.cc-donut-out` 150ms, 퇴장이 끝날 때까지 DOM에 남는다) | 같은 규칙을 줄 안의 변화와 상단 바에 적용한 것 | `features/tools/ToolSetupLine.tsx`, `UsageDonuts.tsx`, `ProgressBar` |
| **살아 있는 것만 움직인다**: 진행 중인 작업은 `breathe`, 일하는 버튼은 `cc-spin`(1.4초), 응답이 끝나면 한 번 지나가는 바람 | 움직임도 신호라 "지금 일어나고 있다"에만 쓴다 | `.breathe`, `.cc-spin`, `.cc-gust` |
| **움직임 줄이기**: 모든 애니메이션이 꺼지거나 짧은 밝기 변화가 된다(회전은 breathe로, 바람은 멈춘 번쩍임으로). 층은 이동 없이 나타나고 떠나며, 접기는 높이를 그대로 두고 흐려지기만 한다(`.cc-fold`, 100ms) | 정보는 남고 움직임만 빠진다 | `index.css`의 `@media (prefers-reduced-motion: reduce)` |

## 10. 상태

| 상태 | 모양 | 이유 |
|---|---|---|
| 호버 | 반투명 `surface-hover`(캡슐과 아이콘 버튼은 `/60`), 잉크 한 단계 위(`ink-faint`에서 `ink`로). 바탕이 이미 칠해진 곳은 한 단계 전체(사용량 도넛) | 흰색을 쓰지 않고 포인터가 누를 것을 보여 준다 |
| 누름, 열림 | `surface-hover`, 연 것이 열려 있는 동안 유지(`aria-expanded`) | 버튼과 드롭다운이 하나로 읽히게 |
| 선택 | `surface-selected`와 `ink`. 대기 카드의 고른 선택지는 흰 테두리를 더한다. 거기서는 그것이 주는 답이기 때문이다 | 선택은 위치이지 긴급함이 아니다 |
| 비활성 | `opacity-50`, 호버 없음 | 어디서나 같은 흐림(*owner, 2026-10-18*). 공유 컴포넌트가 지킨다(`Button`, `Segmented`, `IconButton`, `InlineConfirm`) |
| 포커스 | `:focus-visible`: `--color-focus`의 1px 외곽선, 1px 떨어져서. 강조색을 정하면 그 색 | 키보드 포커스는 언제나 보여야 하고, 신호처럼 보여서는 안 된다 |
| 잠듦 | **어디에도 보이지 않는다**: 흐린 행도, 표시나 그 툴팁의 말도, 대화 아래의 줄도 없다. 깨어나는 중("Waking session…")과 깨우지 못했을 때(이유와 Retry)만 말한다 | 잠은 사람에게 아무것도 요구하지 않는다: 세션에 입력하면 깨어난다. 아무것도 묻지 않는 상태는 알리지 않는다(*owner, 2026-10-18*, `SessionNotes.tsx` `DormantNote`, `sidebar/marks/ToolMark.tsx`, [ux-writing.md](ux-writing.md) 1.1) |

## 11. 컴포넌트

화면은 복사한 클래스 문자열이 아니라 `packages/ui/src/components/`의 공유 컴포넌트로 그린다. 복사본은
어긋나고(여백, 호버, 비활성 흐림), 다음 화면은 그 어긋남을 복사한다.

| 필요 | 쓸 것 |
|---|---|
| 말 없는 아이콘 | `IconButton`(라벨이 툴팁이자 접근성 이름) |
| 툴팁, 키 안내 | `Tooltip`, `Kbd`(`primitives.tsx`. 키 이름은 플랫폼 포트에서 오고, ⌘를 직접 쓰지 않는다) |
| 세션 상태를 점으로 | `StateDot`(`primitives.tsx`) |
| 대화상자 | `Modal`(열린 층으로 스스로 세므로 전역 키가 안다), `useDialogFocus` / `useFocusReturn`과 함께 |
| 층의 등장과 퇴장 | `usePresence`(`presence.ts`)와 `cc-drop` / `cc-fade` 클래스 |
| 기준점 아래에 놓이는 것 | `useAnchoredPlacement`(`anchored.ts`), 닫기는 `useDismiss` |
| 그 자리에서 "정말요?" | `InlineConfirm`(Cancel 먼저, 그다음 동작, 진행 중엔 비활성) |
| 도구의 설정(설치, 로그인, 터미널 안내) | `ToolSetupLine`(`features/tools/`): 새 세션 창, 첫 실행 카드, 새 앱 창에 같은 하나(Antigravity는 역할 지시문을 받을 수 있을 때까지 첫 실행 카드와 새 앱 창에서 거절 이유만 보이고 버튼은 없다). 빈 세션의 도구 캡슐 아래에도 같은 줄이 선다. 진행 중인 일을 멈추는 버튼(설치, 로그인)은 Cancel이 아니라 **Stop**이다. Cancel은 창의 것이다(*owner, 2026-10-28*) |
| 끝이 알려진 작업의 막대 | `ProgressBar`(`value` 0~1, null이면 숨 쉰다) |
| 읽기에 실패한 목록 | `LoadFailed`(무엇을 못 읽었는지, 왜, Retry). 빈 목록으로 그리지 않는다 |
| 아직 읽는 중 | `SkeletonLines`, `ChatSkeleton`(150ms 동안 안 보이다가 서서히) |
| 막대를 내용 위에 그리는 스크롤 | `OverlayScrollbar` |
| 지난 시간 | `RelativeAge` |
| 셸의 배너 한 줄 | `ShellBanner` |
| 창을 끄는 손잡이 | `DragRegion` |
| 폭을 바꾸는 레인 | `ResizeHandle` |
| 그리드 칸 수 고르기 | `SpanButton`(`SpanPicker.tsx`) |
| 명령의 로그, 터미널 | `CommandLogView`, `xterm.ts`와 `terminalTheme.ts` |
| 아이콘 | `icons.tsx` |
| 테두리 있는 글자 버튼 | `Button`: `primary`(대화상자가 하려는 동작), `secondary`, `quiet`(호버 전까지 회색), `subtle`(흐림, 대화 안), `danger`, `ghost`(테두리 없음); `xs` / `sm` / `md`; `busy`와 `busyText` |
| 한 번에 보이는 여럿 중 하나 | `Segmented`(라디오 그룹: Tab 한 번, 방향키로 고른다) |
| 캡슐 | `Pill`: `size="bar"`(상단 바의 28px) 또는 `"label"`(기다리는 카드의 종류); 테두리 `quiet`, `live`, `solid`, `dashed` |
| 작은 대문자 라벨 | `Badge`(숫자 사이에선 `readout`) |
| 테두리 있는 입력칸 | `TextInput`, 또는 라벨·힌트·문제를 함께 그리는 `TextField` |

**가드.** 린트 규칙 `guard/hand-made-looks`는 `components/` 밖의 화면이 테두리 있는 버튼, 테두리 있는 입력칸,
작은 대문자 라벨, 캡슐을 손으로 그리면 쓸 컴포넌트를 말하며 실패한다(판별 규칙은 `tooling/eslint-guards-ts.js`).
아직 옮기지 않은 자리의 목록(`tooling/guard-exceptions.js`)은 모서리 가드처럼 **줄어들 수만 있다**.

## 정리된 어긋남

위 규칙과 어긋나던 곳을 오너가 2026-10-18에 정리했다.

- 백그라운드 작업 캡슐의 실행 점은 `bg-white`였다. 이제 `ink-signal`이라서 테마가 닿는다.
- 흰 테두리가 세 가지 잉크로 그려졌다. 이제 사람을 기다리는 테두리는 모두 `ink-signal` 그대로다(받은함 캡슐, 대기 카드, 세션 표시).
- 비활성 흐림이 40%, 50%, 60%로 섞여 있었다. 이제 모두 50%다. #1122의 `Button`도 이를 따른다.

## 바꾸기

새 모양은 토큰이나 컴포넌트로 시작하고, 이유는 그 옆 주석에 적으며, 이 문서는 같은 PR에서 바뀐다. 화면이 더는
따르지 않는 규칙이 여기 있다면 둘 중 하나의 버그다.
