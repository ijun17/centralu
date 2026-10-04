# Protocol — UI와 Agent Host의 공용 언어

> 영어 원본: [protocol.md](protocol.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

`packages/protocol`은 의존성 0개의 최하층 패키지다. **여기에 없는 타입은 프로세스 경계를 넘을 수 없다.**

## 1. 전송 계층

- WebSocket, 텍스트 프레임 1개 = JSON 메시지 1개.
- 연결 직후 핸드셰이크: `{ kind: 'hello', token, protocolVersion, afterSeq?, streamEpoch? }` → 불일치 시 즉시 종료(에러 코드와 함께), 성공하면 `{ kind: 'hello_ok', protocolVersion, resyncRequired, currentSeq, streamEpoch, build? }`. 토큰은 호스트가 시작될 때 생성되며, dev에서는 환경 변수로 전달된다.
- `hello_ok.build`(#280)는 호스트가 어떤 빌드이고 어디서 왔는지 말한다: `{ commit, protocolVersion, version?, bundlePath?, copyDir? }`. 키퍼 아래에서는 한 빌드의 창이 다른 빌드의 호스트에 붙을 수 있고, 클라이언트는 이것으로 안다. 커밋은 호스트 자신에 컴파일된 것이고, 나머지는 키퍼가 호스트를 복사해 온 번들의 기록이다([agent-host.ko.md](agent-host.ko.md) §4.1). 선택 필드다: 옛 호스트는 보내지 않고, 소스로 띄운 호스트는 `commit: 'dev'`를 보낸다.
- **`hello_ok` 전에는 hello 말고 아무것도 나가지 않는다** (#82). 클라이언트는 `hello_ok`가 온 뒤에야 `connected`를 알리고 쌓아 둔 호출을 만든 순서대로 보낸다. 그 전에 온 다른 프레임은 무시한다. 열렸는데 답이 없는 소켓은 10초 뒤 버리고 다시 시도하며, 호스트는 10초 안에 올바른 hello를 보내지 않은 소켓을 닫는다(4001). #82 전에는 소켓이 열리는 순간 큐를 쏟아, 거절된 핸드셰이크가 호스트가 실행한 적 없는 호출을 "연결이 끊김, 호스트에 닿았을 수 있음"으로 만들었다.
- 방향에 따라 두 종류: **RPC**(요청/응답, UI→host)와 **이벤트 스트림**(host→UI, 단방향 푸시).

```ts
// envelope
type Rpc     = { kind: 'rpc';   id: string; method: string; params: unknown }
type RpcRes  = { kind: 'res';   id: string; ok: true; result: unknown }
             | { kind: 'res';   id: string; ok: false; error: ProtocolError }
type Push    = { kind: 'event'; seq: number; sessionId?: string; event: NormalizedEvent }
```

- `seq`는 호스트가 부여하는 단조 증가 번호다. 재연결 시 `subscribe({ afterSeq })`로 놓친 것을 재생한다 — **재연결이 상태 손실이 되지 않게 하는 핵심 장치다.**
- **seq는 그 번호를 매긴 호스트 수명 안에서만 뜻이 있다** (#82). 호스트 프로세스마다 무작위 `streamEpoch`가 있고 `hello_ok`에 실린다. 재연결은 `afterSeq`를 그 epoch와 함께 보낸다. 호스트는 자기 epoch일 때만 재생한다: 다른 epoch의 커서, 또는 epoch 없는 양수 `afterSeq`는 이벤트 없이 `resyncRequired`를 받는다. 클라이언트도 `hello_ok`의 epoch를 커서가 온 epoch와 비교해 다르면 재동기화한다. #173의 `currentSeq` 검사가 보지 못하던 경우가 이것이다: 같은 주소로 다시 뜬 호스트가 이미 옛 커서를 넘겨 번호를 매겼으면, 제 수명의 꼬리를 "놓친 것"으로 건넸다(측정: A1..A3를 든 클라이언트가 `A1, A2, A3, B4, B5`를 받았다).
- 호스트는 최근 이벤트를 링 버퍼(+ 스토어)에 보관한다. afterSeq가 버퍼 밖이면 `resync_required`를 보내고, UI는 스냅샷을 다시 로드한다: 세션 목록과, 대화를 든 세션 전부의 저장된 대화다 (#173).
- **재생은 시작하기 전에 값을 잰다** (#82). 호스트는 `hello_ok`와 재생할 프레임 전부를 WebSocket 프레이밍까지 포함한 전송 바이트로 더하고, 합이 재생 예산(16 MiB)을 넘으면 `currentSeq`와 함께 `resyncRequired`로 답하며 재생은 하나도 보내지 않는다. 재생을 시작했다가 중간에 끊으면 클라이언트의 커서가 그대로 남아, 매 재연결이 같은 구간을 다시 청한다 — 끝나지 않는 재연결 고리다. 재동기화 때마다 클라이언트는 커서를 `currentSeq`로 옮겨, 다음 재연결은 거기서 시작한다.
- **이벤트 하나는 한 번만 넘긴다** (#82). 호스트는 이미 인증된 소켓의 두 번째 hello를 무시하고(전에는 구간을 다시 재생했다), 클라이언트는 마지막으로 넘긴 seq보다 크지 않은 이벤트를 전부 버린다.
- `afterSeq`도 `streamEpoch`도 없는 hello는 첫 만남이다. 호스트는 여전히 버퍼를 재생하지만 클라이언트는 그 이벤트를 새 사건으로 넘기지 않는다 — 이 페이지가 붙기 전에 끝난 일이고, 세션 목록과 저장된 대화가 출발점이다(클라이언트는 `hello_ok.currentSeq`를 커서로 삼고, 재생은 중복 필터가 버린다). 그 전에 다른 호스트와 이야기하던 클라이언트(데스크톱이 새 포트로 옮겨 붙음)면 `resync_required`를 올려 UI가 든 것을 다시 읽게 한다. 첫 `hello_ok` 뒤의 재연결은 언제나 커서를 싣는다, `afterSeq: 0`이라도.
- 호스트의 `currentSeq`보다 큰 `afterSeq`는 호스트가 같은 주소로 다시 떠 번호를 1부터 다시 매긴다는 뜻이다(웹·개발 모드). 호스트는 `resyncRequired: true`로 답하고, 클라이언트는 자기 `lastSeq`를 호스트의 `currentSeq`로 내려 이후의 재연결이 새 번호로 청하게 한다.
- `connection_lost`로 거절된 RPC도 호스트에 닿았을 수 있다. UI는 보낸 말을 pending으로 남겨 두고, 다시 붙은 뒤 저장된 대화를 확인한 다음에야 보내지 못한 글로 되돌린다 (#173).
- **결과를 모르는 호출은 다시 보내지 않는다** (#82). 인증된 소켓으로 나갔다가 답을 잃은 호출만 `connection_lost`로 거절된다. 그 오류는 호스트가 했을 수도 안 했을 수도 있다고 말하고 `retryable`이 아니다 — 이름 바꾸기·보내기·커밋을 눈감고 다시 하면 두 번 될 수 있다. 소켓이 끊길 때 아직 큐에 있던 호출은 나간 적이 없으므로 다음 `hello_ok` 뒤에 나간다.
- **대기 작업과 송신 작업에는 한도가 있다** (#82). 연결 하나가 양쪽에 쥐게 할 수 있는 양의 한도이지, 프로세스 메모리 한도가 아니다.
  - 클라이언트: 동시에 기다리는 호출 512개, 보내지 않은 프레임 64 MiB. 넘는 호출은 큐에 넣기 전에 `overloaded`, `retryable: true`로 거절한다 — 아무것도 나가지 않았으니 결과가 확실하다.
  - 호스트: 빠지지 않은 송신 적체가 이미 64 MiB를 넘은 소켓은 읽기를 멈춘 것(잠든 WebView, 멈춘 클라이언트)이라 끊는다. 깨어나면 다시 붙어 재생이나 재동기화를 받는다. 호스트의 에이전트는 보는 쪽을 기다리지 않는다. 규칙이 "이 프레임이 선을 넘으면"이 아니라 "이미 넘었으면"인 이유: 수십 MB짜리 프레임 하나는 정상이다(큰 diff, 이미지).
- **종료에는 기한이 있다** (#82). 호스트의 `close()`는 소켓마다 닫기 프레임을 보내고 250 ms 기다린 뒤 끊으며, 일반 HTTP 연결은 바로 끊는다. 두 번째 `close()`는 같은 종료를 돌려준다. 전에는 닫기 프레임에 답하지 않는 상대가 `ws`의 30초 동안 종료를 붙잡아, 데스크톱 수퍼바이저의 3초 예산을 넘겼다. 클라이언트의 `close()`는 재연결·핸드셰이크·호출 타이머를 남기지 않고, 그 뒤의 호출은 곧바로 `connection_closed`로 실패한다.

## 2. NormalizedEvent (product spec §6.2의 구체화)

**정본 유니온은 `packages/protocol/src/events.ts`에 있다** — 모든 필드·기본값과
그렇게 정한 이유의 주석까지. 이 목록은 용도별로 묶은 지도다. 골든 픽스처 테스트
(`protocol.test.ts`)는 스키마에 있는 타입이 픽스처 없이 존재하는 순간 실패한다 —
스키마가 자기 예제보다 조용히 커질 수 없다.

```ts
type NormalizedEvent =
  // 대화 내용 (별도 표기가 없으면 seq로 영속된다)
  | { type: 'message_delta';    sessionId, role, text, messageId? }  // 스트리밍 본문; messageId: 어느 메시지의 조각인지 (#212)
  | { type: 'reasoning_delta';  sessionId, text?, estTokens? }  // #58: codex는 요약 텍스트, claude는 토큰 추정치뿐
  | { type: 'user_message';     sessionId, seq, text, from? }   // 사람의 말, 또는 다른 세션의 지시 (FR-11)
  | { type: 'tool_call';        sessionId, callId, summary: ToolSummary, input? }  // input: 도구가 받은 입력 그대로 (#221)
  | { type: 'tool_result';      sessionId, callId, ok, summary, output? }           // output: 결과 글 전체 (#221)
  | { type: 'message_image';    sessionId, mime, data, path?, note? }  // #40; 표시 실패의 이유는 note가 말한다
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 마커
  // 턴 안의 진행 상황 (표시 전용, 영속되지 않는다)
  | { type: 'activity';         sessionId, activity|null }      // 압축 중 / 리뷰 중 / 재연결 중 (codex)
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated 스냅샷
  | { type: 'tool_output_delta';sessionId, callId, text }       // #58: 실행 중 명령 출력의 꼬리 · #98: 서브에이전트의 걸음 (띄운 Agent 호출에)
  // 네이티브 서브에이전트가 한 일 — 대화와 따로 남는다 (#222)
  | { type: 'subagent_event';   sessionId, parentCallId, step: SubagentStep, stepSeq? }  // step: message_delta, reasoning_delta, tool_call, tool_result 중 하나
  // 사람이 답해야 하는 것
  | { type: 'approval_request'; sessionId, requestId, detail: ApprovalDetail }
  | { type: 'approval_resolved';sessionId, requestId, decision }
  | { type: 'question_request'; sessionId, requestId, questions: Question[] }  // AskUserQuestion
  | { type: 'question_resolved';sessionId, requestId }
  // 세션 상태와 계기판
  | { type: 'turn_complete';    sessionId }
  | { type: 'state_change';     sessionId, state: SessionState, reason? }
  | { type: 'usage_update';     sessionId, tokens: TokenUsage }
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?, usedPercent?, windowMins? }
  | { type: 'session_title';    sessionId, title, auto }        // auto=false: 사람이 지은 이름 — 자동 이름이 덮지 않는다
  | { type: 'settings_changed'; sessionId, model, effort, verbosity, serviceTier? }  // #30: 사람 아닌 손이 설정을 바꿨다
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 충돌 감지, FR-5 하이라이트
  | { type: 'goal';             sessionId, goal: SessionGoal|null }  // 배지; codex는 알려 주고, claude는 CLI의 /goal 답과 Stop 훅 피드백에서 읽는다
  | { type: 'background_tasks'; sessionId, live: BackgroundTask[], ended?: BackgroundTask[], clearEnded? }  // #290: 살아 있는 집합(REPLACE)과 방금 끝난 것
  | { type: 'history_synced';   sessionId, added }              // 밖에서 이어간 대화를 따라잡았다
  | { type: 'session_deleted';  sessionId }
  // 앱 스코프 (sessionId optional — 모든 사실이 대화의 소유물은 아니다)
  | { type: 'update_status';    status: UpdateStatus }          // #43
  | { type: 'fs_changed';       projectId, dirs: string[] }     // #34
  | { type: 'error';            sessionId?, error: ProtocolError }
```

**도구 호출의 `summary`는 카드이고, `input`과 `output`은 기록이다. 기록은 host 밖으로 나가지 않는다**
([#221](https://github.com/ijun17/centralu/issues/221)). 어댑터는 둘 다 보낸다: `summary`는 카드가 보여 주는 것(명령,
경로, Claude 결과의 앞 300자·Codex 결과의 앞 2,000자)이고, `input`은 도구가 받은 것(Write의 내용, Edit의 양쪽, Codex의
파일 변경과 그 diff), `output`은 도구가 답한 글 전체다. 이미지는 빠진다(첨부로 남는다, #40). host는 이벤트를 온 그대로
저장하고, 내보내는 모든 것 — 이벤트 스트림과 기록 페이지(`messages.load`, `trash.read`) — 에서 `input`과 `output`을
걷는다. 그래서 이 선 위에서 두 칸은 언제나 비어 있다. 여기 선언해 두는 이유는 저장된 payload가 이 이벤트이고, 이름을 대고
묻는 저장소의 독자(`Store.loadMessages(…, { full: true })`)가 이 모양을 받기 때문이다. 왜 남겨 두는지는
[security-boundaries.md](security-boundaries.md#tool-output-in-the-store)에 있다.

**네이티브 서브에이전트의 걸음은 부모 이벤트에 붙인 표시가 아니라 감싸는 종류 하나다**
([#222](https://github.com/ijun17/centralu/issues/222)). Claude Code의 `Agent` 도구와 Codex의 `spawn_agent`가 띄운
서브에이전트의 글, 추론, 도구 호출과 결과는 부모의 스트림으로 host에 온다. 각각은 `subagent_event`가 된다. `step`은 부모의
모양 그대로이고, `parentCallId`는 띄운 호출이다: Claude는 `Agent` tool_use id(서브에이전트의 `parent_tool_use_id`),
Codex는 `spawnAgent` collab 항목(그 `receiverThreadIds`가 자식 스레드를 가리킨다). 서브에이전트가 또 띄운 것은 그
서브에이전트의 띄운 호출로 표시된다.

| 결정 | 이유 |
|---|---|
| `tool_call` 등에 `parentCallId`를 붙이지 않고 감싸는 종류를 둔다 | 모르는 종류는 받는 쪽이 무시한다(§4). 칸으로 붙이면 `tool_call`을 읽는 모든 곳이 그 칸을 봐야 하고, 하나라도 잊으면 서브에이전트의 호출이 부모의 대화에 다시 들어간다 — #98이 없앤 버그다. 감싸면 대화, 상태 기계, 안 읽음, 턴 처리가 한 줄도 없이 건너뛴다 |
| `step`은 부모의 모양을 다시 쓴다 | 저장소는 부모의 행처럼 걸음을 남기고, 화면은 같은 코드(`messagesToChat`)로 그린다 |
| 걸음 하나는 통째다 | Claude는 서브에이전트의 글을 블록 단위로 넘기고, Codex 자식 항목은 끝날 때 읽는다. 흘릴 것도 이을 것도 없다 |
| `seq`가 아니라 `stepSeq` | 그 띄운 호출의 걸음 중 몇 번째인지이며, host가 저장할 때 붙인다. `seq`였다면 대화가 아닌 것이 세션의 안 읽음 표시를 움직인다 |

선 위에서 걸음의 도구 `input`과 `output`은 부모의 것처럼 걷힌다(`withoutToolRecord`가 감싼 안을 본다). 걸음을 다시
읽는 것은 띄운 카드 하나를 지목하는 `messages.subagent`뿐이고, `messages.load`에는 결코 없다. 실행 중인 Claude 에이전트의
카드는 여전히 `tool_output_delta`로 걸음마다 한 줄을 받는다.

**에이전트의 백그라운드 작업은 가장자리 한 쌍이 아니라 수준 신호 하나다** ([#290](https://github.com/ijun17/centralu/issues/290)).
`background_tasks.live`는 바뀐 뒤 세션 뒤에서 돌고 있는 작업 전부이며 지난 것을 갈아 끼운다. `ended`는 방금 빠진
작업을, 각각 어떻게 끝났는지와 함께 싣는다. 작업 하나는 `BackgroundTask`다:

```ts
type BackgroundTask = {
  id: string
  kind: 'agent' | 'shell' | 'mcp' | 'other'  // 모르는 말은 'other'로 읽는다
  description: string
  parentCallId?: string    // 그것을 시작한 호출. 에이전트라면 그 걸음의 열쇠 (#222)
  ambient?: boolean        // 도구가 활동이 아니라고 하는 살림 작업 — 목록에는 있지만 세지 않는다
  stopsWithTurn?: boolean  // 턴을 중단하면 어떻게 되는지, 도구마다 측정한 대로. 없으면 측정하지 않은 것
  stoppable?: boolean      // agents.stopBackgroundTask로 그것만 멈출 수 있다
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary?: string         // 어떻게 끝났는지, 도구의 말로
}
```

`SessionInfo.backgroundTasks`는 실행 중인 작업 다음에 아직 목록에 남은 끝난 작업을 쥔다(최대 10개,
`agents.clearBackgroundTasks` 전까지). `goal`처럼 살아 있는 동안만 있다: 이 작업을 쥔 것은 도구의 프로세스다. host,
UI 리듀서, mock 모두 한 함수 `applyBackgroundTasks`로 목록을 움직인다.

| 결정 | 이유 |
|---|---|
| started/ended 쌍이 아니라 REPLACE 의미의 수준 신호 | Claude의 `background_tasks_changed`가 수준 신호인 이유가 이것이다(sdk.d.ts): 끝 알림 하나를 놓쳐도 작업이 영원히 "실행 중"으로 남지 않는다. 끝은 함께 싣는다. 수준 신호만으로는 작업이 멈췄다고 말할 수 없기 때문이다 |
| `stopsWithTurn`을 도구가 아니라 작업마다 | 도구 안에서도 다르다: Claude는 턴과 함께 서브에이전트를 멈추고 셸은 계속 돌게 둔다. Codex는 자식 에이전트를 계속 돌게 둔다(측정, [agent-host.md](agent-host.md) §2). 중지 버튼은 어느 것인지 말해야 한다 |
| 없으면 측정하지 않은 것 | 어댑터가 측정하지 않은 작업은 화면에서 "계속 돌 수도 있다"가 된다. 어느 쪽으로도 약속하지 않는다 |
| 끝난 작업은 지울 때까지 남는다 | 2026-10-04 사고: 서브에이전트 둘이 중단과 함께 멈췄는데 네 시간 동안 화면 어디에도 그 말이 없었다 |
| 이벤트 옆에 `capabilities.backgroundTasks` | 백그라운드 작업을 볼 수 없는 어댑터의 침묵은 "돌고 있는 것 없음"이 아니다. idle 판단(#297)은 둘을 구별해야 한다 |

`ApprovalDetail`은 인라인 배너 승인(FR-3)의 판단에 필요한 것을 담도록 **어댑터가 미리 구조화**한다:

```ts
type ApprovalDetail =
  | { kind: 'command';   command: string; cwd: string }               // approvable from the banner
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean } // "needs review"
  | { kind: 'other';     raw: string }                                 // always "needs review"
```

판단 로직(core/approval)은 `kind`만으로 결정한다 — UI가 도구별 raw 포맷을 알 필요가 없도록 anti-corruption이 작동하는 실전 사례다.

## 3. RPC 메서드 (요약)

| 그룹 | 메서드 | 비고 |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, resumeSession, deleteSession` | product spec §6.2. `deleteSession`은 세션을 휴지통으로 보낸다 (FR-22) |
| 백그라운드 작업 | `agents.stopBackgroundTask, agents.clearBackgroundTasks` | #290: 어댑터가 `stoppable`로 표시한 작업 하나를 멈춘다(그 끝은 `background_tasks`로 온다). 끝난 것을 목록에서 걷는다 |
| trash | `trash.list, trash.read, trash.restore, trash.purge, trash.empty` | 휴지통에서 나오는 길 (FR-22). 사람만 쓴다 — 에이전트의 도구와 앱의 능력은 닿지 않는다 |
| messages | `messages.load, messages.subagent, messages.search` | 기록 한 페이지; 띄운 카드 하나의 서브에이전트 걸음, 사람이 펼칠 때 읽는다 (#222); 오간 말의 검색 |
| grid | `grid.get, grid.set` | 그리드의 패널들, 순서대로, 통째로 쓴다 (product spec §5.4). 하나하나가 `GridPanel`이다: `{ kind: 'session', sessionId }` 또는 `{ kind: 'app', projectId: string \| null, appId }` (`null`은 사용자 폴더의 앱) — #288. 바꾸지 않고 넓혔으므로 (§4) `PROTOCOL_VERSION`은 1 그대로다: `grid.get { tagged: true }`와 `grid.set { panels }`는 패널로 말하고, 그것이 없으면 둘 다 #288 이전의 모양, 세션 id만의 목록으로 말한다 (이전 UI의 `grid.set { sessionIds }`는 목록을 그 세션들로 바꾼다). UI는 `panels` 옆에 `sessionIds`도 보내고 id만의 목록을 세션 패널로 읽으므로, 한 빌드 차이의 UI와 host는 어느 쪽으로든 계속 함께 돈다; 이전 필드는 한 릴리스 뒤에 빠진다. `grid.set`은 최대 256개를 받고 저장한 것을 돌려준다: 중복, 모르는 세션, 등록되지 않은 프로젝트의 앱은 빠진다. 앱이 있는지는 확인하지 않는다 — 앱 목록은 폴더보다 늦을 수 있고, 찾지 못한 앱은 화면이 빼고 그린다. 모양은 패널의 정체성뿐이라 그대로 클라이언트로 옮겨 갈 수 있다 (#82) |
| git (dev) | `git.status, git.log, git.branches, git.diff, git.checkout` | prod에서는 같은 계약을 Tauri invoke로 |
| fs (dev) | `fs.listDir, fs.readFile, fs.watchProject` | 〃 |
| store (dev) | `store.loadWorkspace, store.saveWorkspace, store.appendMessages, …` | 〃 |
| usage | `usage.weekly(range)` | 호스트에 상주 |

git/fs/store RPC의 요청·응답 타입은 **포트 인터페이스와 1:1**이다. 의도된 중복이다 — 포트가 원본 계약이고, RPC와 Tauri invoke는 그 계약을 실어 나르는 두 운반체일 뿐이다.

## 3.1 경로를 표기하는 법 ([#47](https://github.com/ijun17/centralu/issues/47))

이 경계를 넘는 경로에는 두 종류가 있고, 둘은 같은 종류의 것이 아니다.

| 종류 | 예시 | 인코딩 |
|---|---|---|
| **프로젝트 상대 경로** | 모든 `fs` RPC의 `rel`, `FsEntry.path`, git의 파일 경로, 메시지가 링크하는 경로 | **항상 POSIX(`/`)**, 모든 호스트·모든 플랫폼에서 |
| **네이티브 경로** | `ProjectInfo.path` — 프로젝트의 디렉터리 | OS 고유 표기, **절대 분해하지 않고, 절대 정규화하지 않는다** |

**상대 경로를 정규화하는 이유.** `packages/ui`는 어느 OS 위에서 도는지 알 수 없게 되어 있다
([platform-abstraction.ko.md](platform-abstraction.ko.md) 참고; `tooling/styles.test.ts`가 강제한다).
상대 경로가 네이티브 구분자를 실어 나른다면 UI 안에서 Windows에서는 이렇게, 다른 곳에서는
저렇게 읽어야 하는데, 그것이 바로 그 규칙이 금지하는 분기다. git도 반대편에서 이를 확정한다:
git 자신의 경로 포맷은 모든 플랫폼에서 POSIX이고 그 출력은 그대로 화면에 도달하므로,
다른 선택을 하면 git의 답을 아무 이득 없이 변환해야 한다.

**절대 경로를 정규화하지 않는 이유.** 프로젝트 디렉터리는 OS 폴더 선택기로 고르고
그대로 OS에 되돌려준다 — 터미널의 cwd, 프로세스의 cwd, 파일 관리자. 아무것도 그것을
조작하지 않는다. 정규화는 이득 없이 손실만 낳는다: `C:\Users\me`에는 Windows가 다시
받아들일 POSIX 표기가 없다.

**변환이 일어나는 곳.** 상대 경로가 실제 파일시스템과 만나는 호스트의 가장자리,
그리고 그곳뿐이다. `@cc/protocol`의 `wireSegments` · `wireBaseName` · `wireJoin`이
구분자가 적혀 있는 유일한 곳이고, `osPathBaseName`은 다른 종류를 위한 것이다. macOS와
Linux에서는 이 변환이 항등이라서, 잘못해도 대가가 없었다 — 명문화되기 전까지는.

이것이 앱을 Windows에서 돌게 만드는 것은 **아니다** ([#14](https://github.com/ijun17/centralu/issues/14)).
그 전제 조건이다: 익명의 가정 스물한 개 대신 이름 붙은 가정 하나 — 그래서 Windows 빌드는
Windows에 관한 이유로만 실패한다. 스물두 번째 가정이 생기면 `tooling/paths.test.ts`가 빌드를 실패시킨다.

## 3.2 앱 문서 ([#81](https://github.com/ijun17/centralu/issues/81))

앱마다 JSON 문서 하나와 켜짐 여부가 있다. `apps.*` RPC와 `app_state_changed` 이벤트는 그 문서를
`unknown`으로 나르고, 전선의 어떤 스키마도 그것을 검사하지 않는다. 프로토콜은 문서의 뜻을 모른 채
운반만 한다. 그래서 앱마다 RPC를 따로 만들지 않아도 된다.

**그래도 문서의 모양은 한 곳에 적는다.** 앱에는 두 절반이 있다. 호스트 쪽(도구, 관찰)과
UI 쪽(레일, 설정)이다. 둘은 같은 문서를 읽고 쓴다. 두 절반이 함께 임포트할 수 있는 패키지는
`@cc/protocol`뿐이므로 모양은 거기에 둔다. 관제 앱의 모양은 `control-app.ts`에 있다. 전선의
스키마는 그것을 쓰지 않고, 프로토콜의 다른 파일도 그것을 임포트하지 않는다.

두 벌로 적으면 어긋난다. 관제 앱의 호스트 쪽은 `notifies`를 필수로, UI 쪽은 선택으로 적었고,
UI는 그 칸 없이 문서를 썼다. 새로 설치한 뒤 레일에서 한 줄 답을 한 번 하면, 그 뒤 알림을
올릴 때마다 호스트가 `doc.notifies.push`에서 undefined로 넘어졌다.

앱 문서를 적는 규칙:

- **문서의 최상위 칸은 모두 선택으로 둔다.** 어느 쪽이 먼저 쓸지 모르니 어느 칸이든 없을 수 있다.
  빈 칸의 기본값은 그 칸을 읽는 쪽이 채운다.
- **zod 스키마가 아니라 TypeScript 타입으로 적는다.** 이 문서를 검증하는 곳이 없다. 스키마를
  두면 아무도 하지 않는 검사를 하는 것처럼 읽힌다.
- **벤더 이름을 적지 않는다** (`tooling/boundaries.test.ts`). 도구는 `ToolName`으로 적는다.

이 규칙은 Centralu에 컴파일된 앱에만 해당한다. M4의 외부 앱은 상태를 자기 프로세스에
둔다([plans/apps-plan.md](plans/apps-plan.md)).

## 4. 스키마와 버전 규칙 (C6 방어)

- 모든 메시지는 zod 스키마로 정의되고 **경계에서만** 검증된다 (수신 시 1회. 내부 재검증은 금지 — 성능).
- `protocolVersion`은 단일 정수다. 호환 규칙:
  - **추가는 자유다** (새 이벤트 타입, 새 optional 필드) — 버전이 바뀌지 않는다.
  - 수신자는 **모르는 이벤트 타입과 필드를 반드시 무시해야 한다** (zod `passthrough` + discriminated union의 fallback case).
  - 필드 삭제나 의미 변경 = 버전 증가 = 핸드셰이크에서 거부. **가능한 한 피한다** — 새 필드를 추가하고 옛 필드를 한 마일스톤 동안 유지하는 편이 언제나 더 싸다.
- 골든 테스트: 버전별 샘플 메시지 JSON을 픽스처로 동결하고, 스키마가 바뀌면 과거 픽스처가 여전히 파싱되는지 CI가 검증한다.

## 5. 에러 모델

```ts
type ProtocolError = {
  code: 'adapter_crashed' | 'conversation_locked' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'internal'
  message: string          // a human-readable explanation (must be displayable in the UI as is)
  retryable: boolean
  data?: unknown           // extra information per code (rate_limited → resumeAt etc.)
}
```

- code는 닫힌 집합이다. UI는 code로 분기하고 message는 표시만 한다. 문자열 매칭 분기는 금지다.
- 어댑터의 raw 에러(SDK 예외, 프로세스 종료 코드)는 호스트 내부에서 이 형태로 변환된다.
