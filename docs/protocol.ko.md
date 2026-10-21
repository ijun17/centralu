# Protocol — UI와 Agent Host의 공용 언어

> 영어 원본: [protocol.md](protocol.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

`packages/protocol`은 의존성 0개의 최하층 패키지다. **여기에 없는 타입은 프로세스 경계를 넘을 수 없다.**

## 1. 전송 계층

- WebSocket, 텍스트 프레임 1개 = JSON 메시지 1개.
- 연결 직후 핸드셰이크: `{ kind: 'hello', token, protocolVersion, afterSeq?, streamEpoch? }` → 토큰이 틀리면 4001로 닫는다. 프로토콜이 다르면 `id: '0'`인 `res` 프레임 하나에 `version_mismatch`를 실어 보내고 4002로 닫는다. 메시지는 두 숫자와 어느 쪽이 더 오래되었는지를 말한다("Protocol version mismatch: Centralu 0.2.0 speaks protocol 3, the app speaks protocol 2. The app is older: …"). 원격 호스트(`centralu serve`, [agent-host.ko.md](agent-host.ko.md) §4.7)에서는 둘이 따로 업데이트되기 때문이다. 거절에는 호스트의 숫자가 data로도 실린다 (#82): `error.data = { protocolVersion, version? }`. 이 호스트에 링크하는 허브(§6)는 문장을 해석하지 않고 이것으로 버전 질문을 띄운다. 성공하면 `{ kind: 'hello_ok', protocolVersion, resyncRequired, currentSeq, streamEpoch, build? }`. 토큰은 호스트가 시작될 때 생성되며, dev에서는 환경 변수로 전달된다.
- `hello_ok.build`(#280)는 호스트가 어떤 빌드이고 어디서 왔는지 말한다: `{ commit, protocolVersion, version?, bundlePath?, copyDir? }`. 키퍼 아래에서는 한 빌드의 창이 다른 빌드의 호스트에 붙을 수 있고, 클라이언트는 이것으로 안다. 커밋은 호스트 자신에 컴파일된 것이고, 나머지는 키퍼가 호스트를 복사해 온 번들의 기록이다([agent-host.ko.md](agent-host.ko.md) §4.1). 선택 필드다: 옛 호스트는 보내지 않고, 소스로 띄운 호스트는 `commit: 'dev'`를 보낸다.
- **정문** (#280 3단계). 키퍼 아래에서 클라이언트는 호스트 자신의 포트로 붙지 않는다: 키퍼의 정문 `ws://127.0.0.1:<door>`로 붙고, 정문은 바이트를 그때의 호스트로 넘긴다. 토큰은 키퍼의 것이고 키퍼가 띄우는 모든 호스트에 넘겨진다(호스트의 stdin으로, #538). 프레임은 아무것도 바뀌지 않는다: `hello`, 토큰 검사, `Origin` 규칙은 예전처럼 호스트가 한다. 호스트가 바뀌면 정문을 지나던 연결이 닫힌다. 같은 주소와 같은 토큰으로 다시 붙으면 새 호스트에 닿고, 그 `hello_ok`는 새 `streamEpoch`를 실어 클라이언트가 다시 맞춘다. 준비된 호스트가 없는 동안 연 연결은 실패하지 않고 정문에서 기다린다(최대 45초).
- **Codex 브리지의 자격 증명** (#382). `hello.token`에는 대신 한 세션의 브리지 자격 증명(`ccb1:<sessionId>:<mac>`, 토큰을 키로 한 세션 id의 HMAC; `transport/bridge-token.ts`)이 올 수 있다. Codex 브리지는 이것을 받고 시작한다. 브리지의 환경은 같은 사용자의 어떤 프로세스든 읽을 수 있기 때문이다([security-boundaries.md](security-boundaries.md), "The front door"). 그 소켓은 `hello_ok`만 받고, 재생도, 그 뒤의 이벤트도, 터미널 프레임도 받지 않는다. `orchestrator.tools`, `orchestrator.tool`, `apps.sessionTools`, `apps.sessionCall`이 아닌 RPC, 또는 `sessionId`가 자격 증명의 세션이 아닌 RPC는 실행되지 않고 `ok: false`(`internal`)로 답을 받는다. 키퍼 아래에서 키는 정문의 토큰이라서, 자격 증명은 정문 뒤의 모든 호스트에서 통한다.
- **제한 자격 증명** (#1405). `hello.token`에는 대신 제한 자격 증명(`ccl1:<mac>`, 토큰을 키로 한 레이블 `centralu limited token v1`의 HMAC; `transport/limited-token.ts`)이 올 수 있다. 창이 아닌, 그 사람 사용자의 다른 모든 프로세스(에이전트, 에이전트가 쓴 스크립트, 도구)를 위한 것이다. 이 소켓은 창처럼 클라이언트다(재생, 이벤트, 터미널 프레임). 다만 RPC마다 먼저 `transport/method-rights.ts`가 판단한다. 일상 메서드는 실행된다. 그 밖의 것(되돌릴 수 없거나 묻지 않고 실행되는 범위를 넓히는 것, 그 사람 자신의 답, 허브의 `host.*` 호출, 브리지의 통로, 모르는 이름)은 실행되지 않고 `ok: false`, `code: 'internal'`, `data: { refused: 'rights', rights: 'asks' | 'window' | 'link' | 'bridge' | 'unknown' }`로 답한다. 라우터보다 먼저 판단하므로, 연결된 기기의 세션을 가리키는 호출도 중계되지 않는다. 이 소켓의 `res` 프레임은 호스트 자신의 호출에 답하지 않는다(역방향은 허브의 것이다). 핸들러의 `RpcContext.rights`는 `full` 또는 `limited`다. `asks` 호출은 호스트가 물을 수 있으면 대신 그 사람을 기다린다(#1405 3번째 조각, `host-requests.ts`): 호스트가 `host_request`(카드의 질문 전체, 메서드, 프로그램이 `hello.client`에서 스스로 밝힌 이름을 따옴표로 60자까지)를 올리고, 토큰을 가진 창이 `requests.answer { requestId, decision: 'allow' | 'deny' }`로 답하면 그 메서드 자신의 결과로 답한다. 실행되지 않고 끝나면 `ok: false`이고 `data.refused`는 `no_window`(`hello.shows: ['host_requests']`라고 말한 창이 토큰을 들고 붙어 있지 않음: 바로 거절), `too_many_requests`(8개가 기다림), `denied`, `withdrawn`(프로그램의 소켓이 닫혔거나 호스트가 멈춤), `expired`(15분), `not_done`(카드가 서 있는 동안 휴지통이 바뀌었거나, 지울 것이 없거나, 매개변수가 메서드의 스키마에 맞지 않거나, id가 이 컴퓨터에 없는 것을 가리키거나, Allow 전에 카드가 이름 붙인 대상이 바뀌었거나, 매개변수가 너무 길어 통째로 보여 줄 수 없음: 2,000자 초과. 스키마가 받지 않는 필드는 카드 전에 버려지고, 호출은 파싱된 매개변수로 실행된다) 중 하나다. 요청을 보여 주는 창이 30초 동안 없어도 `withdrawn`으로 끝난다. `trash.empty`는 지우지 못한 세션을 `failed`에 담아 답한다. `requests.list`는 다시 연결한 창을 위해 기다리는 요청을 준다. 휴지통 삭제는 오케스트레이터 자신의 휴지통 카드로 묻고 Allow 뒤에 휴지통을 다시 읽는다. 그래서 `trash.empty`는 카드가 나열한 행만 지운다. 키퍼 아래에서 키는 정문의 토큰이므로, 이 자격 증명은 정문 뒤의 모든 호스트에서 통한다. #1405 이전의 호스트는 hello에서 거절한다(4001).
- **교체를 위해 드레인하는 호스트** (#280 3단계)는 새 RPC를 거절하고, 한도(10초)가 지나도록 도는 RPC에는 `internal`과 `retryable: true`로 답한다: 거절된 호출은 돈 적이 없고, 끊긴 호출은 끝났을 수도 있다고 메시지에 적혀 있으니 호출한 쪽이 확인한 뒤 되풀이한다. 클라이언트는 모르는 코드의 프레임을 버리므로 코드는 `internal`로 둔다.
- **`hello_ok` 전에는 hello 말고 아무것도 나가지 않는다** (#82). 클라이언트는 `hello_ok`가 온 뒤에야 `connected`를 알리고 쌓아 둔 호출을 만든 순서대로 보낸다. 그 전에 온 다른 프레임은 무시한다. 열렸는데 답이 없는 소켓은 10초 뒤 버리고 다시 시도하며, 호스트는 10초 안에 올바른 hello를 보내지 않은 소켓을 닫는다(4001). #82 전에는 소켓이 열리는 순간 큐를 쏟아, 거절된 핸드셰이크가 호스트가 실행한 적 없는 호출을 "연결이 끊김, 호스트에 닿았을 수 있음"으로 만들었다.
- 방향에 따라 두 종류: **RPC**(요청/응답, UI→host)와 **이벤트 스트림**(host→UI, 단방향 푸시).
- **역방향** (#550, [plans/remote-hub.md](plans/remote-hub.md) §12.7). 호스트는 자기에게 링크된 허브를, 허브가 연 소켓으로 부를 수 있다: 호스트가 보내는 `rpc` 프레임이고, 허브는 같은 id로 `{ kind: 'res', id, ok, result?, error? }`를 답한다. 호스트는 그것을 답한다고 말한 허브의 소켓(`host.hubOffer`)에만 보내고, 그 소켓으로 자기가 보낸 호출의 답만 읽는다. 호출은 `call.cancel { id }` 역방향 호출로 거둬들이고, 소켓이 사라지면 실패한다. 허브는 자기 링크가 받은 처리기(허용 목록)로만, 한 번에 16개까지 답하고, 그렇지 않으면 이전의 모든 빌드처럼 버린다. 그 이전의 호스트는 클라이언트의 `res`에 "Unknown frame"으로 답한다. 창은 이것을 받지 않는다.

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
- **버퍼는 개수뿐 아니라 크기로도 묶인다** (#392). 최근 이벤트 2,000개를 들되, 직렬화한 크기가 아래의 재생 예산을 넘으면 오래된 것부터 더 일찍 버린다: 이미지 이벤트는 base64 이미지를 통째로 실어, 2,000개면 수백 MB를 붙잡을 수 있었다. 예산을 넘는 부분은 어차피 재생될 수 없으므로 클라이언트가 보는 것은 같다: 밀려난 커서는 어느 쪽이든 재동기화를 받는다. 가장 새 이벤트는 아무리 커도 남는다.
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
  | { type: 'compaction';       sessionId, failed, reason?, before?, after? }  // FR-14 마커: claude compact_boundary, codex 완료된 contextCompaction 항목 (#303); `after`가 있으면 알고 있던 context 수치를 그 값으로 옮긴다, 추정치로 (#1282)
  | { type: 'conversation_reset'; sessionId, trigger? }       // #304: 도구가 새 대화를 시작했다(Claude의 /clear). 마커이며 게이지가 비워진다
  | { type: 'notice';           sessionId, level: 'info'|'warning'|'error', text, oncePerSession?,
      from?, label?, audience?: 'you'|'centralu', summary?, items?, hint? }  // #304: 도구가 읽히길 바라는 글, 한 줄. #342: 읽기 쉽게
  // 턴 안의 진행 상황 (표시 전용, 영속되지 않는다)
  | { type: 'activity';         sessionId, activity|null }      // 압축 중 / 리뷰 중 / 재시도 중 (codex 재연결, claude api_retry)
  | { type: 'plan_update';      sessionId, steps: {text, status}[] }  // #58: codex turn/plan/updated, claude TodoWrite 또는 작업 목록 (#843) 스냅샷
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
  | { type: 'usage_update';     sessionId, tokens: TokenUsage, request?: RequestInput }  // request: 모델 요청 하나의 입력, 프롬프트 캐시용 (agent-host.ko.md §6.1)
  | { type: 'context_update';   sessionId, used, window, exactness: 'exact'|'estimate' }
  | { type: 'limit_reached';    sessionId, resumeAt?, usedPercent?, windowMins? }
  | { type: 'session_title';    sessionId, title, auto }        // auto=false: 사람이 지은 이름 — 자동 이름이 덮지 않는다
  | { type: 'settings_changed'; sessionId, model, effort, verbosity, serviceTier?, permissionPreset?, by?, person? }  // #30: 사람 아닌 손이 설정을 바꿨다. by 'tool': 에이전트 도구가 스스로 바꿨다 (#304). person: 클라이언트가 agents.updateSettings를 불렀다 (#659)
  | { type: 'files_touched';    sessionId, paths: string[] }    // FR-2 충돌 감지, FR-5 하이라이트. 변경이 실제로 반영된 뒤에만 (#843)
  | { type: 'goal';             sessionId, goal: SessionGoal|null }  // 배지; codex는 알려 주고, claude는 CLI의 /goal 답과 Stop 훅 피드백에서 읽는다
  | { type: 'background_tasks'; sessionId, live: BackgroundTask[], ended?: BackgroundTask[], clearEnded? }  // #290: 살아 있는 집합(REPLACE)과 방금 끝난 것
  | { type: 'agent_version';    sessionId, version }            // #297: 이 프로세스가 돌리는 CLI 버전, 프로세스마다 한 번. SessionInfo.agentVersion으로 남는다
  | { type: 'session_live';     sessionId, live, reason? }      // #568: 세션이 잠들어 프로세스가 끝났거나(reason 'asleep'), 재개가 다시 띄웠다
  | { type: 'interruption';     sessionId, interruption: Interruption|null }  // #698: 마지막 턴이 끝까지 가지 못한 이유(network, quit, interrupted, reconnecting). SessionInfo.interruption으로 남는다
  | { type: 'history_synced';   sessionId, added }              // 밖에서 이어간 대화를 따라잡았다
  | { type: 'session_deleted';  sessionId }
  | { type: 'session_owner';    sessionId, askedBy|null, parentSessionId|null }  // #693: 인계가 이 자식을 넘겨받은 세션으로 옮겼다(원래 세션이 없어지면 정리된 자식도, #738). 사이드바는 그 아래에 둔다. #1038: 허브가 연결된 기계의 자식을 띄운 자기 세션을 알릴 때도(그 세션이 없어지면 null)
  // 앱 스코프 (sessionId optional — 모든 사실이 대화의 소유물은 아니다)
  | { type: 'update_status';    status: UpdateStatus }          // #43; autoApply (#352)는 기본값 false
  | { type: 'mail_changed';     threadId, toPerson? }          // #1347: 메일함의 스레드가 바뀌었다. Inbox가 다시 읽는다. 앱 전체 이벤트이며 연결된 기계에서 오면 넘기지 않는다
  | { type: 'agent_versions';   status: AgentVersions }         // #297: { installed: {tool: version|null}, autoApply (기본값 true), checkedAt }
  | { type: 'fs_changed';       projectId, dirs: string[] }     // #34
  | { type: 'themes_changed' }                                // #312: <data>/themes의 파일이 바뀌었다 — themes.list를 다시 읽는다
  | { type: 'orchestrator_proposals_changed' }                // #703: MCP 서버나 스킬 제안이 저장됐거나 승인·거절됐다 — agents.mcpProposals와 agents.skillProposals를 다시 읽는다
  | { type: 'machine_status';   machine: MachineInfo }          // #82: 링크된 기기의 링크 상태가 바뀌었다. 기록 전체 (§6)
  | { type: 'machine_resync';   machineId }                     // #82: 그 기기의 세션과 프로젝트를 다시 읽고, 죽은 것을 깨운다 (§6)
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

`ToolSummary.readOnly`는 이제 채우지도 읽지도 않는다([#428](https://github.com/ijun17/centralu/issues/428)). 읽기 전용
도구의 카드를 접으라는 힌트였지만, 이제 모든 카드가 접히고, 화면은 이 값을 읽지 않았으며, 두 어댑터의 추측은 서로
어긋나 있었다(Codex는 `git push`를 포함한 모든 `git` 명령을 읽기 전용으로 봤다). 예전 빌드의 이벤트와 저장된 기록이 계속
읽히도록 필드는 스키마에 선택 항목으로 남는다. 읽는 쪽은 이 값에 기대면 안 된다.

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

**에이전트 도구가 자기 사용자에게 하는 말은 대화에 한 줄로 닿는다** ([#304](https://github.com/ijun17/centralu/issues/304)).
#58 조사에서 도구가 하는 말을 Centralu가 버리고 있었다는 것이 드러났다. Claude의 `/clear`는 새 대화를 시작하는데 화면은
그대로 이어졌고, 훅이 프롬프트를 막으면 이유 한 마디 없이 답이 오지 않았고, Codex의 설정 경고는 아무에게도 닿지 않았다.
세 가지 모양이 이것을 나른다.

- `conversation_reset`은 마커이며 `compaction`처럼 저장된다. 기록은 그 위의 모든 것을 갖고 있지만 모델은 아무것도 모른다.
  호스트와 UI는 컨텍스트 게이지를 비우고, 도구는 명령의 턴이 끝날 때 새 값을 알려 준다.
- `notice`도 마커이며 도구 자신의 말(`text`)을 그대로 싣고, 도구의 긴급도는 `level`로 접힌다(더 새 호스트가 만든 모르는
  단어는 `info`로 읽는다). `oncePerSession`은 도구가 시작할 때마다 되풀이하는 글을 표시한다. 호스트는 그 세션에 같은 글의
  알림이 아직 저장돼 있지 않을 때만 저장하고 보낸다. Codex는 app-server가 시작할 때마다, 스레드를 시작하거나 재개할
  때마다 설정 경고를 두 번씩(`configWarning`, 이어서 `warning`) 보낸다.
- 알림은 **누가 말하는지와 어떤 종류인지**(`from`, `label`: "Codex · config warning"), **누가 움직여야 하는지**(`audience`:
  사람 자신의 설정이면 `you`, Centralu가 도구를 쓰는 방식이면 `centralu`, 호스트가 가릴 수 없으면 없음)도 말하고, 호스트가 아는
  알림이면 쉬운 설명(`summary`, 한 줄에 하나씩인 `items`, `hint`)을 먼저 보이고 `text`는 한 번 눌러 펼친다(#342). 여섯 모두
  선택이다. #342 이전에 저장된 알림이나 호스트가 가리지 못한 알림은 `text`만으로 그린다. 모르는 `audience` 단어는 없음으로 읽는다.
- `by: 'tool'`인 `settings_changed`는 도구가 스스로 바꾼 것이다 — Claude Code의 거절 폴백, 다른 Codex 클라이언트가 스레드를
  바꾼 경우. 대화의 알림이 무엇이 왜 바뀌었는지 말하고, 이벤트는 표시된 모델을 갱신한다.
- 저장된 `agents.updateSettings`는 모두 전체 스냅숏(`permissionPreset` 포함)을 실은 `settings_changed`로 방송된다(#659). 부른 쪽은
  응답도 받지만, 다른 창과 연결된 기계, 에이전트가 불렀을 때의 사람 창은 이 이벤트로만 새 값을 안다. `person: true`는 클라이언트의
  호출을 뜻하며 "Orchestrator changed" 토스트 없이 표시된 값만 갱신한다(`by`의 새 단어가 아니라 플래그다: 그 단어를 모르는 빌드는
  프레임을 해석하지 못해 통째로 버린다). 오케스트레이터의 호출은 연결된 기계에도 RPC에 `by: 'orchestrator'`를 실어 보내고, 변경은
  오케스트레이터의 것으로 방송되므로 토스트가 남는다.
- RPC로 저장한 프로젝트별 설정은 `projects_changed`로 알린다(#719): `projects.setTrusted`, `projects.setCommands`,
  `projects.setWorktreeSetup`, `projects.setAgentInstructions`(#1161), `worktrees.setTrunk`, 그리고 세션이 기록하는 기본 도구와 도구별 모델·노력. 모든 창이 프로젝트 목록을
  다시 읽어 이 필드들은 호스트의 값을 받으므로(목록의 행은 자리와 `git`을 그대로 둔다) ⋯ 메뉴, 신뢰 표시, 프로젝트의 앱이 호스트와
  일치한다. 허브는 연결된 머신의 이 이벤트를 전달한다. 저장된 값이 바뀐 경우에만 보내며, 창은 자기 쓰기가 진행 중인 프로젝트는 건드리지 않고 끝난 뒤 다시 읽고, 목록은 한 번에 하나씩 읽는다.

| 결정 | 이유 |
|---|---|
| 알림은 저장되는 마커이지 살아 있는 토스트가 아니다 | 알림이 올 때 사람이 보고 있지 않을 수 있고, 턴에 답이 오지 않은 이유는 돌아왔을 때도 거기 있어야 한다. 토스트는 사람에게 아무것도 요구하지 않는 일로 끼어들기도 한다 |
| 도구의 문장 그대로 | 오류 마커와 같은 규칙: 고쳐 쓰면 원인이 사라진다 |
| …호스트가 아는 알림에는 쉬운 설명을 먼저 (#342) | 오너는 `config.toml` 경고와 Centralu에게 하는 지원 중단 알림을 위아래로 보았고, 둘이 같은 종류의 문제로 읽혔다. 설명은 누구의 일인지 말하고, 도구의 말은 펼치면 보이므로 잃는 것이 없다 |
| 설명은 호스트가 쓰고 화면은 그리기만 한다 | 알림을 알아보려면 도구의 문구를 알아야 하고, 그것은 어댑터의 지식이다(`adapters/codex/notices.ts`). UI는 도구를 모르는 채로 남고, 저장된 알림은 나중의 어떤 창에서도 똑같이 읽힌다 |
| Centralu에게 하는 알림도 대화에 남기고 `for Centralu`로 표시한다 | host.log로 보내는 대신 오너가 정했다(#342, 2026-10-05): 사람은 도구가 한 말을 보고, 표시가 그것을 고쳐야 할 문제로 보이지 않게 한다 |
| `oncePerSession`은 호스트가 저장소를 보고 정한다 | 되풀이는 프로세스 수명을 넘나든다(Codex 세션은 깨어날 때마다 되풀이한다). 그 사이를 기억하는 것은 저장소뿐이다 |
| `by: 'tool'` 전환은 적용하지 않고 기록한다 | 프로세스는 이미 새 값으로 돈다. 호스트는 자신이 띄운 값과 다른 필드만 받아들이고, 띄운 기록을 함께 옮겨(아직 할 변경으로 읽히지 않게) 사람이 턴 도중 저장한 선택은 지키며, 프로젝트가 기억하는 기본값은 건드리지 않는다. `by`가 없으면 예전처럼 오케스트레이터를 뜻한다 |
| 시작 중인 세션이 보낸 이벤트는 등록될 때까지 붙잡아 둔다 | 새 세션은 어댑터가 답한 뒤에야 등록되는데, Codex의 `configWarning`은 `thread/start`가 답해지는 동안 도착한다(측정). 예전에는 번호 없이 저장되지 않은 채 나갔다 |

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
  timer?: boolean          // 도구가 쥐고 있는 타이머(Claude의 /loop, 예약 프롬프트)이지 작업이 아니다. 보고를 붙잡아 두지 않는다 (#721)
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
  | { kind: 'command';   command: string; cwd: string;
      reason?: string; network?: { host: string; protocol: string };  // #683: kept from the request,
      stdin?: boolean; unsandboxed?: boolean }                         // said on the card
  | { kind: 'file_edit'; path: string; diffPreview: string; multi: boolean;
      change?: 'add' | 'update' | 'delete' | 'move'; movePath?: string }
  | { kind: 'other';     raw: string }                                 // always "needs review"
```

판단 로직(core/approval)은 `kind`만으로 결정한다 — UI가 도구별 raw 포맷을 알 필요가 없도록 anti-corruption이 작동하는 실전 사례다.

## 3. RPC 메서드 (요약)

| 그룹 | 메서드 | 비고 |
|---|---|---|
| agents | `createSession, send, respondApproval, interrupt, resumeSession, deleteSession` | product spec §6.2. `deleteSession`은 세션을 세션 보관함으로 보낸다 (FR-22). 사람에게는 "Archive session…"으로 보인다 |
| 백그라운드 작업 | `agents.stopBackgroundTask, agents.clearBackgroundTasks` | #290: 어댑터가 `stoppable`로 표시한 작업 하나를 멈춘다(그 끝은 `background_tasks`로 온다). 끝난 것을 목록에서 걷는다 |
| 에이전트 CLI 버전 | `agents.versions, agents.setAutoApplyVersions, agents.applyVersions` | #297: 설치된 CLI(`force: false`는 30초 안의 읽기로 답한다 — 창이 포커스를 얻을 때), "새로 설치된 에이전트 CLI로 idle 세션 옮기기"(기본 켜짐), 오래된 CLI를 돌리는 idle 세션을 모두 다시 띄우고 `{ restarted, busy }`로 답한다. 세션이 돌리는 버전은 `SessionInfo.agentVersion`이며 프로세스가 없으면 null이다. 모두 덧붙임이다: 오래된 호스트에 붙은 창은 답을 받지 못하고 아무것도 보이지 않는다([agent-host.ko.md](agent-host.ko.md) §4.6) |
| 잠드는 유휴 세션 | `agents.sleepPolicy, agents.setSleepPolicy` | #568: "Put idle sessions to sleep after" `{ afterMinutes }`, 기본 15, null은 끄기. 호스트가 재운 세션은 `session_live`(`live: false, reason: 'asleep'`)를 보내고, 모든 재개는 `live: true`를 보낸다. 덧붙임이다: 오래된 호스트에 붙은 창은 답을 받지 못하고 설정을 숨긴다([agent-host.ko.md](agent-host.ko.md) §4.6.1) |
| 메일함 | `mail.list, mail.thread, mail.reply, mail.close, mail.reassign, mail.unblock, mail.held, mail.resume, mail.wake` | #1347 ([plans/mailbox.md](plans/mailbox.md) §10.1): 메일함의 사람 쪽. `mail.list`는 `{ threads, held, waiting }`을 답한다(사람이 들어 있는 스레드, 안 읽은 것 먼저. 사람이 처리해야 해서 붙들린 메일과 그 까닭. "깨우기 / 두기"를 기다리는 잠든 세션). `mail.thread { threadId, after?, all? }`는 스레드 하나를 사람이 마지막으로 읽은 곳부터 최대 100통 주고 사람이 읽은 것으로 표시한다(`more`는 뒤에 더 있다는 뜻). `mail.reply`, `mail.close`, `mail.reassign { threadId, sessionId, text }`, `mail.unblock`은 사람의 행동이고, 사람의 말은 호출이 적은 필드가 아니라 호스트가 아는 요청자로 사람의 말이 된다. `mail.held { action: 'release' \| 'dismiss', recipient, messageIds }`는 붙든 메일을 지금 보내거나 그만둔다. `mail.resume { sessionId } \| { threadId }`는 세션의 예산이나 스레드의 턴 수로 건 멈춤을 푼다(§7.9). `mail.wake { wake }`는 잠든 세션 무리에 답한다. 규칙이 거절하면 오류 `refused`와 `data.reason`이다(§5). 허브 자신의 메일함이며 넘기지 않는다. 추가만: 옛 호스트는 "Unknown method"를 답하고 창은 메일을 보여주지 않는다 |
| trash | `trash.list, trash.read, trash.restore, trash.purge, trash.empty, trash.readRun, trash.purgeRuns` | 세션 보관함의 메서드이자 거기서 나오는 길 (FR-22): 목록, 읽기, 되돌리기, 영영 지우기, 보관한 세션 모두 지우기. 보관함은 #1404 전까지 휴지통이라 불렀고, 프로토콜은 늘기만 하므로 메서드 이름은 `trash.`로 남는다. 사람만 쓴다 — 에이전트의 도구와 앱의 능력은 닿지 않는다. `trash.list`는 지운 앱 에이전트 세션의 기록(`runs`, #378)도 싣고, 그 기록은 그 앱이 돈 기계에서(`machine`, 보관함의 세션처럼) `trash.readRun`으로 읽고 `trash.purgeRuns`로 지운다. `trash.empty`는 기록을 창에 맡긴다 |
| subagent steps | `subagents.usage, subagents.trash, trash.restoreSubagentSteps, trash.purgeSubagentSteps, messages.subagentTrashed` | #418: 살아 있는 세션마다 서브에이전트 단계가 차지하는 것(`{ sessions: SubagentStepsHeld[] }`: 실행, 단계, 바이트, 큰 것부터); 세션은 두고 한 세션의 단계를 세션 보관함으로 옮기기(옮긴 `{ steps, bytes }`를 답한다); 되돌리기, 영구 삭제. 보관함에서는 `trash.list`의 `subagentSteps`(`TrashedSubagentSteps[]`)이고, 바이트는 합계에 든다. `trash.empty`는 실행 기록(#378)처럼 건드리지 않는다: 창이 보여 준 항목마다 `trash.purgeSubagentSteps { sessionId, upTo }`로 지우고, `upTo`는 창이 보여 준 `deletedAt`이라 창이 보관함을 읽은 뒤에 옮겨진 단계는 남는다. `messages.subagentTrashed { sessionId, parentCallId }`는 띄운 카드 하나의 단계 중 몇 개가 보관함에 있는지 `{ steps }`로 답해서, 카드가 단계가 어디로 갔는지 말한다. 보관함의 나머지처럼 사람만 쓴다. 덧붙임: 옛 호스트의 창은 답을 받지 못하고 아무것도 보이지 않는다 |
| messages | `messages.load, messages.subagent, messages.search, messages.image` | 기록 한 페이지; 띄운 카드 하나의 서브에이전트 걸음, 사람이 펼칠 때 읽는다 (#222); 오간 말의 검색; 답장이 적은 로컬 이미지(`![a](/path/shot.png)`). 창은 파일 경로를 직접 읽을 수 없어 세션의 호스트가 읽는다: `{ sessionId, path }`, `path`는 답장에 적힌 그대로. 답은 `{ ok: true, mime, data, file? }` 또는 `{ ok: false, reason, message, file? }`. `reason`은 `not_mentioned`(이 세션의 어느 답장에도 없다. 아무것도 건드리지 않는다), `not_found`, `not_an_image`(바이트로 판단: PNG, JPEG, GIF, WebP만), `too_large`(`IMAGE_PREVIEW_MAX_BYTES`, 10 MB), `unreadable`. `file`은 호스트 기기에서 해석한 경로로, 파일 관리자에서 보여 줄 때 쓴다. 거절은 오류가 아니라 답이다. 추가만 한 것이라 이전 호스트는 "Unknown method"로 답하고, 창은 그것을 이미지 자리에 보인다([security-boundaries.md](security-boundaries.md), "Images a reply names") |
| machines | `machines.list, machines.add, machines.remove, machines.reconnect, machines.disconnect, machines.setAutoReconnect, machines.setConnect, machines.need, machines.acceptVersions, machines.setAsks, machines.askConsents, machines.withdrawAsk` | #82: 허브가 다른 기기에 거는 링크 (§6). `machines.disconnect`(#1134, 추가만): 연결 해제 없이 링크를 닫는다. `machines.setAutoReconnect { machineId, autoReconnect }`(#1341, 추가만): 기기의 자동 재연결 스위치. `machines.setConnect`와 `machines.need`(#1134)는 한 릴리스 동안 남아 이전 창이 실패하지 않는다: `setConnect`는 `at_start`를 스위치 켬, `when_needed`를 끔으로 옮기고, `need`는 행을 답할 뿐 아무것도 하지 않는다. `machines.setAsks`, `machines.askConsents`, `machines.withdrawAsk` (#550, 추가): 기기의 세션이 이 컴퓨터의 프로젝트에 물어도 되게 하는 스위치와, 그 카드에서 허락한 쌍([plans/remote-hub.md](plans/remote-hub.md) §12.7). 상대 기기는 `host.hubOffer`로 이 허브를 알게 된다. 언제나 허브 자신의 것이고 전달되지 않는다 |
| host | `host.stop` | #82: 이 호스트를 시그널처럼 끝낸다. 먼저 답한다. `centralu serve --stop`용([agent-host.md](agent-host.md) §4.7)이고, 앱이 돌리는 호스트는 거절한다. 전달되지 않는다. 추가만 |
| requests | `requests.list`, `requests.answer` | #1405: 제한 자격 증명의 호출 중 그 사람을 기다리는 것(`HostRequest`, 이벤트 `host_request`와 `host_request_resolved`). `answer { requestId, decision: 'allow' | 'deny' }`는 토큰을 가진 창만 부른다. 요청이 더는 기다리지 않으면 `{ ok: false }`. 이 호스트 자신의 것이라 넘기지 않는다: 연결된 기기의 제한 호출자는 그 기기에서 거절된다. 그곳에는 그 카드를 보여 줄 창이 없기 때문이다. 추가만 |
| grid | `grid.get, grid.set` | 그리드의 패널들, 순서대로, 통째로 쓴다 (product spec §5.4). 하나하나가 `GridPanel`이다: `{ kind: 'session', sessionId }` 또는 `{ kind: 'app', projectId: string \| null, appId, span? }` (`null`은 사용자 폴더의 앱) — #288. `span`(#306)은 사람이 그 앱 패널의 머리글에서 고른 `{ cols, rows }`이고, 각 1에서 4, 고르지 않았으면 없다; 그 이전의 host는 이것을 걷어 내고 패널은 기본값으로 돌아간다. 바꾸지 않고 넓혔으므로 (§4) `PROTOCOL_VERSION`은 1 그대로다: `grid.get { tagged: true }`와 `grid.set { panels }`는 패널로 말하고, 그것이 없으면 둘 다 #288 이전의 모양, 세션 id만의 목록으로 말한다 (이전 UI의 `grid.set { sessionIds }`는 목록을 그 세션들로 바꾼다). UI는 `panels` 옆에 `sessionIds`도 보내고 id만의 목록을 세션 패널로 읽으므로, 한 빌드 차이의 UI와 host는 어느 쪽으로든 계속 함께 돈다; 이전 필드는 한 릴리스 뒤에 빠진다. `grid.set`은 최대 256개를 받고 저장한 것을 돌려준다: 중복, 모르는 세션, 등록되지 않은 프로젝트의 앱은 빠진다. 앱이 있는지는 확인하지 않는다 — 앱 목록은 폴더보다 늦을 수 있고, 찾지 못한 앱은 화면이 빼고 그린다. 모양은 패널의 정체성뿐이라 그대로 클라이언트로 옮겨 갈 수 있다 (#82) |
| git | `git.status, git.diff, git.log, git.commitDetail, git.branches, git.ignoredEntries, git.checkout, git.stage, git.commit, git.push` | dev와 prod 모두 호스트의 `dev-services`가 처리한다. 이름과 달리 prod 경로다([agent-host.ko.md](agent-host.ko.md) §5) |
| fs | `fs.listDir, fs.watch, fs.readFile, fs.move, fs.importFile, fs.resolve`, `files.search` | 〃 |
| workspace | `workspace.load, workspace.save` | 창이 기억하는 배치의 스냅숏. 대화는 위의 `messages.*`로 읽고, 쓰는 것은 호스트가 직접 한다 |
| usage | `agents.usage`, `agents.account` | 계정의 한도 창, 도구 자신에게 묻는다. 호스트가 센 최근 몇 시간의 프롬프트 캐시도 함께 (`cache`, [agent-host.ko.md](agent-host.ko.md) §6, §6.1). `agents.usage { limits: false }`는 캐시만 답하고, 허브가 연결된 기기에 대해 한도가 자기 것이면 `sameAccountAsHub: true`를 단다. `agents.account { tool }`은 로그인의 불투명한 지문(`{ loggedIn, fingerprint }`)으로, 허브가 기기의 것과 견주며 이메일은 나가지 않는다 (#726). 추가만 |

git, fs, workspace RPC의 요청·응답 타입은 **포트 인터페이스와 1:1**이다. 의도된 중복이다 — 포트가 원본 계약이고, RPC가 그 계약을 실어 나른다(git이나 fs를 Rust로 옮기게 되면 Tauri invoke가 두 번째 운반체가 된다).

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

## 3.2 걷어낸 메서드와 이벤트 ([#97](https://github.com/ijun17/centralu/issues/97), [#372](https://github.com/ijun17/centralu/pull/372))

Centralu에 컴파일된 앱은 앱마다 JSON 문서 하나와 켜짐 여부를 가졌고, `apps.state`, `apps.setState`,
`apps.setEnabled`와 `app_state_changed` 이벤트가 그것을 `unknown`으로 날랐다. 그런 앱은 관제 레일 하나뿐이었고
#372에서 걷어냈다(#97에서 정했다). 그 뒤 이 넷이 프로토콜에서 빠졌고, 관제 앱의 작업만이 호스트 안에서 부르던
`agents.createCoordinator`도 함께 빠졌다. 이것들을 빼도 버전은 바뀌지 않는다(§4): 양쪽 모두 상대가 이름을 모르는
경우를 이미 견딘다.

| 걷어낸 것 | 이전 상대가 보는 것 |
|---|---|
| `apps.state`, `apps.setState`, `apps.setEnabled` | v0.1.0-beta.10 이하의 창이 더 새로운 호스트에 붙으면 호스트의 모르는 메서드 에러를 받는다(`internal`, 재시도 불가: "Unknown method: apps.state. This Centralu host does not have it; the window may be from another build."). 그 창의 레일은 실패한 읽기를 말없이 받아 빈 채로 선다. 꺼 두었던 곳에서도 켜진 채다(꺼 두었다는 것을 더는 읽지 못한다). 설정의 레일 토글은 그 메시지를 보인다. 레일의 도구는 #372의 호스트에서 이미 실패했다(`apps.invoke`가 거기서 관제 앱을 잃었다). 그 창에서 이것들을 부르는 곳은 그 밖에 없다 |
| `agents.createCoordinator` | 릴리스된 창 가운데 부른 것이 없다. 부르는 쪽이 있다면 같은 에러를 받는다 |
| `app_state_changed` | v0.1.0-beta.10 이하의 호스트는 관제 앱이 문서를 바꿀 때 아직 이것을 보낸다. 더 새로운 창은 모르는 이벤트 타입으로 버린다(§4) |

저장된 행(`app_settings`의 `app:control:*`)은 그대로 둔다. 레일이 아직 있는 릴리스가 같은 저장소를 열 수 있다.
저장소에 이미 있는 코디네이터 세션은 계속 동작하므로(목록, 읽기, 깨우기, 보관함) `coordinator`는 세션 종류로
남는다([domain-model.ko.md](domain-model.ko.md) §1.1). 사라진 것은 새로 만드는 길뿐이다. `control`은 예약된 앱
id로 남는다(`app-id.ts`의 `RESERVED_APP_IDS`). 외부 앱이 그 행들이나 그 id가 찍힌 코디네이터 세션을 물려받지 않게
하려는 것이다.

외부 앱은 상태를 자기 프로세스에 둔다([apps.ko.md](apps.ko.md)).

## 3.3 다른 빌드의 상대가 잃는 것 ([#844](https://github.com/ijun17/centralu/issues/844))

한두 빌드 떨어진 창과 호스트는 자주 만난다. 사람이 전환하기 전까지 창은 더 오래된 호스트에 붙어 있고(#280), 호스트
교체 중에는 이전 빌드가 잠시 더 서비스하며, 허브는 다른 릴리스를 돌리는 기기들을 잇는다(#692). §4의 규칙 덕분에
추가는 대부분 공짜다. 아래는 그래도 이전 상대가 무언가를 잃는 경우이고, 섞인 환경에서 온 보고를 맞춰 읽을 수 있도록
각각이 들어온 빌드를 함께 적는다.

**승인 카드.** `approval_request`는 이벤트이고, 파싱되지 않는 이벤트는 통째로 버려진다. #844부터 창이 읽지 못하는
카드(모르는 종류이거나, 아는 종류인데 모르는 단어가 든 카드)는 대신 `other` 카드로 읽힌다(`ApprovalDetail`의 대체값,
`about: 'unknown_card'`). 먼저 대체 카드라는 것과 그 종류(아는 종류라면 읽지 못한 값)를 말하고, 이어서 카드가
가리키는 프로젝트·앱·기기, 그다음 카드 자신의 글을 따옴표에 넣어 확인하지 않은 것으로 표시하며(대개 요청한 에이전트의
말이다), 마지막에 이유를 한 줄 적는다. 허용과 거부만 제시한다. "항상"은 사람이 끝까지 읽지 못한 질문을 기억하게 되기
때문이다. 답은 카드를 띄운 호스트가 그 카드 종류의 규칙대로 적용한다. 허브는 링크된 기기의 카드를 이렇게 읽었으면
그 카드에 대한 "항상"을 거절한다(`unreadCard`). 그 허브에 붙은 #844 이전의 창은 여전히 "항상"을 제시하기 때문이다. #844 이전의 창은 그런 카드를 여전히 버리고, 그 세션은 호스트와
같은 빌드의 창이 답할 때까지 화면에 카드 없이 기다린다:

| 카드 | 처음 들어온 빌드 | 그 이전의 창 |
|---|---|---|
| `project_create` (#515) | beta.16 | 카드를 버린다 |
| `agent_start` (#561) | beta.17 | 카드를 버린다 |
| `centralu_update` (#581) | beta.18 | 카드를 버린다 |
| 설정의 동의 목록에 든, 기억된 `agents` 동의(#561) | beta.17 | 무엇을 허용하는지 말하지 않고 나열한다 |
| 적용 카드(#665)와 인계 카드(#694) | beta.23, beta.25 | `other`에 실려 오므로 읽는다 |

그래서 릴리스된 창에 닿아야 하는 새 카드 종류는 적용·인계 카드처럼 `other`에 `about`을 붙여 질문 전체를 `raw`에
담는다. 독립된 종류는 일반 카드가 대신 서도 되는 카드에만 쓴다.

**이벤트에 실린 단어.** 이벤트에 실린 enum은 대체값이 없으면, 더 새로운 호스트가 그것을 넓혔을 때 이벤트를
버리게 만든다. 대체값이 있는 것: 알림의 `level`과 `audience`(#304, #342), 중단의 `reason`(#698), 백그라운드 작업의
`kind`(#290), 업데이트 `phase`(#844, `updating`으로 읽고 호스트의 `error` 문구를 보인다). beta.18 이전의 창은 호스트가
npm을 기다리는 동안(`waiting_for_npm`) 오는 `update_status`를 모두 버리고, 업데이트 줄은 그 전 상태에 머문다.

**이전 창이 버리는 이벤트 타입** (§4). 깨지는 것은 없다. 창은 같은 내용을 다른 길로 읽을 때까지 그 이벤트가 알리는
것을 놓친다:

| 이벤트 | 처음 들어온 빌드 | 그 이전의 창 |
|---|---|---|
| `projects_changed` | beta.16 | 다른 창이나 에이전트가 더하거나 뺀 프로젝트를 다음에 새로 읽을 때 본다 |
| `session_live` | beta.18 | 세션이 잠들고 깨는 것(#568)을 보지 못한다. 다음에 목록을 읽을 때 반영된다 |
| `update_apply_request`, `update_apply_go` | beta.23 | 에이전트의 적용 카드가 보낸 요청(#665)에 답하지 않는다. 5초 뒤 에이전트의 호출은 "No Centralu window answered"로 끝나고, 사람에게 업데이트 줄의 Apply now를 누르라고 부탁하게 한다 |
| `interruption`, `session_owner`, `orchestrator_proposals_changed` | beta.24 | 중단 줄(#698)을 보이지 않고, 목록을 다시 읽기 전까지 옮겨 간 자식을 이전 주인 밑에 두고 오케스트레이터의 제안을 새로 고치지 않는다 |

**이전 호스트가 떼어 내는 필드.** 더 새로운 창이 보낸 필드를 이전 호스트가 선언하지 않았으면 거기에서 버려진다(§4).
그 때문에 일어나는 일이 달라지는 경우:

- `createSession`의 `handoff.removesOriginal`(#738, beta.25). 그 이전의 호스트는 이전 세션의 살아 있는 자식만 후속
  세션에 옮기고(#693, beta.24. 그 전에는 하나도 옮기지 않는다), 창이 이어서 이전 세션을 지워도 끝난 자식은 옮기지
  않는다. 끝난 자식은 보관함에 든 이전 세션에 남고, 그 세션을 복원하면 함께 돌아온다.

**뜻이 옮겨 간 필드.** `SessionInfo.askedBy`는 다른 프로젝트에서 이 세션을 요청한 세션(ask_project, #371)을
가리켰다. #561 part 3와 #614 이후로는 자기 프로젝트에서 이 세션을 시작한 세션(start_agent)만 가리키고, 저장소 단계
v48은 예전 워크트리 매니저의 세션들에 `parent_session_id`를 이 칸으로 복사했다. beta.20 이하의 창은 start_agent 자식을
부모가 "요청한" 세션으로 보이는데, 지금은 그것이 이 칸의 뜻이다. beta.20 이하의 호스트는 아직 프로젝트 사이의 뜻으로
이 칸을 쓴다. 더 새로운 호스트는 그런 행을 한 번 비우고(저장소 단계 v55, [agent-host.ko.md](agent-host.ko.md) §5.1),
그 뒤에 그런 호스트가 쓴 행은 그 호스트가 보이던 대로 표시를 지닌다.

## 4. 스키마와 버전 규칙 (C6 방어)

- 모든 메시지는 zod 스키마로 정의되고 **경계에서만** 검증된다 (수신 시 1회. 내부 재검증은 금지 — 성능).
- **wire에 오가는 모양은 여기에서 한 번만 선언한다.** 호스트와 플랫폼은 그것을 다시 적지 않고 `import type`으로 가져온다(호출자가 예전 로컬 이름을 쓰면 그 이름으로 다시 내보낸다). 사본은 어긋났다(#428): `sessionName`이 빠진 호스트의 `GitCommit`, `sentAt`이 빠진 오류 묶음이 그 예다. 결과 모양은 메서드 안에 그대로 적지 않고 이름을 붙여서(`FsEntry`, `FsFile`) 양쪽이 그 이름을 쓸 수 있게 한다. 겉모양만 비슷한 호스트 타입에는 따로 이름을 붙인다(`ProjectConsent` 옆의 `ConsentRow`, `SessionActivity` 옆의 `IdleActivity`, `HostBuild` 옆의 셸 타입 `ShellHostBuild`).
- `protocolVersion`은 단일 정수다. 호환 규칙:
  - **추가는 자유다** (새 이벤트 타입, 새 optional 필드) — 버전이 바뀌지 않는다.
  - 수신자는 **모르는 이벤트 타입과 필드를 반드시 무시해야 한다** (평범한 zod 객체는 선언하지 않은 필드를 버리고, 모르는 타입의 이벤트는 통째로 버려진다).
  - **이벤트에 실린 단어나 모양은 누군가 그것을 넓히기 전에 대체값을 가진다** (#844). 이벤트는 통째로 파싱되므로, 그 안에서 이 빌드가 읽지 못하는 값(enum의 새 단어, 승인 카드의 새 종류) 하나가 그 값만이 아니라 이벤트 전체를 버리게 만든다. 그래서 이벤트에 실린 enum은 가장 가까운 정직한 단어로 가는 `.catch()`를 가지고(`level`은 `info`로, 업데이트 `phase`는 `updating`으로), 이 빌드가 읽지 못하는 승인 카드는 그렇다고 말하는 `other` 카드가 된다(§3.3). 대체값이 생기기 전에 릴리스된 창은 여전히 그 이벤트를 버리므로, 그런 변경이 그 창에서 무엇을 잃게 하는지 §3.3에 적는다.
  - **호스트 페이로드에 추가하는 필드는 기본값을 가져야 하고, 클라이언트가 그 기본값을 적용한다** (#280, #337). 두 절반이 하나의 규칙이다. 키퍼 아래에서는 사람이 전환하기 전까지 창이 더 오래된 빌드의 호스트에 붙어 있을 수 있으므로, 첫 릴리스 이후 추가된 필드는 호스트가 보내는 것에서 빠져 있을 수 있다. `.default()`만으로는 소용이 없다. 창의 타입은 파서의 출력이라 코드는 그 필드가 언제나 있다고 읽는데, 그것은 페이로드가 스키마를 거쳤을 때만 참이다. 이벤트는 언제나 거쳤다(`parseServerFrame`). RPC 결과는 엔벨로프에서 `unknown`이었고 보낸 그대로 화면에 닿았으며, beta.7 호스트에 붙은 beta.9 창이 `backgroundTasks`(#305) 없는 세션 목록에서 크래시했다. 그래서 새 필드는 optional이거나(그리고 모든 독자가 부재를 처리하거나) 기본값을 가진다. 기본값 없는 필수 필드는 버전 증가와 함께만 올 수 있다.
  - **클라이언트는 모든 RPC 결과를 그 메서드의 결과 스키마로, 도착하는 곳에서 한 번 읽는다** (`RpcClient`, `parseRpcResult`). 호스트가 모든 RPC의 params를 읽는 것과 같다. 읽기는 관대하다(`parseTolerant`): 전체 파싱이 실패하면 결과를 필드별·원소별로 다시 읽고, 그래도 혼자 실패하는 값은 온 그대로 둔다. 그래서 더 새로운 호스트의 enum에는 있고 이 빌드에는 없는 단어 하나는 그 값 하나만 잃게 하지, 목록 전체를 잃게 하지 않는다. Node에서 잰 값: 세션 200개 목록 0.33 ms, 200행 기록 페이지 0.03 ms. 이 규칙을 지키는 테스트(`e2e/older-host.spec.ts`)는 실제 UI를 실제 호스트에 붙이고, 모든 결과·이벤트·핸드셰이크에서 기본값 있는 필드를 전부 뺀다(`withoutDefaultedFields`).
  - 필드 삭제나 의미 변경 = 버전 증가 = 핸드셰이크에서 거부. **가능한 한 피한다** — 새 필드를 추가하고 옛 필드를 한 마일스톤 동안 유지하는 편이 언제나 더 싸다.
  - **메서드나 이벤트 타입 하나를 통째로 빼는 것은 버전 증가 없이 할 수 있다**. 위의 규칙들이 이미 그 부재를 견딜 수 있게 만들기 때문이다: 호스트에 없는 메서드를 부른 클라이언트는 모르는 메서드 에러(`internal`, 재시도 불가)를 받는데, 모든 호출자는 호스트보다 나중에 생긴 메서드(오래된 호스트의 `agents.versions`, §3) 때문에 어차피 이것을 처리해야 한다. 수신자는 모르는 이벤트 타입을 버린다. 하나를 빼기 전에 모든 릴리스 태그에서 그 호출자를 읽고(`git grep <이름> <태그>`) 각각이 실패를 처리하는지 확인한 다음, §3.2에 이전 상대가 보는 것과 함께 적는다. 뺀 이름은 다른 것에 다시 쓰지 않는다.
- 골든 테스트: 버전별 샘플 메시지 JSON을 픽스처로 동결하고, 스키마가 바뀌면 과거 픽스처가 여전히 파싱되는지 CI가 검증한다. 걷어낸 이벤트 타입은 픽스처에서 그 옆의 걷어낸 목록으로 옮기고, 그 목록은 그것이 버려지는지 확인한다(§3.2).

## 5. 에러 모델

```ts
type ProtocolError = {
  code: 'adapter_crashed' | 'conversation_locked' | 'tool_not_installed' | 'not_logged_in'
      | 'session_not_found' | 'rate_limited' | 'version_mismatch' | 'refused' | 'internal'
  message: string          // a human-readable explanation (must be displayable in the UI as is)
  retryable: boolean
  data?: unknown           // extra information per code (rate_limited → resumeAt etc.)
}
```

- code는 닫힌 집합이다. UI는 code로 분기하고 message는 표시만 한다. 문자열 매칭 분기는 금지다.
- **`refused`**(#1347): 호스트가 호출을 알아듣고 이름 붙일 수 있는 이유로 거절한 경우다(메일함에서 스레드가 끝났거나, 보낸 쪽이 스레드 안에 없거나, 정책이 막을 때). `retryable`은 늘 false이고, `data.reason`은 짧은 단어(`thread_done`, `not_participant`, `policy` 등)다. 장애가 아니므로 화면은 오류 보고가 아닌 거절로 보여 준다. 이 단어를 닫힌 집합에 갖지 않은 옛 창은 프레임을 검증하지 못해 같은 메시지를 단 `internal`로 호출을 끝내므로 문장은 사람에게 닿고, `data`만 잃는다.
- 어댑터의 raw 에러(SDK 예외, 프로세스 종료 코드)는 호스트 내부에서 이 형태로 변환된다.

## 6. 링크된 기기 ([#82](https://github.com/ijun17/centralu/issues/82), [plans/remote-hub.md](plans/remote-hub.md))

기기마다 호스트가 하나씩 돈다. UI가 붙은 호스트가 그 UI의 **허브**다. 허브는 사람이 추가한 다른
기기의 호스트에 링크하고(`machines.add`, 각각 사람 자신의 `ssh`로, [agent-host.ko.md](agent-host.ko.md)
§4.8), 그 세션과 프로젝트를 제 것처럼 보여 준다. UI는 여전히 호스트 하나와만 말한다. 여기의 모든 것은
추가이고 `PROTOCOL_VERSION`은 1 그대로다.

- **기기가 붙은 id.** 다른 기기가 넘겨준 id는 `<machine>.<id>`로 읽힌다: 세션, 프로젝트, 터미널
  (`<machine>.term-3`), 명령 실행, 그리고 결과와 이벤트 안의 id(`parentSessionId`,
  `worktreeManager.sessionId`, 메시지의 `from.sessionId`). 기기 id는 소문자, 숫자, 하이픈이고 글자로
  시작하므로(`MachineId`) 첫 점이 그 끝이며, 기기가 붙은 id도 세션·프로젝트 id 규칙에 맞는다. **UI는
  id를 해석하지 않는다**: 행마다 `machine` 필드가 있다(`SessionInfo`, `ProjectInfo`, `TrashedSession`,
  `ExternalAppInfo`, `ProjectConsent`, 승인 규칙). 허브 자신의 것은 없거나 null이다.
- **라우팅.** 허브는 `sessionId`, `projectId`, `terminalId`가 가리키는 기기로 호출을 보내고, 나머지는
  스스로 답한다. 기기별 질문은 선택적인 `machine` 매개변수를 받는다(없으면 허브): `agents.detect`,
  `agents.capabilities`, `agents.models`, `agents.usage`, `agents.versions`,
  `agents.setAutoApplyVersions`, `agents.applyVersions`, `agents.sleepPolicy`, `agents.setSleepPolicy`(#568),
  `projects.add`, `projects.create`,
  `projects.createPreview`(#515), `processes.strays`,
  `processes.stop`. UI가 다시 쌓는 목록(`sessions.list`, `projects.list`, `trash.list`, `subagents.usage`,
  `messages.search`, `apps.list`, `approvals.rules`, `projectConsents.list`)은 기기를 가로질러
  합친다. 닿지 않는 기기는 합친 결과에서 빠진다. `trash.list`와 `subagents.usage`는 그런 기기를 이름으로 알리고(`unreached`, #841)
  `trash.empty`는 각각을 실패로 적으므로, 어느 쪽도 보관함 전체로 읽히지 않는다. 메서드마다 한 줄인 표는 `packages/agent-host/src/links/routes.ts`이고, 프로토콜에 더한
  메서드는 거기서 분류되기 전까지 컴파일되지 않는다.
- **숫자.** 다른 기기의 승인 규칙 id는 음수로 접힌다(기기마다 구간 하나). 그 값으로 부른
  `approvals.deleteRule`은 그 기기에 닿는다. 로컬 규칙 id는 음수가 아니므로, 기기를 모르는 UI가 그
  값으로 로컬 규칙을 지울 수는 없다. 프로세스 id는 오가지 않는다: `processes.strays`와
  `processes.stop`은 같은 `machine`을 받는다.
- **1단계에서 허브에 남는 것.** 오케스트레이터와 그 도구, 저장소에 이미 있는
  코디네이터, 레이아웃, 그리드, 설정, 테마, 업데이트, 앱 가져오기, 화면 질문. 원격 기기 자신의
  오케스트레이터와 코디네이터는 목록에 없고 그 이벤트도 전달되지 않는다. `fs.resolve`(이 컴퓨터의
  OS가 쓸 경로)와 앱 화면 호출(`apps.viewFrame`, `apps.openView`, `apps.readResource`,
  `apps.invoke`, `apps.inlineReopen`, `apps.viewMessage`)은 다른 기기의 프로젝트나 세션이면 거절된다.
  화면의 주소는 그 호스트의 포트를 담고 있어서, 2단계에서 허브를 거치는 프록시로 연다.
  `messages.image`는 세션이 도는 기기에서 읽고, 허브는 그 답에서 `file`을 뺀다: 그 경로는 다른 기기의
  것이라 창은 그 파일을 보여 주겠다고 하지 않는다.
- **기기가 닿지 않을 때.** `sessions.list`와 `projects.list`는 허브의 헤더 미러로 그 기기를 대신
  답하고, 각 행에 `unreachable: true`를, `live`에는 마지막으로 들은 값을 싣는다. UI는 그 행을 지우지
  않고 깨우지도 않는다. 그 기기로 가는 호출은 바로 실패한다(§5).
- **이벤트.** 링크된 기기의 세션 이벤트는 허브 자신의 `seq`로, id에 기기를 붙여 UI에 닿는다. 원격
  호스트 자신에 관한 것(`update_status`, `themes_changed`, `app_state_changed`, `agent_versions`,
  `external_app_questions_changed`, `orchestrator_proposals_changed`, 세션 없는 `error`)은 버린다. 터미널 프레임은 기기가 붙은 터미널
  id로 온다. `machine_status`는 링크 상태가 바뀔 때마다 그 `MachineInfo` 전체를 싣는다.
  `machine_resync`는 UI가 한 기기에 대해 쥔 것을 다시 읽으라는 뜻이다. 그 링크가 (다시) 이어질
  때마다, 그리고 기기를 지울 때 온다. UI는 `sessions.list`와 `projects.list`를 다시 읽고 그 기기의
  세션에 대해서만 재연결 복구를 돌린다: live로 알던 세션이 새 목록에서 아니면(원격 호스트가 keeper
  없이 재시작했다) 깨운다.
- **`MachineInfo`.** `{ id, name, sshTarget, shell, wslDistro, command, status, error, versions,
  lastConnectedAt, localPort, sameLocalPort, hostStarted }`. `shell`은 `posix`, `powershell`, `wsl`.
  `status`는 `connecting`, `connected`, `unreachable`, `not_running`(Centralu는 답하지만 `centralu serve`가
  돌지 않고 허브가 띄우지도 못했다. `error`가 까닭), `starting`(허브가 띄우는 중. 추가만 했고, 이전 창은
  `unreachable`로 읽는다), `versions_differ`, `refused`, `disconnected`, `stopped`(#1143: 그쪽에서 사람이 Centralu를
  멈췄거나, 허브가 띄운 호스트가 거듭 멈췄다. `machines.reconnect` 전에는 허브가 띄우지 않는다. 추가만 했고, 이전 창은
  `unreachable`로 읽는다). `hostStarted`는 null, 또는 허브가 그 호스트를 띄웠을 때
  `{ how, at, note }`: `detached`는 링크보다 오래 살고, `link_bound`는 그 기기가 WMI로 프로세스 만들기를 막아 링크의
  ssh 세션에서 돌며 링크와 함께 끝난다. 추가만. `versions`는 `{ hub, remote, older, compatible, sameChannel,
  accepted }`이고 양쪽은 각각 `{ version, protocolVersion, dev }`다. 두 쪽 버전이 다르면 맞추거나
  사람이 거절할 때까지(`machines.acceptVersions`, 프로토콜이 다르면 거절된다) 링크는 이어지지 않는다.
  질문은 `older`를 가리킨다. dev 빌드에는 더 오래된 쪽이 없고, 프로토콜이 같으면 이어진다.
- **반대 방향은 꺼져 있다.** 링크는 허브가 연 클라이언트 연결이다. 프로토콜에는 호스트가
  클라이언트를 부르는 프레임이 없고, 허브는 그런 모양의 것을 버린다.

