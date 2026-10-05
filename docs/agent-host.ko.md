# Agent Host — Node 사이드카 설계

> 영어 원본: [agent-host.md](agent-host.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

독립 실행되는 Node 프로세스다. dev에서는 개발자가 직접 띄우고(`pnpm host`), 패키지된 앱에서는 키퍼(`centralu --keeper`, §4.1)가, `pnpm app:dev`에서는 Tauri 앱이 spawn하고 감시한다. **UI가 있든 없든 동일하게 동작해야 한다** — UI는 여러 번 닫혔다 다시 열릴 수 있고(재연결), 그동안 호스트는 세션을 계속 유지한다.

## 1. 내부 구조

```
agent-host/src/
├─ main.ts              # CLI(--port --token --dev-services), 기동 순서,
│                       #   그리고 도구 → 어댑터 레지스트리 (Map 리터럴. registry.ts는 없다)
├─ rpc.ts               # RPC 메서드 분배
├─ transport/
│  ├─ server.ts         # ws 서버, 핸드셰이크, RPC 라우팅
│  └─ event-log.ts      # seq 부여, 링 버퍼, afterSeq 재생 (protocol §1)
├─ adapters/
│  ├─ contract.ts       # AgentAdapter 인터페이스 + 능력 타입
│  ├─ claude/           # Claude Agent SDK 기반 (orchestrator-mcp.ts 포함)
│  └─ codex/            # app-server JSON-RPC 클라이언트 (직접 작성. stdio 다리 포함)
├─ sessions/            # 세션 수명, 오케스트레이터 도구, 앱 안내
├─ dev-services/        # git/fs/store (store는 dev 전용이 아니다 — 메시지가 사는 곳이다)
├─ log-file.ts          # stderr를 ~/.centralu/host.log로 흘린다 (stdout은 예약됨, 아래 참고)
├─ env-path.ts          # PATH 보강 — GUI 앱은 로그인 셸 PATH를 물려받지 못한다
├─ data-dir.ts          # 데이터 폴더 위치 판정과 이전
├─ idle.ts              # "사람이 잃을 것이 돌고 있는가"에 대한 유일한 규칙 (#352)
└─ updates.ts           # 업데이트 확인, 설치, "한가할 때 자동 적용"
```

사용량 파싱과 오케스트레이터의 MCP 표면은 **자기 디렉토리를 갖지 않는다**: 계정 사용량은
도구마다 다른 질문이라 `adapters/<tool>/usage.ts`에 있고, 오케스트레이터 도구는
`sessions/orchestrator-tools.ts`에 한 번 정의된 뒤 어댑터마다 다른 길로 노출된다 —
claude는 인프로세스, codex는 stdio 다리.

### 1.1 Centralu 자체 도구를 누가 받는가 (도구 프로필)

모든 세션은 `centralu` 서버 도구 묶음을 하나 받거나 아무것도 받지 않는다. 어느 묶음인지는
매니저가 정한다(`toolProfileOf`, 생성과 깨우기에서 같은 규칙). 묶음이 무엇을 노출하는지와 그
호출이 무엇을 실행할 수 있는지는 둘 다 `profileAllows`가 정하므로, 묶음에 없는 이름은 Codex
다리를 거쳐도 거절된다.

| 프로필 | 누구 | 시야 | 도구 | 지침 |
|---|---|---|---|---|
| `orchestrator` | 하나뿐인 오케스트레이터 | 모든 세션 | 매니저·빌더 전용을 뺀 전부 | 역할과 사용법 |
| `manager` | 워크트리 자식이 있거나 프로젝트의 매니저 자리인 세션 (#69, #76) | 자기 워크트리 자식 | 목록, 읽기, 보내기, 워크트리 세션 제안·삭제 | 워크트리 규칙 |
| `scoped` | 코디네이터(#80. `agents.createCoordinator`로 만든다. 예전에는 #97에서 걷어낸 관제 앱의 작업이 만들었다) | 자기 멤버 | 목록, 읽기, 보내기 | 자기 경계 |
| `builder` | 앱을 만드는 세션 (M4 C-3) | 자기 앱 | `check` | 만들고 검사하기 |
| `reader` | 프로젝트에 속한 그 밖의 모든 세션 (#320) | 자기 프로젝트, 호출할 때 읽음 | `read_session`(id 없으면 목록), `recall`, `app_guide`; `ask_project`(#371, §1.2). 그리고 `find_apps`, `attach_app`, `detach_app`(#371 A, apps.md §9.4) | 없음 |

`reader` 묶음은 읽기 전용이다. 그 도구 객체는 보내기·만들기·설정 변경을 이름으로만이 아니라
그 자체로 거절한다. 앱이 세운 에이전트 세션(M4 D-1)은 답을 앱에 돌려주므로 이 묶음을 받지
않는다. 설정 → 오케스트레이터에서 끌 수 있다(`sessionTools`, 기본 켜짐). 끄면 새 세션은 묶음을
받지 않고, 살아 있는 세션의 호출은 즉시 거절된다. 출처 판정(#90)에서 reader는 여전히 평범한
작업자다 — `directs()`는 `reader`를 뺀 프로필만 센다.

**크기가 설계 제약이다.** 모든 세션의 모든 턴에 실리기 때문이다. 실제 CLI로 쟀다(haiku, CLI
2.1.289, `scripts/probe-reader-tools.mts`; `centralu` 서버 없이 돌린 것 대비 첫 요청 입력 토큰,
claude.ai 커넥터 끔):

| 모양 | 문자 | 토큰 |
|---|---|---|
| `list_sessions`, `read_session`, `recall`, `app_guide`를 오케스트레이터 문구로 | 2,493 | +672 |
| 같은 넷, 문구만 다듬음 | 1,138 | +338 |
| 목록을 `read_session`에 합침(도구 셋, 모두 로드) | 897 | +267 |
| **출시본**: `app_guide`만 도구 검색 뒤로 미룸 | 897 | **+192** |
| 셋 다 미룸 | 897 | +28 |

로드된 도구 하나씩: `read_session` 239 → 98, `recall` 182 → 84, `app_guide` 148 → 85, 합쳐서
없어진 `list_sessions` 103 → 75. 도구 하나가 첫 단어 전에 약 55토큰(이름과 스키마 틀)을 먹으므로
다듬기보다 합치기가 이겼다. 전부 미루기는 기각했다: 예전 대화를 물어도 모델이 `recall`을 한 번도
부르지 않았다(오케스트레이터가 `send_to_session`에서 잰 것과 같은 실패이고, 그래서 그 도구들은
`alwaysLoad`다). 미룬 `app_guide`는 도구 검색으로 5번 중 4번 찾았다(로드하면 5번 중 5번). 놓친
한 번은 앱에 대한 추측 답이고, 오케스트레이터는 안내서를 로드해 둔다. Codex에는 미루기가 없어
셋 다 받는다. `orchestrator-tools.test.ts`는 직렬화한 묶음과 지침이 `READER_BUDGET_CHARS`
(1,000)를 넘으면 실패한다.

앱 붙이기 도구(#371 A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4)는 같은 서버에 자기 한도
`APP_ACCESS_BUDGET_CHARS`(900. 지금 874)로 실린다. 어느 묶음도 다른 쪽의 여유로 자라지 않게 하려는 것이다.
Claude는 셋 다 미루며, 그 값은 요청마다 +31 토큰이다(같은 측정, 2026-10-05, `ask_project`가 들어오기 전 #320 묶음에서 잼: +192에서 +223). 올려
두면 +263을 더한다. Codex 세션이 그만큼 낸다. 모델은 여전히 찾는다: 새 haiku 세션 5번 중 5번이 평범한 요청에서
도구 검색으로 `find_apps`를 찾았다(apps.md §9.4).

묶음을 받은 Codex 세션은 stdio 다리를 띄우므로, #320 이후 모든 Codex 세션이 node 프로세스를
하나 더 띄운다(유휴 시 상주 메모리 약 40 MB). 다리는 `default_tools_approval_mode: 'approve'`를
건다: 우리 도구는 Claude 쪽처럼 묻지 않으며, 이것이 없으면 auto(`approvalPolicy: never`)의
Codex가 모든 호출을 스스로 거절했다. `scripts/smoke-reader.mts`가 실제 모델로 처음부터 끝까지
돌린다(Codex는 `TOOL=codex`).

### 1.2 다른 프로젝트에 맡기기 (`ask_project`, #371 B)

평범한 세션이 자기 프로젝트 밖으로 손을 뻗는 유일한 길이다. `ask_project({ project, task })`는 등록된 다른 프로젝트에
일을 주고, 그 일을 한 세션의 답을 돌려준다 — 서브에이전트의 결과가 돌아오는 방식으로. 읽기 묶음과 함께 실리지만(같은
프로필, 같은 설정 스위치) 행동하는 도구이므로 따로 `DELEGATE_TOOLS`라는 묶음과 예산을 둔다. 오케스트레이터·매니저·리드는
받지 않는다: 그들은 이미 자기 시야 안에서 `send_to_session`으로 세션을 부린다.

한 번의 호출이 하는 일(`SessionManager.askProject`):

1. **대상.** 등록된 다른 프로젝트, 이름이나 id로. 자기 프로젝트는 거절한다("여기서 하라"). 모르는 이름은 다른 프로젝트들의
   이름과 함께 거절한다. 자신이 맡겨진 세션(`askedBy`가 있는)은 세 번째 프로젝트에 맡길 수 없다: 깊이 1이라, 서로 동의한
   두 프로젝트도 사람 없이 일을 주고받으며 돌 수 없다.
2. **동의**(`ensureProjectAccess`, 종류 `delegate`). 프로젝트 X의 세션이 Y에 처음 맡길 때, 호출한 세션의 승인 자리에 카드가
   선다(detail `project_access`): 이번만 허용, 이 쌍은 항상, 거절. "항상"만 저장한다(스토어 v44, `project_consents`,
   from·to·종류마다 한 줄; 두 id 모두 프로젝트와 함께 지워진다). 설정 → Permissions가 쌍을 보여 주고 철회한다. 거절과
   거둬진 카드는 모델이 "시키기 전에는 다시 묻지 말라"로 읽는 거절을 돌려준다. A부분의 앱 도구도 같은 문을 쓴다(종류 `apps`).
3. **맡겨진 세션.** 이 호출자가 그 프로젝트에 전에 맡겼던 쉬는(또는 턴을 마친) 세션을 다시 쓴다 — 두 번째 부탁이 첫 번째
   위에 쌓이도록. 없으면 그 프로젝트의 폴더, 지침(여느 세션처럼 그 프로젝트의 신뢰), 기본 도구와 그 도구에 기억된 모델·추론
   강도로, `normal` 프리셋 아래 새로 띄운다 — 사람이 그 프로젝트에서 여는 세션과 같다. 그래서 그 세션의 승인은 사람이 보는 그
   세션에 카드로 선다. 보이는 평범한 세션이며 이름은 `Asked by <project> · HH:MM`, 호출자를 `askedBy`(스토어 v45)로
   표시한다. 헤더가 호출자로 되돌아가는 링크를 달고, 호출한 쪽 대화에는 이 세션으로 가는 작은 카드가 남는다.
4. **일**은 틀(`askFrame`)에 담겨 간다: 누가 맡기는지, 마지막 메시지가 곧 답이며 파일은 절대 경로로 적으라는 것. 호출자가
   보낸 것(`from`)으로 기록된다 — `send_to_session`처럼. 호출은 앱의 에이전트가 쓰는 감시자(`AgentRunWait`)로 턴을 기다린다.
5. **답.** 턴의 마지막 글(`finalAnswer`)을 워커의 미리보기처럼 JSON으로 감싸(남의 말이다) 모델에 주고, 6,000자를 넘으면
   가운데를 자른다. 답이 이름 붙인 절대 경로 중 **대상 프로젝트 폴더 안에** 실제로 있는 것(심볼릭 링크를 풀어서; 프로젝트
   루트 자체는 결코 아니다)만 호출자가 읽을 수 있게 된다(`readGrants`): 파일은 그 파일을, 폴더는 그 아래를 연다. 밖의 경로는
   알려 주되 열지 않는다. 허가는 이 호스트가 호출자를 돌보는 동안 산다. Claude는 `CreateSessionOpts.mayRead`로 읽는다 —
   작업 폴더 밖 읽기는 `canUseTool`에 떨어지고(`additionalDirectories`는 시작할 때 고정된다) 거기서 이것을 묻는다. Codex는 읽기를
   막지 않으므로 필요 없다.

**긴 일.** 한 호출은 `ASK_WAIT_MS`(240초)까지 기다린다 — Codex의 `tool_timeout_sec` 300초(이제 `centralu` 서버에도 건다)
아래, 앱의 긴 호출과 같은 여유로. 넘으면 세션 이름과 함께 "still working"을 답하고, 같은 프로젝트로 task 없이 부르면 같은
턴을 계속 기다린다. 하나가 도는 동안 새 일은 거절한다. 다리는 `orchestrator.tool`을 280초까지 기다리므로(전에는 60초)
"still working"이 어떤 타임아웃보다 먼저 모델에 닿는다.

**Stop.** 호출자의 Stop(`interrupt`)은 맡겨진 턴을 멈추고 그 이유로 호출을 끝낸다. 호출 자신의 취소(MCP 요청의 signal,
Claude)도 같다. 사람이 맡겨진 세션을 멈추거나 턴이 실패하면 그 세션을 이름 붙여 다음 할 일을 일러 주는 오류를 돌려준다.
호출자를 지우면 기다림과 허가가 사라진다. 맡겨진 세션은 이제 그 프로젝트의 세션이므로 자기 턴을 이어 간다.

**크기.** 읽기 묶음과 같은 방식으로 쟀다(haiku, `scripts/probe-reader-tools.mts`): `ask_project`는 350자
(`DELEGATE_BUDGET_CHARS` 400)이고 로드하면 **+103토큰**(묶음: +192 → +295), 미루면 +10이다. 로드한다: "Have the toolkit
project export the sprites again, then tell me where the files are"에 로드하면 10번 중 7번 그 프로젝트로 불렀고, 미루면
5번 중 0번 — 지난 대화와 자기 폴더를 뒤졌다. #320이 `recall`에서 잰 실패와 같다. 놓친 경우는 그런 프로젝트가 없다는 답이고,
사람이 도구를 이름으로 부를 수 있다. 상관없는 사용법 질문 다섯 중 하나가 없는 프로젝트를 대서 불렀다(거절, 카드 없음).
설명은 "a task"가 아니라 "a job"이라 쓴다: 모델에게는 같게 읽히고(각각 10번 중 7번), 모든 자리의 도구를 나열하는 안내서에
없어진 컨트롤 레일의 task라는 말이 남지 않게 한다(#97). 다른 문구 두 가지는 낫지 않았다(5번 중 0, 3).

`scripts/smoke-ask-project.mts`가 임시 스토어와 데이터 폴더에서 처음부터 끝까지 돌린다: 한 임시 프로젝트의 haiku 세션이 다른
프로젝트에 자기만 아는 숫자를 쓴 파일을 만들게 하고 그 파일을 읽어 온다(`CALLER`/`CALLEE` = `claude` 또는 `codex`).

**stdout은 예약되어 있다.** `main.ts`가 딱 한 줄을 찍는다: Tauri 수퍼바이저가 포트와 인증
토큰을 읽어 가는 핸드셰이크다. 나머지는 전부 stderr로 간다. `log-file.ts`가 파일로 흘리는
것이 stderr이고, Finder로 띄운 `.app`의 stdout은 **닿는 곳이 아예 없기** 때문이다 — 그래서
이 패키지의 `console.log`는 터미널에서는 멀쩡해 보이면서 배포에서만 아무에게도 닿지 않는다.
`eslint.config.js`의 `no-console`이 그 한 줄만 빼고 전부 막는다.

**Windows에서 Claude 프로세스를 띄우는 방법 (#353).** npm으로 설치한 Claude Code는 프로그램 하나,
`node_modules\@anthropic-ai\claude-code\bin\claude.exe`다. npm의 `claude.cmd`가 이것을 띄우고, #307부터는
호스트도 이것을 직접 띄운다. 이 파일은 플랫폼 패키지 `claude.exe`의 두 번째 이름(하드 링크)이다. Windows는
실행 중인 프로그램의 이름을 바꾸는 것과, 다른 이름이 남아 있는 동안 지우는 것은 허락하지만, 마지막 이름을
지우거나 그 위에 덮어쓰는 것은 막는다. npm 업데이트는 두 이름을 지우고 새 파일을 만든다. Centralu 세션이
`bin\claude.exe`에서 돌고 있으면 두 번째 삭제가 마지막 이름이라 실패하고, Claude Code의 설치 단계
(`install.cjs`)는 npm의 500바이트 자리표시자를 남긴다: `.exe`라는 이름의 텍스트 파일이라 Windows는 16비트
프로그램이라고 부른다. 그래서 Windows에서만
(`adapters/claude/exe-link.ts`, `start-gate.ts`):

| 단계 | 하는 일 | 이유 |
|---|---|---|
| 자리표시자 검사 | 1 MB 미만이고 `MZ`로 시작하지 않는 `.exe`면 세션 시작과 `detect`가 파일, 원인, 고치는 법(`node "<pkg>\install.cjs"`, 또는 Claude Code를 모두 끈 채로 재설치)을 말하며 실패한다 | spawn 오류는 "16비트 프로그램"이라고만 한다 |
| 하드 링크 | 프로그램을 `<data>\tools\claude\<버전>-<크기>\claude.exe`(data = `CC_DATA_DIR`)에 하드 링크하고 거기서 띄운다. 링크가 실패하면(`EXDEV`, `EPERM`) 복사하고, 둘 다 실패하면 로그 한 줄과 함께 npm 경로 그대로 띄운다 | npm 업데이트는 프로그램의 npm 쪽 이름 둘을 지우고 그 자리에 새 파일을 만든다. Windows는 실행 중인 프로그램의 마지막 이름은 지우지 못하게 하므로, 세션이 npm 이름에서 돌면 업데이트가 실패하고 링크에서 돌면 성공한다(NTFS에서 측정). 링크는 디스크를 쓰지 않는다 |
| 링크 키 | 프로그램 옆 npm `package.json`의 버전과 크기. npm 밖이면 크기와 수정 시각 | 읽는 비용이 없다. `--version`은 npm 파일을 실행하고, 내용 해시는 시작마다 250 MB를 읽는다. npm은 모든 파일에 같은 시각을 찍는다 |
| 정리 | 이 호스트의 어떤 세션도 쓰지 않고 새 세션이 쓰는 것도 아닌 링크 폴더를 지운다: 호스트 시작, 설치된 버전이 바뀔 때, 세션 프로세스가 끝날 때 | 링크를 지워도 그 링크에서 도는 프로세스는 영향을 받지 않는다. Windows는 실행 중인 프로그램의 마지막 이름만 지우지 못하게 하고, 그 폴더는 다음 정리 때 지워진다 |
| 시작 간격 | Claude 프로세스를 하나씩, 1.5초 간격으로 띄운다 | 로그인 정보가 파일이고 한 번에 하나만 갱신한다. 함께 뜬 프로세스는 만료된 토큰을 한꺼번에 갱신하려 한다 |
| 갱신 경합 | "another Claude Code process is refreshing it"으로 끝난 턴은 3~6초 뒤 한 번 다시 보내고 대화에 알림을 남긴다. 두 번째 실패는 실패로 알린다 | CLI 스스로 일시적이라고 한다. 그 사이 다른 프로세스가 새 토큰을 써 둔다 |
| 떠날 때 | 종료할 때 호스트는 자기가 닫은 Claude 프로세스가 stdin EOF로 스스로 끝나기를 최대 1.5초 기다린다 | Node 프로세스는 끝날 때 자식을 함께 데려가서, 쓰고 있던 갱신이 잘릴 수 있다 |

재시도는 모든 플랫폼에서 돈다(경합이 없는 곳에서는 비용이 없다). 나머지는 Windows 전용이다. macOS와 Linux는
실행 중인 프로그램도 아무 문제 없이 바꾸고, macOS는 로그인 정보를 키체인에 둔다. 세션 하나를 끝낼 때는 따로
할 일이 없다: Windows에서 SDK는 CLI의 stdin을 닫고 7초가 지나서야 죽인다. 호스트가 끝날 때 턴 도중인
프로세스는 예전처럼 호스트와 함께 끝난다. 세션이 도는 동안 설치된 Claude Code 업데이트는 각 세션이 다음에
시작할 때 쓰이고, 옛 버전의 링크는 마지막 세션이 끝나면 지워진다.

추가 하나(#280): 키퍼 아래에서(`CC_KEEPER=1`) 호스트는 `{"activity":{"busy":true|false}}`도 stdout에
쓴다, 시작할 때 한 번과 바뀔 때마다(`keeper-link.ts`). 키퍼의 유휴 규칙이 읽는 것이 이것이다. 다른 방법으로
띄우면 호스트는 준비 줄 말고 아무것도 쓰지 않는다.

## 2. AgentAdapter 계약 (product spec §6.2의 구현 명세)

```ts
interface AgentAdapter {
  readonly tool: ToolName                  // a closed enum in @cc/protocol — see #74
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>          // installed / logged in (FR-19)
  installedVersion?(): Promise<string | null>  // #297: 지금 설치된 CLI, 세션 없이 읽는다 (§4.6)
  createSession(opts: CreateSessionOpts): Promise<SessionHandle>
  resume(externalId: string, opts): Promise<SessionHandle | null>  // null = resume not possible
}

interface SessionHandle {
  readonly externalId: string
  send(input: UserInput): void
  respondApproval(requestId: string, decision: Decision, scope?: Scope): void
  interrupt(): void
  stopBackgroundTask?(taskId: string): Promise<void>  // #290: 백그라운드 작업 하나만 멈춘다
  dispose(): Promise<void>
  events: Emitter<NormalizedEvent>         // emits protocol types only
}

interface AdapterCapabilities {
  approvals: boolean            // can permissions be overridden per session (reflects the M0 result)
  contextUsage: 'exact' | 'estimate' | 'none'
  resume: boolean
  autoTitle: boolean
  attachments: ('image' | 'file')[]
  verbosities: string[]         // 응답 길이 단계. 비어 있으면 이 도구에는 그 노브가 없다 (#54)
  exclusiveWriter: boolean      // 우리가 쥐고 있는 동안 다른 누구도 대화에 쓸 수 없다
  backgroundTasks: boolean      // 백그라운드 작업을 `background_tasks`로 알린다 (#290)
}
```

구현 규칙:

- **외부 SDK 타입은 adapters/<tool>/ 밖으로 나갈 수 없다** (anti-corruption). 어댑터의 유일한 출력은 `NormalizedEvent`다.
- **도구 호출은 카드와 기록을 함께 싣는다** (#221). `summary`는 카드가 보여 주는 것이라 짧게 잘려도 된다.
  `tool_call.input`은 도구가 받은 입력을 받은 그대로, `tool_result.output`은 도구가 답한 글 전체를 자르지 않고 싣는다.
  이미지는 뺀다(`message_image`로 따로 나간다, #40). host가 기록을 저장소에 남기고 내보내는 모든 것에서 걷으므로
  ([protocol.md](protocol.md) §2), 어댑터는 작은 카드와 온전한 기록 사이에서 고를 필요가 없다.
- **네이티브 서브에이전트의 걸음은 감싸서, 띄운 호출을 붙여 내보낸다** (#222). 부모 자신의 이벤트로는 결코 내보내지
  않는다(#98): `step`이 글, 추론, 도구 호출, 도구 결과 중 하나이고 `parentCallId`가 서브에이전트를 띄운 호출인
  `subagent_event`다. Claude: 서브에이전트의 메시지에는 `parent_tool_use_id`가 붙어 있고, `forwardSubagentText`를 켜면
  도구 블록만이 아니라 글과 생각도 온다. normalizer는 그것을 부모의 것처럼 읽은 뒤 감싼다. Codex: 자식 스레드의 `item/*`
  알림이 자식의 `threadId`를 달고 부모의 연결로 온다. 부모의 `spawnAgent` 항목이 `item/completed`의 `receiverThreadIds`로
  자식을 가리키고, 그보다 먼저 온 자식의 항목(측정: 자식의 첫 알림이 같은 밀리초에, 연결보다 먼저 왔다)은 붙잡아 두었다가
  다시 흘린다. 공식 경로만 쓴다 — SDK의 스트림과 app-server의 알림이며, 도구의 대화 파일은 읽지 않는다. 매니저는 걸음을
  대화와 따로 `subagent_messages`에 남기고 카드로 내보낸다. 서브에이전트가 바꾼 파일은 여전히 세션의 것으로 알리고
  (`files_touched`), 서브에이전트가 만든 커밋은 세션에 귀속한다(#50).
- **백그라운드 작업은 하나의 수준 신호 `background_tasks`로 알린다** (#290): 바뀐 뒤 살아 있는 작업 전부(REPLACE
  의미라서, 메시지 하나를 놓쳐도 작업이 "실행 중"으로 남지 않는다)와, 방금 끝난 작업과 그 상태(`completed`, `failed`,
  `stopped`). 작업마다 `{ id, kind: agent | shell | mcp | other, description, parentCallId?, ambient?, stopsWithTurn?,
  stoppable? }`를 싣는다. `stopsWithTurn`은 턴을 중단하면 그 작업이 어떻게 되는지를 **그 도구에서 측정한 대로** 적은
  것이고, 측정하지 않은 곳에서는 비워 둔다. 세션의 중지 버튼이 누르기 전에 말해 주는 것이 이것이다. 자기 백그라운드
  작업을 볼 수 없는 어댑터는 `capabilities.backgroundTasks: false`를 선언하고, 짐작하는 대신 아무것도 보내지 않는다.
  알리는 어댑터는 놓아주기도 한다: 프로세스가 사라지면 살아 있는 집합을 비워서 보내고, 쥐고 있던 것은 `stopped`로
  끝난 것으로 보낸다.
  - **Claude**는 `system/background_tasks_changed`(수준 신호, tool_use_id 없음), `task_started`(띄운 호출,
    `owned_by_subagent`), `task_updated`, `task_notification`(끝)을 읽는다. 측정
    (`scripts/probe-background-tasks.mts`, CLI 2.1.282, SDK 0.3.263): 턴 도중의 `interrupt()`는 백그라운드
    서브에이전트를 멈추고(같은 밀리초에 `task_notification` stopped) **백그라운드 셸은 계속 돌게 둔다**.
    `stopTask(id)`는 같은 세 메시지로 작업 하나를 멈춘다. `close()`는 남은 것을 죽이고 아무것도 보내지 않는다.
  - **Codex**는 `spawnAgent` 항목이 가리킨 자식 스레드를, 그 스레드가 active인 동안 목록에 올리고, 자식의
    `turn/completed` 상태로 끝낸다. 측정(`scripts/probe-codex-background.mts`, codex-cli 0.160.0): 부모 턴에 대한
    `turn/interrupt`는 **자식을 계속 돌게 둔다**. 자식 자신의 턴에 대한 `turn/interrupt`는 자식을 멈추며, 이것이
    작업 하나를 멈추는 방법이다. Codex의 중단은 자식이 돌리던 명령을 죽이지 않는다.
  - 매니저는 세션마다 목록을 쥔다(`SessionInfo.backgroundTasks`, `goal`처럼 살아 있는 동안만). 이벤트마다
    `applyBackgroundTasks`로 반영하며, UI의 리듀서와 mock도 같은 함수를 돌린다. `sessionIdle()`은 세션의 프로세스를
    잃는 것 없이 바꿀 수 있는지 말한다(#297): 턴이 없고, 기다리는 승인이나 질문이 없고, ambient가 아닌 실행 중 작업이
    없어야 한다. 백그라운드 작업을 알리지 못하는 도구가 프로세스를 쥐고 있는 동안에는 결코 idle이 아니다. 규칙 자체는
    `idle.ts`의 `sessionIdle`이며 `hostBusy` 옆에 있다(§4.5).
- **프로세스가 돌리는 CLI 버전은 프로세스마다 한 번 `agent_version`으로 알린다** (#297). Claude: init 메시지의
  `claude_code_version`(init은 질의마다 다시 오므로 바뀐 것만 보낸다). Codex: `initialize` 응답의 `userAgent`,
  `<클라이언트 이름>/<서버 버전> (<os>) …`(측정, codex-cli 0.160.0:
  `centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)`). `protocol-contract.json`이 이 필드를
  적어 두므로 이름이 바뀌면 drift 검사가 실패한다. 넘겨받은 프로세스는 다시 말하지 않으므로 그 버전은 키퍼 태그에서
  온다(§4.6).
- **도구가 자기 사용자에게 하는 말은 도구 자신의 말로 나간다** (#304): 새 대화는 `conversation_reset`, 읽히길 바라는
  글은 `notice`, 도구가 스스로 바꾼 설정은 `by: 'tool'`인 `settings_changed`(스냅숏은 프로세스를 띄운 값에 바뀐 필드를
  얹은 것이고, 호스트는 다른 것만 적용한다), 재시도는 출력이 다시 흐를 때까지 `retrying` 활동. 따로 적지 않은 것은 측정한
  페이로드다(SDK 0.3.263을 거친 CLI 2.1.289, codex-cli 0.160.0, 2026-10-04).

  | 도구 | 메시지 | 바뀌는 것 |
  |---|---|---|
  | Claude | `/clear`에 `conversation_reset {new_conversation_id, trigger: 'clear'}`, 이어서 새 `session_id`를 단 `init` | `conversation_reset` |
  | Claude | `system/informational {content, level}` — `UserPromptSubmit` 훅이 막은 이유가 level `warning`, `prevent_continuation: true`로 왔다 | `notice`. level `info`는 뺀다(CLI도 트랜스크립트 모드에서만 보인다) |
  | Claude | `system/notification {key, text, priority, color}` (실행하지 못함) | 색과 우선순위를 접은 level의 `notice`. "Error compacting conversation"은 압축 실패 마커에 맡긴다 |
  | Claude | `system/api_retry {attempt, max_retries, retry_delay_ms, error_status, error}` — 529가 두 번 답한 뒤 합성 "API Error" 메시지와 오류 결과 | 한 번의 재시도 구간에 `retrying` 한 번과 시도마다 host.log 한 줄. 다음 스트림 이벤트나 assistant 메시지에서 이전 활동이 돌아온다 |
  | Claude | `system/model_refusal_fallback` (실행하지 못함, sdk.d.ts) | scope가 `session`이거나 없으면 알림과 폴백 모델을 실은 `settings_changed`. scope `local`(서브에이전트)은 host.log만. `retracted_message_uuids`는 처리하지 않는다 |
  | Claude | `system/model_refusal_no_fallback` (실행하지 못함, CLI는 메인 스레드 경로에서 `content: ""`로 보낸다) | 결과까지 붙잡았다가 실패한 턴의 오류 메시지로, 턴이 실패하지 않았으면 알림으로. 글은 `content`, 없으면 거절 설명, 없으면 분류 |
  | Codex | `thread/start`가 답해지는 동안 `configWarning {summary, details}`, 이어서 같은 글의 `warning {threadId, message}`, 시작·재개 때마다 | `oncePerSession` 붙은 `notice`. 모르는 키 경고는 "Codex ignored N settings in `~/.codex/config.toml`"과 한 줄에 하나씩인 키, `for you` |
  | Codex | `deprecationNotice {summary, details}`: 오너가 "Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…"를 보았다(#342). `guardianWarning {threadId, message}` (실행하지 못함) | `notice` (앞의 것은 세션당 한 번). 전체 기록 불러오기 알림은 "Codex says Centralu loads thread history in an outdated way", `for Centralu` |
  | Codex | `mcpServer/startupStatus/updated` — 실패하는 서버는 스레드 시작 한 번에 `starting` → `failed {error}`를 두 번 거친다 | 서버마다 Codex의 말로 된 `notice` 하나(`MCP client for \`x\` failed to start: …`). 그 사이에 한 번 시작된 뒤에야 다시 |
  | Codex | `model/rerouted {turnId, fromModel, toModel, reason}` (실행하지 못함) | `notice`만. 턴 하나를 가리키고 스레드 설정은 바뀌지 않는다 |
  | Codex | `thread/settings/updated {threadSettings}` (실행하지 못함) | `thread/start`·`thread/resume`이 답한 값과 비교한다(Codex는 기본값을 구체적인 모델로 답한다). 실제 차이만 알림과 `settings_changed`가 된다 |

  자식 스레드의 알림은 예전처럼 부모의 대화에 들어오지 않는다.

  모든 알림은 누가 말하는지와 어떤 종류인지(`from`, `label`)를, 어댑터가 가릴 수 있으면 누가 움직여야 하는지(`audience`,
  #342)도 싣는다. Codex의 문구는 `adapters/codex/notices.ts`에 있다.

  | Codex 알림 | 줄 | 누구의 일 |
  |---|---|---|
  | 모르는 `config.toml` 키 (`configWarning`과 쌍둥이 `warning`) | "Codex ignored 2 settings in `~/.codex/config.toml`", 한 줄에 하나씩인 키, "Codex already runs without them; removing them from the file only silences this notice." | `you` |
  | 그 밖의 `configWarning` | Codex의 글 | `you` |
  | 전체 기록 불러오기 (`deprecationNotice`, 0.160.0 바이너리의 두 문구 모두) | "Codex says Centralu loads thread history in an outdated way", "Nothing to do on your side; Centralu will switch to the paginated API (#342)." | `centralu` |
  | 그 밖의 `deprecationNotice` | Codex의 글 | app-server 메서드(`thread/…`, `turn/…`, `review/…`)를 말하면 `centralu`, `config.toml`이나 `[features…]`를 말하면 `you`, 아니면 말하지 않는다 |
  | MCP 시작 실패 | Codex의 글 | Centralu의 오케스트레이터 브리지는 `centralu`, 앱의 브리지(`app-<id>`, 앱 자체 이유로 실패할 수 있다)는 말하지 않고, 그 밖의 서버는 `you` |
  | `warning`, `guardianWarning`, `model/rerouted`, 스레드 설정 변경 | Codex의 글(뒤의 둘은 우리 글) | 말하지 않는다 |

  Claude Code의 알림은 `from: 'Claude Code'`와 라벨(`hook` — `for you`, `notice`, `model switch`, `refusal`)을 싣는다.
  설명을 호스트가 쓰는 것은 알림을 알아보려면 도구의 문구를 알아야 하기 때문이다. 화면은 받은 것을 그리기만 하고, Codex
  자신의 말은 한 번 눌러 펼친다.
- 어댑터는 상태를 갖지 않는다 — 세션 상태 추적은 `sessions/`가 이벤트를 관찰하며 수행한다. 어댑터는 변환기일 뿐이다.
- 프로세스 관리(CLI spawn, 크래시 감지)는 어댑터 자신의 책임이다. 크래시는 `error` 이벤트로 방출되고 호스트는 죽지 않는다.
- capability는 반드시 정적 선언일 필요가 없다 — **detect() 시점에 결정**할 수도 있다 (예: 승인 동작 여부가 Codex 버전에 달려 있다면, 버전을 감지한 뒤 결정한다 — C4에 대한 대응).

## 3. 새 도구 추가 절차 (C3 — 이 문서가 존재하는 이유)

1. `adapters/<tool>/`을 만들고 `AgentAdapter`를 구현한다 (이벤트 변환 + detect + capability).
2. `@cc/protocol`의 `ToolName`에 도구를 넣고 `TOOL_META` 항목을 준다 — 표시 이름, 한 글자
   마크, 설치 명령, 로그인 명령. 그다음 `main.ts`의 `adapters` Map에 어댑터를 등록한다.
3. 계약 테스트를 추가한다: 녹화해 둔 raw 응답 픽스처 → NormalizedEvent 스냅샷 검증.
4. 의존하는 벤더 표면을 적어 두고 드리프트 체크를 만든다 (§3.1) —
   측정으로 얻은 프로토콜 지식은 그냥 두면 조용히 썩는다.
5. 끝. **ui, core, platform은 변경되지 않고**, protocol은 2번의 두 항목만큼만 바뀐다.
   (그 이상이 필요했다면 그것은 어댑터의 잘못이 아니라 프로토콜에 개념이 부족한 것이다 —
   프로토콜 확장을 먼저 검토한다)

이 문장은 예전에 더 셌고, 사실이 아니었다: protocol도 안 바뀐다고 적혀 있었지만 실제로 세
번째 도구를 넣으려면 11개 파일에 흩어진 약 20곳을 고쳐야 했다 — 따로 노는 `TOOL_LABEL` 맵
세 벌, 사이드바와 호스트의 인라인 `tool === 'codex' ? … : …` 삼항, 배지 글자, 설치·로그인
명령, 그리고 리터럴 `['claude', 'codex']` 배열 네 개. **동작** 쪽 경계는 언제나 깨끗했고
**표시** 쪽이 샜다. 이건 방향이 거꾸로다 — 새 도구의 비용이, 어댑터 디렉토리만 봐서는
존재조차 알 수 없는 잔손질로 청구된다는 뜻이기 때문이다. `TOOL_META`는 위 문장을 참으로
만들기 위해 있다 (#74).

**능력은 절대 `TOOL_META`에 넣지 않는다.** 도구가 *할 수 있는 것*은 어댑터가 선언하고
(`AdapterCapabilities`, `ModelOption`) 런타임에 발견된다. `TOOL_META`가 담는 것은 어떻게
보여줄지뿐이다. 둘을 섞는 순간 노브 하나를 UI에 두 번 가르쳐야 하는 코드가 된다.

### 3.1 벤더 표면 드리프트 체크 (SDK/CLI 업그레이드 전에 반드시 돌린다)

우리가 벤더 프로토콜에 대해 아는 것은 전부 측정으로 얻은 것이고, 벤더의 업그레이드는
그 지식을 **어디에도 에러를 내지 않고** 무효화할 수 있다. 그래서 어댑터마다 자기가
만지는 벤더 이름의 명시적 목록과, 그 목록을 재검증하는 스크립트를 둔다:

| 도구 | 계약 | 체크 | 잡는 것 |
|---|---|---|---|
| Codex | `adapters/codex/protocol-contract.json` — 우리가 보내거나 읽는 모든 RPC 메서드·알림, 승인 enum 값 | `pnpm codex:bindings --check` (설치된 CLI에서 바인딩을 재생성해 우리 이름을 대조) | 메서드/알림이 프로토콜에서 사라지는 것 (변경 축 C4) |
| Claude | `scripts/claude-sdk-drift.mjs` 안의 이름 목록 — SDK export, 옵션 키, 응답 필드 — 과 런타임 모양 검사 하나: `permissionMode`를 생략하면 CLI에 `--permission-mode` 플래그가 아예 가지 않아야 한다 (`normal` 프리셋이 여기에 기댄다, #275) | `pnpm drift:claude [버전]` (`@latest` 또는 지정한 버전을 임시 폴더에 설치 — 워크스페이스는 건드리지 않는다) | 업그레이드가 우리에게 닿기 **전에** 이름이 `.d.ts`에서 사라지거나, SDK가 생략된 모드를 다시 `default`로 굳히는 것 |

둘 다 이름 검사이고 (Claude의 모양 검사 하나는 예외), 양방향으로 돈다: 벤더는 우리가 쓰는 모든 이름을 여전히 갖고
있어야 하고, 우리 소스도 목록의 모든 이름을 여전히 써야 한다 (계약이 코드보다
오래 살아남지 못하게). 필드가 존재하되 뜻이 바뀌는 종류는 못 잡는다 — 그 종류는
어댑터의 런타임 타당성 검사가 지킨다 (컨텍스트 눈금 `149,084%`의 교훈). 이름은 그대로인데
더는 오지 않는 알림도 못 잡는다: Codex 압축 마커는 `thread/compacted`에서만 나왔는데, 이 이름은
바인딩에 남아 있고(`contextCompaction` 항목으로 대체됐다며 deprecated 표시) 측정한 어떤 CLI도 보내지
않아서, Codex 압축은 마커를 하나도 남기지 않았다 ([#303](https://github.com/ijun17/centralu/issues/303)).
그 종류는 실제 바이너리를 상대로 한 탐침(`scripts/probe-codex-*.mts`)이 검사한다.

**이 체크를 정직하게 유지하는 규칙:** 어댑터 코드가 새 벤더 이름 — 새 알림, config
키, 필드 — 에 의존하기 시작하면 **같은 PR에서** 계약에 추가한다. 새 도구(위 4단계)는
이 둘 중 하나에 해당하는 자기 몫을 만드는 것으로 시작한다.

## 4. 세션 생명주기와 UI 재연결

```
UI disconnects  → the host does nothing (sessions carry on, events accumulate in event-log)
UI reconnects   → hello { afterSeq, streamEpoch } → replay the missed events (same lifetime, within budget)
                  or resync (another lifetime, out of the buffer, over budget) → restore the screen
host restarts   → under the keeper: agents, terminals and commands keep running there; the new
                  host re-attaches to them mid-turn (§4.3) → a new streamEpoch → UIs resync
                → without a keeper: session processes die → a new streamEpoch → UIs resync
                  → attempt resume with the externalId from the store (the same path as FR-10)
host swapped    → the old host drains, the new one takes over behind the same front door (§4.2)
                → clients reconnect to the same address and resync on the new streamEpoch
keeper updated  → the old keeper hands every handle to the new build's keeper (§4.4): the host,
                  agents, terminals and every connection carry on; nothing reconnects
app quits       → background mode off (default): the keeper stops the host, as above
                → background mode on: nothing happens to the host; a relaunched app re-attaches
app relaunches  → "Apply now" (#352): the app announces it first, so with either mode nothing
  to update       happens to the host; the relaunched window re-attaches and switches (§4.5)
```

이 설계 덕분에 FR-10의 절반(재시작 시 복원)은 평범한 재연결과 같은 코드 경로다 — 특별한 경우가 아니라 기본 동작이다. 커서·재생 예산·전송 한도의 규칙은 [protocol.ko.md](protocol.ko.md) §1에 있다.

**데이터 폴더 하나에 호스트 하나** (`dev-services/instance-lock.ts`). 한 폴더에 호스트가 둘이면 각자 제 세션 목록을 들고 같은 `store.db`에 쓴다. 소유권은 호스트가 살아 있는 내내 쥐는 배타적 SQLite 트랜잭션이다(`host-ownership.sqlite`에 `BEGIN EXCLUSIVE`, DELETE 저널 모드) (#82). 잡는 일은 원자적이고, 두 번째 호스트는 곧바로 거절되며, 호스트가 어떻게 죽든 운영체제가 풀어 주므로 크래시가 낡은 흔적을 남기지 않는다. `host.lock`(pid와 시작 시각)은 충돌 메시지에 주인을 적는 설명으로, 그리고 그 파일만 아는 옛 호스트를 위해 남는다: 살아 있고 맞아떨어지는 `host.lock`은 여전히 시작을 거절한다. #82 전에는 파일 하나를 확인하고 나서 쓰는 방식이라, 동시에 띄운 호스트 8개에서 주인이 2개 나왔다. 한 기계 안의 소유권이다 — 분산 임대가 아니고, 네트워크 파일시스템 위의 데이터 폴더용도 아니다.

### 4.1 호스트를 쥐는 쪽: 키퍼 (#280, 옵션 C 1단계)

패키지된 앱에서 호스트의 부모는 앱이 아니라 키퍼다(`centralu --keeper`, 앱 실행 파일의 한 모드;
[architecture.ko.md](architecture.ko.md) §4.1). 키퍼는 호스트를 `--port 0 --watch-parent --db <data>/store.db`와
`CC_DATA_DIR=<data>`로 띄우고, stdin 파이프를 쥐며, 앱이 쓰던 규칙 그대로 다시 띄운다: 연속 실패 다섯 번,
30초 안정 가동이면 횟수 초기화, 잠금 충돌이나 더 새 빌드만 읽을 수 있는 store면 곧바로 멈춤(`host_proc.rs`,
키퍼와 앱의 직접 경로가 함께 쓴다). 키퍼가 죽으면 호스트는 그 파이프에서 EOF를 보고 스스로 내려간다.

**빌드별 사본.** 띄울 때마다 키퍼는 번들의 `resources/host` 폴더를 `<data>/hosts/<key>/`에 복사하고(임시 폴더에
쓴 뒤 rename) 거기서 `main.mjs`를 돌린다. key는 `bundle-info.json`에 찍힌 커밋이다. `-dirty`나 `unknown`
빌드는 빌드 시각을 덧붙여, 서로 다른 dirty 빌드가 사본을 함께 쓰지 않는다. 호스트가 준비되면 도는 호스트의
것 말고 다른 사본은 지운다.

**어디서 왔는가.** 키퍼는 도는 호스트에 대해 `{ commit, builtAt, version, protocolVersion, bundlePath, hostDir,
copyDir }`를 들고, 제어 소켓으로 돌려주고, `<data>/keeper.json`(토큰 없음)에 쓰고, 호스트에 `CC_HOST_SOURCE`로
넘긴다. 호스트는 이것을 모든 `hello_ok`에 `build`로 싣는다([protocol.ko.md](protocol.ko.md) §1). 커밋은 언제나
호스트 자신에 컴파일된 것이다.

**제어 소켓.** `<data>/keeper.sock`, `umask 077` 아래에서 `0600`으로 만든다. 모든 연결의 상대 uid가 키퍼 자신의
것이어야 한다. 줄 단위 JSON이고, `attach` 말고는 연결 하나에 요청 하나다:

| 요청 | 답 |
|---|---|
| `{"op":"status"}` | `{"ok":true,"view":…}` — 호스트 상태, 정문의 포트와 토큰(§4.2), 빌드 출처, 백그라운드 모드, 붙은 창 수, 활동, 지금 또는 마지막 교체(`swap`), 교체 때 호스트가 에이전트를 넘겨주는지(`keepsAgents`), 키퍼 자신의 빌드(`keeper.build`, 4단계부터) |
| `{"op":"attach","protocol":1,"build":…}` | `{"ok":true,"view":…,"sameBuild":bool,"keeperSameBuild":bool,"relaunched":bool}`, 그 뒤 연결이 열려 있는 동안 바뀔 때마다 `{"event":"status","view":…}`. 열린 attach 연결이 곧 "창이 붙어 있다"는 뜻이고, 그것이 닫히는 것이 떨어짐이다. `relaunched`: 이 창이 알린 다시 띄우기로 뜬 창이다(§4.5) |
| `{"op":"relaunching","graceSecs":n?}` | `{"ok":true,"graceSecs":n}` — 앱이 업데이트를 적용하려고 곧 스스로를 다시 띄운다(#352): `n`초(기본 60, 최대 300) 동안은 붙은 창이 없어도 키퍼가 멈추지 않는다, 백그라운드 모드가 무엇이든. 다음 attach가 이것을 써 버린다 |
| `{"op":"stop"}` | 호스트와 키퍼를 멈춘다("Quit and stop agents") |
| `{"op":"switch","source":…,"keeper":{"exe":…}?}` | 그 빌드로 블루그린 교체(§4.2, 빌드 표식은 그 폴더에서 다시 읽는다). 떠 있는 호스트가 없으면 다음 시작이 그 빌드를 돌린다. `keeper`가 있고(앱은 자기 실행 파일을 보낸다) 키퍼가 다른 빌드면, 키퍼가 먼저 그 빌드의 키퍼에게 스스로를 넘기고([architecture.ko.md](architecture.ko.md) §4.4) 그 키퍼가 교체를 한다. 교체 중의 두 번째 `switch`는 거절한다 |
| `{"op":"upgrade","exe":…,"source":…}` | 호스트는 그대로 두고, 키퍼를 `exe`에 있는 `source` 빌드의 키퍼에게 넘긴다(§4.4) |
| `{"op":"restart"}` | 호스트가 포기한 뒤의 Retry (교체 중에는 거절) |
| `{"op":"settings"}` / `{"op":"set_background","on":bool}` | 백그라운드 모드, `<data>/keeper-settings.json`에 둔다 |

**옛 폴더.** 기본 데이터 폴더를 무엇이 만들기 전에, 앱과 키퍼가 이름을 바꾸기 전의 폴더를 `data-dir.ts`와
같은 규칙으로 새 이름으로 옮긴다: 새 폴더가 있으면 호스트는 옛 폴더를 건드리지 않으므로, `keeper.log`나 소켓 때문에
`~/.centralu`를 먼저 만들면 데이터가 옛 자리에 남는다.

**데이터 폴더 하나에 키퍼 하나.** `<data>/keeper.lock`에 `flock`, 키퍼가 어떻게 끝나든 OS가 푼다. 앞선 키퍼가
소켓에서 답하면 두 번째 키퍼는 코드 3으로 끝나고 호스트를 띄우지 않는다. 앞선 키퍼가 잠금을 쥐었는데 답하지
않으면(내려가는 중) 15초까지 기다린다.

**언제 끝나는가.** `keeper/mod.rs`의 `idle_decision`: 창이 붙어 있으면 끝나지 않는다. 알린 다시 띄우기의
유예(§4.5) 동안에는 어느 모드에서든 아직 끝나지 않는다. 백그라운드 모드가 꺼져 있으면 마지막 창이 떨어질 때. 켜져 있으면 창도 없고 호스트가 보고한 활동(일하거나 기다리는 세션, 터미널, 명령
실행)도 없이 30분이 지났을 때. 시작하고 60초 안에 아무 창도 붙지 않은 키퍼도 끝난다: 그것을 띄운 앱이 먼저
죽은 것이다.

`scripts/keeper-integration.mjs`가 진짜 바이너리(`cargo build`, `/tmp`로)와 진짜 번들 호스트로 임시
`CC_DATA_DIR`에서 알린 다시 띄우기까지 이것을 전부 몰아 본다.

**CI에서.** `.github/workflows/build.yml`의 `keeper e2e` 잡(macOS)이 바이너리와 호스트를 한 번 빌드하고, 세 키퍼
스크립트 가운데 모델도 네트워크도 필요 없는 부분을 돌린다: `keeper-integration.mjs` 전부, 그리고
`--no-claude --no-codex`를 붙인 `keeper-children-integration.mjs`와 `keeper-handoff-integration.mjs`. 이 잡이 있는
까닭은 이 중 어느 것도 단위 테스트나 e2e에 드러나지 않기 때문이다: 서버가 생기기 전에 넣은 #329의 `await`가 터미널을
쥔 호스트의 재시작을 모두 크래시시켰고(#348), 알아챈 것은 손으로 돌린 children 스크립트뿐이었다. claude와 codex
턴은 손으로 돌리는 채로 남는다. 각 스크립트는 통과하든 실패하든 자기가 띄운 프로세스와 그것들이 띄운 것까지 모두
끝낸다. 이름이 아니라 프로세스 표 하나로 찾는다(`scripts/keeper-test-processes.mjs`). 검사가 실패하면
`keeper.log`와 `host.log`의 끝을 찍는다. Linux에서는 아직 돌리지 않는다: ubuntu-24.04에서 해 본 시도(2026-10-05)는 첫
시나리오의 키퍼가 멈춘 직후 키퍼의 프로세스 그룹 밖에 있는 스크립트 자신에게 SIGTERM이 닿아 끝났다.

### 4.2 호스트에서 본 정문과 교체 (#280, 옵션 C 3단계)

설계는 [architecture.ko.md](architecture.ko.md) §4.2에 있다. 호스트가 하는 일:

**토큰과 주소는 키퍼에게서.** 키퍼 아래에서 호스트는 `CC_HOST_TOKEN`(정문의 토큰, 키퍼가 돌리는 모든 호스트에
같다)과 `CC_FRONT_DOOR`(`ws://127.0.0.1:<door>`)를 받고, 읽은 뒤 둘 다 환경에서 지워 터미널·에이전트·명령이
물려받지 않게 한다. Codex 브리지는 정문 주소로 띄운다(`swap-control.ts`, `bridgeAddress`): 도는 codex는 브리지를
계속 쥐고, 이 호스트보다 오래 사는 주소만 교체를 견딘다. 키퍼가 없으면 예전처럼 호스트 자신의 포트를 준다.

**stdin의 제어 줄** (`swap-control.ts`). 키퍼의 파이프는 한 줄에 JSON 객체 하나씩도 나른다. 호스트는 준비 줄
옆 stdout으로 답한다. 어느 쪽도 상대가 하는 다른 말은 해석하지 않는다.

| 키퍼 → 호스트 | 호스트 → 키퍼 |
|---|---|
| (`--standby`로 띄움) | 자기 점검을 통과하면 `{"standby":{pid,schema}}` |
| `{"op":"activate"}` | 일을 시작하면 평소의 준비 줄 |
| `{"op":"drain","timeoutMs":N}` | `{"drained":{waitedFor,cut,ms,keptAgents}}`, 그리고 끝난다 |
| — | 시작할 때마다 한 번 `{"swap":{"keepsAgents":bool}}` |

**대기(standby).** 소유 잠금 전에: 호스트는 번들을 읽었고 도구를 찾았다. 저장소를 읽기 전용으로 읽고
(`Store.inspect`), `min_reader_version`이 자기보다 높으면 "written by a newer Centralu" 문장을 말하고 1로 끝나서,
도는 호스트를 건드리기 전에 교체가 실패한다. 아니면 보고하고 `activate`를 기다린다. 파이프가 닫히면(키퍼가
포기했다) 아무것도 건드리지 않은 채 끝난다. 대기 중에는 듣지 않는다: 정문이 포트를 가리고, 서버는 세션 관리자가
필요하며 그것은 쓰기용으로 연 저장소가 필요하다.

**드레인** (`drain.ts`). 모든 WebSocket RPC와 모든 프로세스 안 MCP 도구 호출(오케스트레이터 도구, 앱 도구
프록시)이 추적기 하나를 지난다. `drain`이 오면 새 호출은 거절하고 도는 호출에 한도를 준다. 한도가 지나면 각
호출에 "호스트가 빌드를 바꾸느라 기다리기를 멈췄고, 호출은 끝났을 수도 아닐 수도 있으니 확인하고 다시 부르라"는
오류로 답한다. 거절과 끊기에서 나온 RPC 오류는 `retryable: true`다. 그 다음 차례로: 끊긴 호출의 오류가 에이전트에
닿을 잠깐, **detach 훅** `stopServices('detach')`, 잠금 놓기, `drained` 쓰기, 종료. detach 훅은 키퍼가 쥔
에이전트·터미널·명령을 놓아주고(§4.3), 호스트 안에 사는 것(앱 프로세스, in-process 서버)만 멈춘다.
`drained.keptAgents`와 시작 때의 `keepsAgents` 보고는 호스트가 키퍼의 자식 서비스를 가졌을 때만 참이다. 그것이
없는 호스트는 여기서 stop처럼 자식을 멈춘다.

**넘겨받기.** `activate` 뒤에 호스트는 잠금을 잡고 저장소를 `swap: true`로 연다: 확장 단계는 지금 돌고, 무거운
단계와 깨는 단계는 준비 줄 뒤에 돈다(§5.1).

**열려 있는 앱 화면** (#280 4단계). 화면의 프레임 주소는 정문의 포트(`swap-control.ts`, `viewPort`)와 키퍼의
토큰에서 유도한 비밀(`transport/http.ts`, `deriveHttpSecret`)을 쓴다. 그래서 키퍼가 돌리는 모든 호스트는 같은
인스턴스에 같은 주소를 내준다. 키퍼가 없으면 둘 다 전과 같다(호스트의 포트, 무작위 비밀). 인스턴스 자체는 메모리에만
있으므로, 계획된 끝 — 위의 drain, 또는 호스트가 키퍼의 자식 서비스를 가졌을 때의 시그널 — 은 `stopServices`의
맨 처음에 열려 있는 각 인스턴스의 id·앱·`ui://` 주소를 `app_settings`에 적는다(`views.handover`,
`view-handover.ts`). 키퍼 아래에서 시작한 다음 호스트는 listen 전에 그 기록을 읽어 지우고, 10분이 넘지 않았으면 같은
id로 다시 연다: 각 인스턴스는 `open()`처럼 자기 앱을 다시 붙들고, 사라진 앱은 건너뛰며, 대화 안 화면은 자기 카드에
다시 묶여(`InlineViews.adopt`) 그 메시지가 여전히 그 대화로만 간다. 대화 안 화면이 잃는 것은 그 호출의 입력과
결과(디스크에 적지 않는다)라서, 닫히고 나면 재시작 뒤처럼 "앱 열기"만 남는다. 크래시는 아무것도 적지 않아 화면을
전처럼 잃는다. 앱별 출처 포트는 `apps.viewFrame`이나 프록시 페이지가 처음 필요로 할 때 새 호스트가 늦게 연다. UI
쪽에서는 열려 있는 모든 `AppFrame`이 재동기화 뒤에 주소를 다시 묻는다(스토어의 `hostResyncs`): 같은 주소면 화면과 그
상태를 그대로 두고, 다른 주소면 새로 띄우고, 실패하면 첫 로드의 실패 경로로 간다.

### 4.3 호스트에서 본, 키퍼가 쥔 자식들 (#280, 옵션 C 2단계)

설계는 [architecture.ko.md](architecture.ko.md) §4.3에 있다. 키퍼 아래에서(`CC_KEEPER=1`) 호스트는 시작할 때
`<data>/children.sock`에 붙는다(`keeper/held-children.ts`). 거기서 아무도 답하지 않으면(옛 키퍼, 묶이지 못한 소켓)
호스트는 자기 자식을 직접 띄우고 모든 끝에서 멈춘다, 키퍼가 없을 때와 똑같이. `pnpm dev`, e2e, 디버그 앱, Windows는
이 경로를 타지 않는다.

**자식 소켓** (데스크톱 크레이트의 `keeper/children/`, 여기의 `keeper/children-client.ts`). 연결의 첫 줄이 그것이
무엇인지 말한다. *제어* 연결(`{"op":"hello","protocol":1}`)은 호스트마다 하나이고, `{"rid":n,"op":…}` 요청과
`{"rid":n,"ok":…}` 답, 그리고 밀어 주는 이벤트 둘을 나른다: `{"event":"exit","id","code","signal"}`과
`{"event":"stop"}`(키퍼가 아주 멈춘다, 자식들을 멈춰라). *붙기* 연결(`{"op":"attach","protocol":1,"id","stream":"out"|"err"}`)은
한 줄로 답한 뒤 날 바이트를 나른다: 자식의 출력은 호스트로, 호스트의 바이트는 자식의 stdin이나 pty로.

| 요청 | 하는 일 |
|---|---|
| `spawn` `{kind:"pipes"\|"pty", cmd, args, cwd, env, cols?, rows?, tag}` | 자식을 자기 세션에서 띄운다. `cmd`는 `env`의 `PATH`에서 찾는다 |
| `list` | 모든 자식: id, 종류, pid, cmd, cwd, 시작, 살아 있는지, 종료 상태, 태그, 크기, 아직 보내지 않은 바이트 |
| `signal` `{id, signal, group?}` | 자식이나 그 그룹 전체에 신호. TERM/KILL/INT/HUP/QUIT/USR1/USR2/WINCH 밖의 이름은 거절하고, 이미 끝난 자식에는 아무것도 하지 않는다(그 pid는 남의 것일 수 있다) |
| `close_stdin` `{id}` | 쓴 것이 다 간 뒤 EOF (codex는 EOF에 스레드 잠금을 지운다, #57) |
| `resize` `{id, cols, rows}` | pty에 `TIOCSWINSZ` |
| `set_tag` `{id, tag}` / `release` `{id}` | 태그를 바꾼다. 끝난 자식을 잊는다(도는 자식은 거절) |

새 붙기는 그 스트림의 이전 독자를 대신한다. 붙기 연결을 반만 닫는 호스트는 떨어지는 중이다: 지금 있는 줄의 나머지를
받고, 스트림이 끝나며, 키퍼는 다음 호스트를 위해 버퍼에 담는다.

**버퍼** (`keeper/children/buffer.rs`). 에이전트의 stdout: 64 MiB까지 잃지 않고, 그 뒤로는 키퍼가 읽기를 멈춰
자식이 자기 파이프에서 기다린다. 독자에게는 온전한 줄만 가고, 사라진 독자가 일부만 받은 줄은 다음 독자에게 처음부터
다시 간다. pty: 언제나 비우고, 마지막 256 KiB를 쥐어 새 독자마다 다시 보낸다. 에이전트의 stderr: 256 KiB 꼬리,
결코 막지 않는다. 호스트의 바이트는 에이전트의 stdin에 온전한 줄로만 들어가므로, 쓰다 죽은 호스트가 찢어진 요청을
남기지 않는다. 키퍼는 8 MiB까지 쌓은 뒤 호스트를 읽지 않는다.

**호스트가 거기서 띄우는 것.** 자식마다 호스트만 읽는 태그가 붙는다(`keeper/tags.ts`): `{kind:"agent", tool,
sessionId, version?}`(띄운 CLI 버전, #297, §4.6), `{kind:"terminal", id, cwd}`, `{kind:"command", cwd, command, runId, startedAt}`. 새 호스트는 옛 호스트의
태그를 계속 읽을 수 있어야 한다: 자식은 자기를 띄운 빌드보다 오래 산다.

- **에이전트.** 매니저는 어댑터에 `ProcessSource`(`adapters/contract.ts`)를 넘긴다: 키퍼에서 `spawn`하거나, 쥐어 둔
  프로세스를 `adopt`한다. claude는 이것을 `spawnClaudeCodeProcess`로 받고, `CodexClient`는 띄우는 대신 그 프로세스를
  받는다. `KeeperAgentProcess`는 둘이 쓰는 `ChildProcess`의 표면을 갖지만, `kill()`은 키퍼에 보내는 요청이고 프로세스를
  놓았거나 호스트가 끝나는 중이면 결코 보내지 않는다(SDK는 주인이 끝날 때 자기 프로세스를 kill한다). `stdin.end()`는
  `close_stdin`이다. codex 요청 id에는 클라이언트마다 접두사가 붙어, 이전 호스트의 요청에 대한 답이 우리 요청을 풀지 못한다.
- **터미널과 명령.** `TerminalService`와 `CommandRunner`는 node-pty 대신 키퍼의 pty 모듈(`KeeperPty`, node-pty의 표면)을
  받는다. 멈출 때는 여전히 프로세스 트리를 걷는다(`kill-tree.ts`). 어디서든 통한다.

**떠나기** (`main.ts`, `stopServices(mode)`). *detach* — SIGTERM, SIGINT, 키퍼 파이프가 닫힘, 잡히지 않은 예외,
교체의 드레인 — 는 모든 세션 핸들·터미널·명령 실행에 `detach()`를 부른다: 도구에는 아무것도 보내지 않고, 기다리는
승인은 계속 기다리며, 오는 중이던 출력은 저장소가 닫히기 전에 기록한다. 앱 프로세스와 in-process 도구 서버는 호스트에
살므로 멈춘다. *stop* — 키퍼의 `stop` 이벤트, 또는 자식 서비스 없는 모든 끝 — 은 예전 경로다: 세션을 정리하고 터미널과
실행을 죽인다. stop 뒤에는 남은 것을 키퍼가 끝낸다(stdin EOF와 SIGHUP, 2초, 각 그룹에 TERM, 1초, KILL).

**다시 붙기.** 시작할 때 호스트가 키퍼의 자식 목록을 읽는다. 살아 있는 에이전트는 `listen` 뒤에 `resumeSession`을 거쳐
다시 붙는다. 그래서 같은 세션을 깨우는 화면은 두 번째 프로세스를 띄우지 않고 다시 붙기에 합류한다. 그 세션들은 시작 시
재설정에서도 `working` / `waiting_approval`을 지키고(`keptSessions`), 상태는 그 뒤 도구가 하는 말로 바로잡힌다.
대화록 따라잡기는 건너뛴다(그사이 한 말은 키퍼의 버퍼가 전한다). 세션이 사라진 에이전트는 멈춘다. 터미널과 명령 실행은
같은 id로 돌아오고, 다시 받은 출력이 스크롤백이 된다. 붙은 호스트가 없을 때 끝난 실행은 종료 코드를 지킨다. 끝난
에이전트나 터미널은 놓아준다. 기대기 전에 측정했다(2026-10-04, CLI 2.1.282 + SDK 0.3.263에 haiku, codex-cli 0.160.0에
`gpt-5.6-luna` 낮은 노력):

| 도구 | 측정 |
|---|---|
| claude | 쥐어 둔 프로세스 위의 새 `query()`: 그 `initialize`가 기다리던 승인을 새 `canUseTool`에 즉시 다시 전했고, 답하자 명령이 돌고 턴이 끝났다. 턴 도중이면 남은 Bash 호출 셋과 결과가 새 호스트를 통해 왔다. |
| codex | `initialize`를 다시: `-32600 "Already initialized"`, 그 밖에 바뀌는 것 없음. `thread/resume`: `thread.status`는 `active`/`waitingOnApproval`, 도는 턴은 `thread.turns`에(Stop에 필요한 id), 승인은 같은 요청 id(`0`)로 다시 왔고, 수락하자 턴이 끝났다. #342부터 resume은 턴을 달라고 하지 않고(`excludeTurns: true`), 도는 턴은 스레드가 `active`일 때만 `thread/turns/list`(`limit: 1`, 최신부터, `itemsView: 'notLoaded'`)로 묻는다. 0.160.0에서 다시 측정(2026-10-05): 턴은 `inProgress`로 왔고, 기다리던 승인은 여전히 같은 id로 다시 왔다. 이 플래그를 모르는 Codex는 턴을 실어 답하고, 그것을 예전처럼 읽는다. 스레드의 MCP 서버는 다시 띄우지 않는다(resume에 설정한 탐침 서버는 뜨지 않았다). 브리지가 정문의 주소와 토큰을 갖는 이유가 이것이다. |

**잃어버린 in-process 호출.** 호스트가 죽을 때 진행 중이던 호스트 자신의 in-process 도구 호출(오케스트레이터
`mcp__centralu__*`, 앱 프록시 `mcp__app-*`)은 결코 답을 받지 못한다: 측정해 보니 넘겨받은 claude는 새 주인이
`interrupt()`를 부를 때까지 조용히 기다렸고, 그러자 턴이 끝났다(`error_during_execution`). 다음 턴은, 이제 새 호스트가
섬기는 같은 도구 호출까지, 평소대로 돌았다. 그래서 매니저는 저장소에 결과 없이 남은 도구 호출을 어댑터에 넘기고, claude는
그 안에서 자기 in-process 도구를 찾으면 그 이름을 밝힌 오류를 내고 턴을 중단한다. 계획된 교체는 그런 호출을 먼저 드레인한다
(§4.2). 이것은 크래시를 위한 것이다. codex는 아무것도 필요 없다: 소켓이 닫힌 호출은 브리지가 실패시킨다.

**떠돌이.** `strays.ts` 규칙 3은 키퍼의 살아 있는 자식과 그 자손을 우리 것으로 센다. 키퍼 넘겨주기(§4.4) 뒤에는 그
부모가 init이고, 부모 사슬만 보면 남은 찌꺼기로 내놓게 된다.

**활동.** 넘겨받은 터미널·실행·살아 있는 세션은 다시 호스트 자신의 항목이므로 활동 보고는 전처럼 그것을 센다. 호스트가
없는 동안 키퍼는 아무것도 세지 않는다. 유휴 한도는 30분이고 죽은 호스트는 몇 초 안에 돌아온다.

`scripts/keeper-children-integration.mjs`가 실제 바이너리·호스트·claude(haiku)·codex(`gpt-5.6-luna`)로 이것을 돌린다:
SIGKILL당한 호스트를 넘는 claude 턴, 같은 크래시를 넘는 터미널과 개발 서버(그 뒤 크기 바꾸기), 교체를 넘는 codex 턴,
그리고 모든 자식을 끝내는 stop. CI는 `--no-claude --no-codex`로 돌린다(§4.1).

### 4.4 호스트에서 본 키퍼 넘겨주기 (#280, 옵션 C 4단계)

설계는 [architecture.ko.md](architecture.ko.md) §4.4에 있다. 호스트는 이를 위해 하는 일도, 알아채는 것도 없다: stdin과
stdout은 같은 파이프이고, `children.sock`의 제어·붙기 연결은 같은 소켓이며, 토큰과 정문 주소는 바뀌지 않고, 옛 키퍼가
끝나면 부모가 init이 된다. 얼어 있는 동안 stdout에 쓴 것(예를 들어 활동 보고)은 파이프에서 기다렸다가 새 키퍼가 읽는다.
옛 키퍼가 이미 읽었지만 처리하지 않은 것은 나머지와 함께 넘어간다. 교체가 쓰는 stdin의 제어 줄은 새 키퍼에게서도 그대로
통하고, 새 키퍼는 바꾸기의 시작으로 이 호스트를 비울 수 있다. 자식들도 그대로다: 떠나는 키퍼가 자식 표를 두 차례 사이에서
세우고 새 키퍼가 같은 버퍼에서 이어 가니, 도는 턴은 잃는 것도 되풀이하는 것도 없다.

`scripts/keeper-handoff-integration.mjs`가 세 빌드의 실제 바이너리, 실제 호스트, claude(haiku), codex(`gpt-5.6-luna`)로
이것을 돌린다: 각각 도구 호출 중인 턴과 세는 터미널·개발 서버를 둔 채의 넘겨주기, 커밋 전에 죽인 넘겨주기, 키퍼를 옮기고
이어서 호스트를 교체하는 바꾸기, 그리고 그 모든 과정을 넘는 앱 뷰와 창의 연결. CI는 `--no-claude --no-codex`로
돌린다(§4.1).

### 4.5 호스트에서 본 업데이트 적용 (#352)

설계는 [architecture.ko.md](architecture.ko.md) §4.5에 있다. 호스트의 몫은 설치와 규칙 하나다.

**설치** (`updates.ts`). `updates.apply`는 `npm i -g centralu@<v>`를 돌리고, 설치된 앱이 있으면 `centralu install`을
돌린 뒤 `restart_required`를 알린다. 아무것도 다시 띄우지 않는다. `autoApply`가 켜져 있으면("Apply updates
automatically when idle", `updates.setAutoApply`, 저장소의 앱 설정에 `updates.autoApply`로 저장, 기본 꺼짐) 새 버전을
찾은 확인이 같은 설치를 스스로 시작하고, 새 버전을 이미 아는 상태에서 설정을 켜면 바로 시작한다. 진행 중이거나 이미
끝난 설치 위에서는 하지 않는다: 그 뒤의 확인은 `restart_required`를 건드리지 않으므로 설치는 한 번이다. 실패한 설치는
그 버전을 다시 찾는 다음 확인, 곧 여섯 시간 뒤에 다시 시도된다.

**규칙** (`idle.ts`). `hostBusy(snapshot)`이 "지금 멈추면 누가 무엇을 잃는가"에 대한 유일한 답이다: 일하거나 승인 또는
질문을 기다리거나 활동으로 치는 백그라운드 작업(#290)을 돌리는 살아 있는 세션, 열린 터미널, 돌고 있는 프로젝트 명령.
턴이 끝난 세션(`waiting_input`, `turn_complete`가 다음 메시지까지 남기는 상태)은 한가하다: 답은 저장돼 있다.
2026-10-05까지는 이 상태를 바쁜 것으로 쳐서, 한 번이라도 답한 세션이 있으면 키퍼의 유휴 종료와 자동 적용이 기다렸다.
기다리는 질문은 이제 상태가 아니라 `pendingQuestions`로 친다. 스냅숏은 `main.ts`의 `activity()`이며, 기다리는 승인과
질문, 백그라운드 작업을 실은 매니저의 세션 목록을 쓴다. 키퍼는
활동 보고(§4.1)로 이것을 읽어 유휴 종료에 쓰고, 창은 키퍼의 view에서 받아 바꾸기의 질문과 한가할 때의 업데이트 적용에
쓴다. 열린 터미널은 프롬프트에 있어도 친다: 호스트는 한가한 셸과 명령을 돌리는 셸을 구별하지 못하므로, 자동 모드는
터미널이 닫히기를 기다린다. 세션 하나를 새로 설치된 에이전트 CLI로 옮기는 일(#297)은 같은 파일의 더 좁은 규칙
`sessionIdle`을 쓴다(§4.6).

**호스트가 보는 것.** 새로운 것은 없다: 다시 띄운 창은 같은 정문으로 다시 붙고, 키퍼가 스스로를 넘긴 뒤(§4.4)
바꾸기가 이 호스트를 비우고 새 빌드의 호스트를 띄운다(§4.2). 새 호스트의 업데이트 상태는 자기 버전에서 새로 시작한다.

### 4.6 새로 설치된 에이전트 CLI로 세션 옮기기 (#297)

세션마다 자기 에이전트 프로세스를 돌리고, 그 프로세스는 띄울 때 설치돼 있던 CLI로 뜬다. `claude`나 `codex`를
업데이트해도 세션에 닿는 것은 그 프로세스가 다시 뜰 때뿐이다. 키퍼 아래에서는(§4.3) 프로세스가 앱을 몇 번 다시
열어도 살아남으므로, Centralu를 매일 쓰는 사람은 오래된 CLI를 끝없이 돌릴 수 있다. `agent-versions.ts`는 양쪽을 다
알고, 세션 안에서 잃을 것이 없을 때 세션을 설치된 CLI로 다시 띄운다.

**설치된 버전** (`AgentAdapter.installedVersion`, `cli-version.ts`). 호스트가 뜰 때, 10분마다, 창이 포커스를 얻을 때
읽는다(`agents.versions { force: false }`, 30초 안의 읽기면 그것으로 답한다):

1. 명령이 실제로 돌리는 파일(`whichTool`, Windows 심이면 `launchFor`, 다음으로 심볼릭 링크의 대상) 옆의 npm
   `package.json`. 패키지 이름을 확인한다: `@anthropic-ai/claude-code`, `@openai/codex`. 프로세스는 뜨지 않는다.
   Windows에서는 이것만으로 읽는다: Claude는 `<data>\tools\claude\…` 아래 호스트 자신의 링크로 뜨고(§1, "Windows에서
   Claude 프로세스를 띄우는 방법"), 묻느라 npm의 `claude.exe`를 돌리면 npm 업데이트가 바꿔야 할 그 파일을 쥐게 된다.
2. 파일 이름 자체가 버전일 때 그 이름: Claude Code의 네이티브 설치기는 `claude`를
   `~/.local/share/claude/versions/<버전>`에 링크한다.
3. `<cli> --version`, Windows가 아닐 때만(Homebrew cask, 손으로 설치한 것).

**돌고 있는 버전**은 `SessionInfo.agentVersion`이다: 프로세스가 알린 것(`agent_version`, §2), 그리고 알리기 전까지는
띄울 때 설치돼 있던 버전. 키퍼에 띄울 때마다 그 버전을 자식의 태그에 적고(`{ kind: 'agent', tool, sessionId, version }`),
`adoptKept`가 그것을 세션에 돌려준다. 넘겨받은 프로세스는 다시 알리지 않기 때문이다. #297 이전 호스트가 쓴 태그에는
버전이 없다: 그 세션의 버전은 다음에 다시 뜰 때까지 모르는 채로 남고, 스스로 옮겨지지 않는다(모르는 것은 결코
"더 오래된 것"이 아니다, `runsOlderCli`). 마지막 읽기와 띄우기 사이에 업데이트가 끼면 태그는 더 오래된 버전을 적는다.
그러면 다음 호스트가 그 세션을 한 번 더 옮기며, 드는 것은 resume 한 번뿐이다.

**세션을 옮기는 때** (`restartDecision`): 살아 있고, 설치된 것보다 오래된 버전을 돌리고, `sessionIdle`로 idle이며(턴이
없고, 승인이나 질문이 없고, 살아 있는 백그라운드 작업이 없고, 백그라운드 작업을 알리지 못하는 도구는 결코 idle이
아니다), 스스로 옮길 때는 60초 동안 그 세션에서 아무것도 오지 않았을 때(호스트가 아직 들은 적 없는 세션은 호스트가
뜬 때부터 센다). 조용한 시간은 사람을 위한 것이다: 막 끝난 턴은 사람이 답을 읽고 다음 메시지를 쓰는 때다.
`sessionIdle`은 세션에 대해 `hostBusy`와 같은 사실을 읽되, 세션을 다시 띄워도 건드리지 않는 터미널과 명령은 빼고,
백그라운드 작업을 알리지 못하는 도구는 결코 idle로 치지 않는다.

| 결정 | 이유 |
|---|---|
| 스스로 옮기기는 기본으로 켜져 있다("Move idle sessions to a newly installed agent CLI", `agents.setAutoApplyVersions`, `agents.autoApplyVersions`로 저장) | 소유자의 결정(2026-10-05). 다시 띄우기는 잃을 것이 없을 때까지 기다리고, 대화는 resume으로 이어진다 |
| 헤더의 동작(`agents.applyVersions`)은 오래된 idle 세션을 조용한 시간 없이 한꺼번에 다시 띄운다 | 업데이트는 앱 전체의 일이다. 방금 업데이트한 사람은 모든 세션이 그것으로 가길 바란다. 바쁜 세션은 목록에 남고 그 줄을 계속 보인다 |
| 다시 띄우기는 매니저의 `restartSession`이다 | "Restart agent"와 같은 길: 핸들을 닫고(키퍼 아래에서는 키퍼를 통해 stdin을 닫은 뒤 신호를 보낸다), 세션은 새로 띄운 프로세스에서 resume한다. 다시 붙는 것은 없으므로 새 프로세스가 곧 새 CLI다(`sessions/agent-versions-restart.test.ts`) |
| 대화에 Centralu의 줄 하나가 들어간다: "Claude Code restarted on 2.1.290 (was 2.1.282). The conversation continues." | 스스로 다시 띄운 프로세스는 결코 조용하지 않다 |
| 마지막으로 본 설치 버전을 적어 둔다(`agents.versionsSeen`) | 앱이 닫혀 있는 동안 한 업데이트도 바뀐 것으로 친다 |

**능력 검사 자리** (#270). 설치된 CLI의 버전이 바뀔 때마다 서비스는 `capabilityCheck({ tool, from, to })`를 부른다.
#270은 버전이 바뀌면 도구가 못 하던 것에 대한 탐침을 다시 돌리자고 제안한다. 아직 구현한 것이 없으므로 기본값은
host.log에 그렇다는 줄 하나를 쓴다. 탐침은 여기에 꽂힌다.

## 5. dev-services (이름과 달리 prod 경로다 — 2026-08-15 정정)

M1.5에서 Node 사이드카가 배포 경로가 되면서, "Tauri 4단계에서 Rust로 옮기고 삭제한다"는 계획은
**보류되었다**. 이 디렉터리는 오늘날 prod에서 그대로 사용된다. 이름은 역사적 잔재다.

- **git**: `git` CLI spawn + `--porcelain=v2/-z` 파싱. status·diff·log·branches·checkout·stage·commit·push.
  git2(Rust)로의 이전은 **측정으로 병목이 확인되기 전까지는 하지 않는다** (m2-plan 결정 3).
  포트 인터페이스가 같으므로 나중에 옮겨도 UI는 변경되지 않는다.
- **store**: better-sqlite3 + `user_version` 마이그레이션 러너. 스키마 DDL은 정확히 한 곳,
  `protocol/src/schema/schema.sql`에만 있다. 번들에서는 빌드 산출물 옆에 복사되어 함께 배포된다 (F-0).
  마이그레이션 단계의 규칙은 아래(§5.1)에 있다.
- **fs**: lazy readdir 목록 + `git check-ignore` (디렉터리당 1회) + 경로 이탈 차단.
- **attachments**: 붙여넣은 이미지를 `~/.centralu/attachments/<sessionId>/`에 저장한다.
- `--dev-services` 플래그는 **존재하지 않는다** (문서가 앞서 나갔다). 모든 것이 항상 로드된다.

### 5.1 마이그레이션 단계: 먼저 넓히고, 나중에 줄인다 (#292)

빌드 둘이 `store.db` 하나를 만나는 일은 생각보다 잦다. 사람이 옛 릴리스로 되돌아가기도 하고, 호스트
교체(#280)는 다음 호스트가 뜨는 동안 이전 호스트가 계속 일하게 두다가 다음 호스트가 실패하면 이전 호스트에게
되돌려 준다. #292 전에는 옛 호스트가 새 스토어를 여는 것을 아무것도 막지 않았다. 모르는 단계는 모두 건너뛰고,
나중 단계가 지운 것을 건드릴 때에야 실패했다. 2026-10-04 측정: 처음 40단계(v2–v41, 7주) 중 v28(`sessions.archived`
삭제)과 v32(`projects.default_model` / `default_effort` 삭제)는 직전 빌드를 곧바로 깨뜨렸고, v13(그리드의 옛 이름 테이블
삭제)은 옛 `schema.sql`이 그 테이블을 빈 채로 다시 만들기 때문에 그리드 배치를 모두 조용히 잃게 했다.

규칙은 `dev-services/store.ts`의 단계 목록(`migrationSteps`) 위에 적혀 있고, 리뷰어는 새 단계를 이 규칙에 비추어 본다:

1. **넓히기.** 단계는 테이블, nullable이거나 기본값이 있는 열, 인덱스를 더하거나, 직전 빌드가 여전히 읽을 수 있는
   모양으로 데이터를 고쳐 쓸 수 있다. `breaksOlderReaders: false`를 선언한다.
2. **줄이기는 한 릴리스 뒤에.** 테이블·열·인덱스를 지우거나 이름을 바꾸는 단계, 또는 옛 빌드가 읽지 못하거나 조용히
   잃을 데이터를 남기는 단계는, 코드가 그것을 읽고 쓰기를 멈춘 다음 릴리스에 들어가며 `breaksOlderReaders: true`를
   선언한다. 옛 `schema.sql`이 만드는 것을 지우는 것도 여기에 든다 (v13).
3. **스토어는 자신을 아직 읽을 수 있는 가장 낮은 스키마 버전을 기록한다:** `app_settings`의 `min_reader_version` 행.
   깨뜨리는 단계는 실행되기 전에 이 값을 자기 버전으로 올린다. #292 이전의 스토어는 이미 실행한 단계로부터 한 번
   계산해 받는다(지금까지 마이그레이션된 모든 스토어는 32). 열 때 `schema.sql`이나 어떤 단계가 파일을 건드리기 전에,
   가장 새 단계가 이 기록보다 낮은 호스트는 시작을 거절한다: "This data was written by a newer Centralu"("이 데이터는
   더 새 Centralu가 썼다")와 두 버전을 stderr와 stdout에 내고 1로 끝난다. 락 충돌과 같은 길이다. 데스크톱 감독자는
   재시도하지 않고 곧바로 그 문장을 보여 준다. 스토어보다 오래되었지만 기록 이상인 호스트는 스토어를 열고, 자기가
   모르는 단계는 실행하지 않는다.
4. **무거운 단계는 `heavy: true`로 표시한다:** 모든 메시지를 고쳐 쓰거나 다시 색인하거나 `VACUUM`하는 단계(지금까지
   v3, v11, v21, v40; v40은 메시지 137,722개에서 시작을 1.9초 붙잡았다). 교체는 이 단계들을 전환 도중이 아니라
   전환 뒤에 돌린다.
5. **교체 중에는 (#280 3단계)** 넘겨받는 호스트가 확장 단계를 돌리고, 무거운 단계와 깨는 단계는 모두 `runDeferred`로
   미룬다. 이것은 준비 줄 바로 뒤, 정문이 이 호스트를 가리키고 바뀐 호스트가 완전히 사라진 다음에 부른다. 이전 빌드는
   넓혀진 저장소를 여전히 읽으므로, 준비되기 전에 실패한 새 호스트는 다시 이전 빌드로 바꿀 수 있다. 깨는 단계가 바로
   그것을 막는 것이다. `user_version`은 미룬 단계를 지나가고, 아직 남은 것은 `app_settings.deferred_migrations`가
   적는다: 먼저 죽은 호스트는 그것을 다음 열기에 남기고, 다음 열기가 제자리에서 돌린다. 그래서 무거운 단계와 깨는
   단계는 나중 단계 뒤에 돌아도 맞아야 하고, 그 단계를 싣는 빌드는 그 단계가 돌기 전에도 동작해야 한다(줄이기 단계는
   규칙 2로, 무거운 단계는 코드가 어느 쪽이든 읽는 데이터만 모양을 바꾸는 것으로 이를 지킨다).

| 단계 | 하는 일 | 옛 빌드 |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43 | 열 추가 | 읽는다 (39: 휴지통의 세션을 살아 있는 세션으로 보여 준다; 43: 이전 host의 `grid.set`은 크기를 쓰지 않으므로 앱 패널이 기본값으로 돌아간다, #306) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42 | 테이블 추가 (3은 색인도 채운다: 무거움; 42는 그리드의 세션 줄을 `grid_layout`에 한 번 옮겨 적고 `grid_panels`는 그대로 둔다, #288) | 읽는다 (42: 이전 host는 그리드를 `grid_panels`에 두므로, 두 빌드의 그리드가 달라질 수 있다) |
| 10, 11, 40 | 같은 모양으로 다시 짓기 (10: `project_id`를 nullable로 한 `sessions`; 11과 40: 색인 후 `VACUUM`: 무거움) | 읽는다 |
| 21, 26, 29, 35 | 한 방향 데이터 고쳐 쓰기 (21은 모든 메시지를 고쳐 쓴다: 무거움) | 읽는다, 되돌릴 수 없다 |
| **13, 28, 32** | **테이블이나 열 삭제** | **깨진다: `min_reader_version`을 올린다** |

## 6. 사용량과 한도 (FR-9)

**도구에게 묻는다. 도구의 파일을 읽지 않는다.** `agents.usage` → `SessionManager.usageFor(tool)`
→ 어댑터의 선택 메서드 `listUsage()`이고, 그 안에서 도구 자신의 API를 부른다 (한쪽은 Claude
SDK, 다른 쪽은 `app-server`). 답하지 못하는 어댑터는 던지고, 매니저가 이유를 달아 degrade한다 —
자신 있게 틀린 숫자를 보여주는 것보다 낫다.

사용량은 세션도 디렉토리도 아닌 **계정**의 성질이라 `listUsage()`에는 인자가 없다 — 어느
폴더에서 묻든 답이 같다. 다루는 것은 구독 한도뿐이고, 추가 결제(크레딧)는 범위 밖이다.

이 절은 원래 전혀 다른 것을 적고 있었다: chokidar로 `~/.claude/projects/**`와
`~/.codex/sessions/**`를 감시하며 증분 파싱하고, `usage_facts` 행을 써서 `usage.weekly` RPC로
읽고, 집계는 `core/usage`에서 한다는 설계. **그중 어느 것도 존재하지 않는다** — chokidar는
의존성이 아니고, `core/usage`라는 디렉토리는 없고, `usage.weekly` 메서드도 없으며,
`usage_facts`는 `schema.sql`에 남아 있지만 읽거나 쓰는 코드가 없다. 게다가 그것은 §8.1이
말하는 규칙의 **정반대**였고, 두 절이 이 문서 안에서 서로를 부정한 채 나란히 있었다. 도구의
비공개 JSONL을 읽는 것이 바로 §8.1이 금지하는 일이고, 이유도 거기 적혀 있다: 문서화되지 않은
포맷은 업그레이드에서 소리 없이 깨지며, 숫자가 조용히 깨지는 것은 숫자가 없는 것보다 나쁘다.

## 8. 이전 세션 가져오기 (외부 세션)

Centralu 밖에서 — 터미널에서 — 시작한 대화를 이어받는 경로다.
세션 생성 모달의 `+ → 도구 선택 → 이전 대화 목록`이 이 기능의 입구다.

### 8.1 원칙: 공식 API만 사용한다

두 도구 모두 트랜스크립트를 디스크에 남긴다
(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`).
**우리는 그 파일을 직접 파싱하지 않는다.** 그 포맷은 문서화된 계약이 아니어서
도구가 업그레이드되면 소리 없이 깨지고, 깨진 줄도 모른 채 엉뚱한 대화를 보여주게 된다.

| | 목록 | 대화 읽기 |
|---|---|---|
| Claude Code | SDK `listSessions({ dir })` | SDK `getSessionMessages(id, { dir })` |
| Codex | app-server `thread/list { cwd }` | app-server `thread/turns/list { threadId, sortDirection: 'desc', itemsView: 'full' }`를 쪽마다. 그것이 없는 Codex에서는 `thread/read { threadId, includeTurns }` |

버전 호환의 책임은 도구 쪽에 있다 — 각 API는 자기 버전이 쓴 저장 포맷을 스스로 읽는다.
우리가 유지해야 하는 것은 **응답을 대화로 변환하는 부분**뿐이며, 그 변환은 도구를 띄우지 않고도
검증할 수 있도록 순수 함수로 분리되어 있다 (`adapters/history.test.ts`).

**Codex의 기록은 최신부터 쪽으로 나눠 읽는다** ([#342](https://github.com/ijun17/centralu/issues/342)). Codex 0.160.0은
paginated 스레드의 전체 기록 불러오기를 지원 중단하고, 그것을 대화까지 닿은 `deprecationNotice`로 알린다. 임시 스레드에서
측정(gpt-5.6-luna, 2026-10-05, 긴 명령 출력이 있는 19턴):

| 요청 | 답 | 알림 |
|---|---|---|
| `thread/resume` (전체 기록) | 한 줄에 7,260 KB | "Full-history hydration is deprecated…" |
| `thread/resume { excludeTurns: true }` | 1.9 KB | 없음 |
| `thread/fork` (전체 기록) / `{ excludeTurns: true }` | 7,260 KB / 1.3 KB | 알림 / 없음 |
| `thread/read { includeTurns: true }` | 한 줄에 7,260 KB | "Full-history hydration is deprecated…" |
| `thread/turns/list`, 한 쪽에 다섯 턴, `full` | 마지막 4줄에는 최신 한 쪽만 | 없음 |

| 결정 | 이유 |
|---|---|
| `excludeTurns: true`로 재개한다 | resume이 돌려준 기록을 읽는 곳은 도는 턴의 id뿐이고, 그것은 한 턴짜리 질의로 따로 묻는다. 한 스레드의 답은 23 MB였다(`architecture.md` §4) |
| `thread/turns/list`를 최신부터 넘기다 줄이 모이면 멈춘다 | 긴 스레드를 가져오거나(200줄) 따라잡을 때(600줄) 전부가 아니라 끝부분만 읽는다. 줄은 `thread/read`가 주던 것과 같아서, 따라잡기는 여전히 우리의 마지막 메시지를 찾아 그 뒤만 붙인다 |
| `summary`가 아니라 `itemsView: 'full'` | 측정해 보니 `summary`는 턴의 사용자 메시지와 최종 답을 약 0.2%의 바이트로 주지만 `contextCompaction` 항목을 뺀다(수동 압축의 턴이 비어서 왔다). 압축 줄은 #303의 것이다. 한 쪽은 여전히 그 턴들의 명령 출력만큼 크다 |
| `thread/turns/list`가 없는 Codex는 예전처럼 스레드 전체를 읽는다 | `-32601`로 답한다. 지원 중단 알림은 paginated 스레드에만 붙고, 옛 버전에는 없다 |
| 계약은 되읽는 필드와 보내는 enum 단어도 확인한다 | 이름이 바뀐 `nextCursor`나 `inProgress`는 요청을 실패시키지 않고 없는 것으로 읽힌다. 그러면 첫 쪽 뒤의 모든 쪽이나 재개 뒤의 도는 턴이 소리 없이 사라진다(`codex-bindings.mjs`) |

### 8.2 구버전 도구와의 호환

목록을 가져오지 못하는 것과 세션을 만들지 못하는 것은 다른 문제다.
**구버전 도구를 쓴다고 해서 새 세션 생성까지 막히지는 않는다.**

- Claude: dynamic import + 함수 존재 확인. 없으면 모듈 로드가 터지는 대신 '미지원'으로 처리한다.
- Codex: `thread/list`를 모르는 서버는 JSON-RPC `-32601`을 반환한다.
  이는 예외가 아니라 정상적인 협상 결과로 취급하고, 사유를 위로 전달한다.
  단, 진짜 장애(`EACCES` 등)는 '미지원' 뒤에 숨기지 않는다 — 원인이 보여야 한다.

그래서 `agents.listExternalSessions`는 throw하지 않고 `{ supported, reason?, sessions }`를 반환한다.
UI는 `supported: false`를 에러가 아니라 안내로 그린다.

### 8.3 대화 정리

두 도구 모두 사용자 턴에 자체 시스템 텍스트를 주입한다
(`<system-reminder>`, `<ide_opened_file>`, `<system_instruction>`, 슬래시 명령의 흔적).
실제로 목록 제목이 `<system_instruction>You are working inside…`로,
첫 대화가 `<ide_opened_file>…`로 나온 적이 있다.

`adapters/history-text.ts`는 이런 블록만 제거한다 — 전체를 버리지는 않는데,
주입된 블록 뒤에 진짜 사용자 발화가 이어지는 경우가 많기 때문이다.
제거하고 나서 아무것도 남지 않을 때만 그 줄을 버린다.
도구 호출과 결과는 이름만 남기고 버린다: 가져오기의 목적은 대화를 되찾는 것이지,
실행 로그를 되살리는 것이 아니다.

**도구가 압축한 자리는 남긴다** ([#303](https://github.com/ijun17/centralu/issues/303)). Codex의 기록(지금은 full 항목의
`thread/turns/list`, #342 전에는 `thread/read`)은
압축 하나하나를 그것이 돈 턴 안의 `{ type: 'contextCompaction', id }` 항목으로 돌려준다 — `/compact`는 자기만의
턴으로, 자동 압축은 사용자 메시지 앞에 (codex-cli 0.147.0, 0.153.4, 0.160.0에서 측정,
`scripts/probe-codex-compaction.mts`). 읽는 쪽은 이것을 압축 줄(`role: 'system', marker: 'compaction'`인
`HistoryMessage`)로 바꾸고, 호스트는 그것을 실시간 `compaction` 이벤트가 남기는 것과 똑같은 행(kind `marker`,
이벤트 자체가 payload)으로 저장한다. 그래서 화면도 인계 기준점(pivot)도 다시 읽은 압축과 실시간으로 본 압축을
구별하지 못한다. 한 번만 저장한다: 따라잡기는 우리 마지막 메시지 바로 뒤의 압축 줄을, 우리 기록이 그 자리에 이미
가진 수만큼 건너뛰고(이 호스트가 실시간으로 본 압축은 양쪽에 다 있다) 나머지를 붙인다. Claude 쪽 읽기는
`getSessionMessages`에서 사용자·어시스턴트 메시지만 남기므로, 가져온 Claude 대화에는 여전히 마커가 없다.

### 8.4 가져온 세션의 정체성

- 도구에는 `resume`을 보낸다 → 모델의 실제 컨텍스트가 이어진다.
- 화면은 마지막 `HISTORY_LIMIT`(200)줄을 복원한다 → 이것은 **표시용 스냅샷**이다.
- 복원된 대화는 `lastReadSeq = lastSeq`로 표시한다. 이미 읽은 대화 때문에 사람을 부르지 않는다.
- 어떤 대화를 이어받았는지는 `sessions.imported_from`(schema v5)에 기록한다.
  `external_id`로는 알 수 없다 — 도구가 resume 시 **새 식별자를 발급**해서
  원본과 달라질 수 있고, 그 순간 목록의 '이미 가져옴' 표시가 매번 틀리게 된다.
- 기록을 읽지 못해도 세션은 살아 있다. 기록을 못 읽었다는 이유로 대화까지 막을 이유는 없다.
