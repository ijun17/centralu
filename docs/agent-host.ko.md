# Agent Host — Node 사이드카 설계

> 영어 원본: [agent-host.md](agent-host.md) — 설계가 바뀌면 두 문서를 같은 PR에서 함께 갱신한다.

독립 실행되는 Node 프로세스다. dev에서는 개발자가 직접 띄우고(`pnpm host`), 패키지된 앱에서는 키퍼(`centralu-keeper`, §4.1)가, `pnpm app:dev`에서는 Tauri 앱이 spawn하고 감시한다. **UI가 있든 없든 동일하게 동작해야 한다** — UI는 여러 번 닫혔다 다시 열릴 수 있고(재연결), 그동안 호스트는 세션을 계속 유지한다.

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
순수한 규칙 하나가 정한다(`sessions/tool-profiles.ts`의 `toolProfileFor`: 행의 종류, 앱과 빌더
자리, 설정 스위치로부터. `toolBundleFor`는 프로필마다 뒤에 서는 객체를 댄다). 매니저는 그 규칙에 한
곳에서 묻는다(`toolChoice`: 프로필, 그리고 어댑터 옵션을 만들 때 함께 만드는 묶음). 생성, 깨울 때마다,
다리 호출마다, `toolProfileOf`가 모두 이것을 쓴다. 그래서 서로 어긋날 수 없다. 오케스트레이터, 코디네이터,
읽기 세션의 객체는 함수 하나(`sessions/orchestrator-seat.ts`의 `orchestratorToolsFor`)가 만들고, 이 함수는
매니저를 좁게 보여 주는 `OrchestratorSeatHost`만 받는다. 묶음이
무엇을 노출하는지와 그 호출이 무엇을 실행할 수 있는지는 둘 다 `profileAllows`가 정하므로,
묶음에 없는 이름은 Codex 다리를 거쳐도 거절된다.

| 프로필 | 누구 | 시야 | 도구 | 지침 |
|---|---|---|---|---|
| `orchestrator` | 하나뿐인 오케스트레이터 | 모든 세션 | 빌더 전용을 뺀 전부 | 역할과 사용법 |
| `scoped` | 코디네이터(#80). 관제 앱의 작업만 만들었고, 그것은 만들던 RPC와 함께 #372에서 걷어냈다. 저장소에 있는 것은 이 프로필로 깨어난다 | 자기 멤버 | 목록, 읽기, 보내기 | 자기 경계 |
| `builder` | 앱을 만드는 세션 (M4 C-3) | 자기 앱 | `check` | 만들고 검사하기 |
| `reader` | 프로젝트에 속한 그 밖의 모든 세션 (#320), 예전 워크트리 매니저 포함 | 자기 프로젝트, 호출할 때 읽음. 자기가 띄운 에이전트에 손을 댄다 | `read_session`(id 없으면 목록), `recall`, `app_guide`; `ask_project`(#371, §1.2); `start_agent`, `agent_session`(#561, §1.2.1). 그리고 `find_apps`, `attach_app`, `detach_app`(#371 A, apps.md §9.4) | 사람이 달리 말하지 않는 한 Centralu의 도구를 먼저 (#564) |

지침은 두 CLI 모두에서 모델에 닿지만, 들어가는 문이 다르다. Claude는 프로세스 안 서버의 `instructions`로
받는다. codex-cli 0.160.0은 서버의 지침을 어떤 모델에게도 보여 주지 않으므로(#525,
`scripts/probe-codex-mcp-instructions.mts`로 잼), Codex 다리는 지침을 보내지 않고 같은 글이 스레드의 개발자
지침에 자리의 역할 뒤, 한 줄 머리말 아래로 실린다. Codex는 그것을 `thread/start`에서만 읽고 `thread/resume`에서는
무시하므로, Codex 스레드는 시작할 때 받은 지침을 그대로 지닌다. 스레드가 살아 있는 채로 프로필이 바뀐 세션은
새 스레드를 시작할 때까지 새 도구를 지침 없이 가진다.

**워크트리 매니저**(`manager`, #69/#76)는 평범한 세션에 접혀 들어갔다(#561 3부, 소유자 2026-10-12). 프로젝트마다
하나씩 워크트리 세션을 지켜보고, 새 세션을 제안하고(`propose_worktree_session`, 만드는 건 사람), 병합된 것을 엄격한
관문 뒤에서 지우던(`delete_worktree_session`) 자리였다. 이제 세션이 직접 워크트리 에이전트를 띄우고(`start_agent`의
`worktree`, §1.2.1), 다루고(`agent_session`), 병합되고 깨끗한 것을 같은 관문 뒤에서 `agent_session` `delete`로
치운다(`sessions/worktree-sessions.ts`의 `cleanUpWorktreeChild`). 남은 것: 사람이 만드는 워크트리 세션(새 세션 창의 선택. 이제 매니저 밑이 아니라
홀로 선다), 모든 워크트리 세션의 병합·PR 감지, 프로젝트의 줄기(`worktrees.setTrunk`, 프로젝트 메뉴의 "Worktree
trunk", 예전 자리의 줄에 보관). 오케스트레이터에는 `propose_worktree_session`을 대신할 것을 주지 않는다: 사람의
저장소에 가지와 폴더를 만드는 일은 이제 프로젝트 세션의 동의 카드를 거치고, 오케스트레이터는 `send_to_session`으로 그
세션에 닿는다. 기존 데이터: 스토어 v48이 예전 매니저의 워크트리 세션에 `askedBy` = 부모를 주어, 매니저가 그것들을
자기가 띄운 에이전트로 가진다. `worktrees.createManager`는 이유와 함께 거절되고(옛 창을 위해 프로토콜에는 남는다),
자리의 열은 나중의 축소 단계까지 남는다.

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
(#564가 이 묶음에 392자의 지시문을 주기 전까지 1,000, 그 뒤로 1,400. 묶음은 1,375자)를 넘으면 실패한다.

앱 붙이기 도구(#371 A: `find_apps`, `attach_app`, `detach_app`, apps.md §9.4)는 같은 서버에 자기 한도
`APP_ACCESS_BUDGET_CHARS`(900. 지금 874)로 실린다. 어느 묶음도 다른 쪽의 여유로 자라지 않게 하려는 것이다.
Claude는 셋 다 미루며, 그 값은 요청마다 +31 토큰이다(같은 측정, 2026-10-05, `ask_project`가 들어오기 전 #320 묶음에서 잼: +192에서 +223). 올려
두면 +263을 더한다. Codex 세션이 그만큼 낸다. 모델은 찾았다: 새 haiku 세션 5번 중 5번이 평범한 요청에서
도구 검색으로 `find_apps`를 찾았다(apps.md §9.4). 다른 길이 열려 있지 않을 때였다.

#522부터 Claude는 `find_apps`를 올려 두고 나머지 둘을 미룬다. 옆에 `ask_project`가 올라와 있으니, 다른 프로젝트의
앱을 묻는 질문은 `ask_project`로(또는 세션 읽기로) 갔고 도구 검색으로는 한 번도 가지 않았다: 10번 중 0번 `attach_app`에
이르렀다. 올려 두고 `ask_project`의 설명 끝을 "For another project's apps, use find_apps."로 하니 10번 중 9번(다시 잰
10번 중 8번)이 이르렀고, 평범한 Claude 요청마다 +86 토큰이 든다(정의 +75, 가리킴 +11: 326 → 412). 변형들과 그
숫자는 [tool-cost.md](tool-cost.md) §8에 있다. #523은 `app_guide`의 `topic`을 일곱 주제의 enum으로 바꿨다(그것으로
읽기 묶음은 983자다).

**다시 재기**(#513). `pnpm measure:tools`가 모든 프로필을 두 CLI에서 같은 방식으로, 되풀이할 수 있게
잰다: 상주 토큰(API의 사용량, 그리고 Centralu 도구를 넣고 뺀 `count_tokens`), 요청마다의 캐시 읽기·쓰기와
재구축을 일으킨 사건, 고정 프롬프트 묶음에서의 도구 선택과 첫 시도 인자 유효성, 긴 세션에서 도구 결과가
더하는 양. `orchestrator-tools.test.ts`는 프로필마다 상주 문자 수(`RESIDENT_BUDGET_CHARS`)를,
`adapters/claude/tool-prefix.test.ts`는 앱을 붙이고 떼도 Claude 세션의 도구 목록이 바뀌지 않음을 고정한다.
돌리는 법·읽는 법과 기준선: [tool-cost.md](tool-cost.md)(영어만). 그 기준선(2026-10-12)에서 Codex는 더 이상
MCP 도구를 요청에 미리 싣지 않았다: codex-cli 0.160.0은 자기 `exec` 도구 안에서 그 도구들에 닿는다. 그래서
위의 "Codex에는 미루기가 없다"는 위 숫자를 잰 CLI의 이야기다.

**오케스트레이터의 드문 명령**(#512, `CC_RARE_COMMANDS`, 2026-10-12부터 기본은 명령 층). `create_app`,
`propose_skill`, `propose_mcp_server`는 오케스트레이터가 싣는 것의 3분의 1이면서 가장 적게 부르는 것이다. 기본값(`CC_RARE_COMMANDS`를 두지 않거나
`commands`)에서 호스트는 이들을 도구 목록에서 빼고 그 자리에 고정 도구 셋을 준다: `centralu_commands`(한 줄씩), `centralu_help`(명령 하나의 스키마), `centralu_run`(호스트가 그 스키마로
엄격하게 확인하고, 틀린 호출에는 스키마로 답한다). 지시문에는 이들이 있다는 한 줄이 붙는다. 프로필 규칙은
같다(`commandsFor`는 `profileAllows`가 그 자리에 준 것만 보여 주고 실행한다). 실행은 같은 실행기를 지나므로
명령마다 결과와 카드가 그대로다. `propose_worktree_session`은 처음에 이 층에 있다가 빠졌다: 지시문 어디에도
그 이름이 없어서, 숨겨 두자 한 번도 닿지 않았다. `app_guide`는 도구로 남는다: 사람이 앱에 대해 묻는 일은 예고 없이 오고,
미뤄 두면 덜 찾았다(tool-cost.md §8). 설정은 시작할 때 한 번 읽는다: 세션의 도구 목록이 곧 프롬프트
앞부분이기 때문이다. 나머지 둘은 측정용으로 남는다: `CC_RARE_COMMANDS=resident`는 예전처럼 모든 명령을
도구로 주고, `CC_RARE_COMMANDS=deferred`는 셋을 Claude의 도구 검색 뒤로 미룬다(그때 서버는 읽기 묶음처럼
도구마다 올린다). 세 갈래의 비교는 [tool-cost.md](tool-cost.md) §9(영어만)에 있다. Sonnet에서 이 층은 잃은 것이
없었고(드문 명령에 모두 닿았고, 첫 인자가 모두 맞았으며, 영어와 한국어 모두) 요청마다 835토큰을 아꼈다.
haiku에서는 709토큰을 아꼈고 드문 명령에 덜 닿았다(24번 중 15번, 상주는 23번). 소유자는 Sonnet의 숫자와,
명령이 늘어도 오케스트레이터의 상주 앞부분이 자라지 않는다는 점을 보고 이 층을 기본으로 정했다(2026-10-12 결정,
#512): 오케스트레이터가 싣는 것은 11,862자에서 9,317자가 되었고, 그 상한(`RESIDENT_BUDGET_CHARS`)은 12,000에서
9,500이 되었다.
**Centralu의 기능을 먼저**(#564, 2026-10-12 소유자 결정, product-spec.md §1.2): 사람이 달리 말하지 않는 한,
Centralu 안에서 도는 에이전트는 Centralu의 기능을 먼저 쓴다. 두 자리가 이것을 싣는다. 오케스트레이터의 역할은 그렇게
말하는 머리말로 시작한다(`orchestratorRole`. 명령 층이 있는 자리에서는 `centralu_commands`를 이름으로 부른다). 이
머리말은 tool-cost.md §9의 2차 측정에서 요청마다 33~55토큰이 들었고 퇴행도, 유지된 이득도 없었으며, #564부터 기본으로
켜진다. 역할이 없는 일반 세션은 같은 규칙을 도구의 지시문으로 받는다(`READER_INSTRUCTIONS`): 어떤 필요에 어떤 도구인지를
말하는 한 문장이다(`READER_FIRST`: 예전 대화는 `recall`, 이 프로젝트의 다른 세션은 `read_session`, 다른 프로젝트의 일은
`ask_project`, 다른 프로젝트의 앱은 `find_apps`, 그리고 오래 걸리는 일, 다른 CLI나 워크트리에서 할 일, 사람이
지켜보거나 이어 갈 일은 CLI 자신의 Agent 도구가 아니라 `start_agent`. 턴 안의 짧은 보조 일은 CLI 자신의 서브에이전트가
맡는다: 2026-10-12 소유자 결정). 일반 세션 묶음에 들어오면서 사람이 말로 하는 필요에 답하는 도구는
거기에 한 줄을 더한다. #564 전에는 일반 세션 묶음에 지시문이 없었다: Centralu는 사람의 세션에 도구를 내줄 뿐 그
세션을 지휘하지 않는다는 원칙 때문이었고, 소유자가 그 원칙을 거두었다. `CC_ORCHESTRATOR_PREAMBLE=0`과
`CC_READER_INSTRUCTIONS=0`(시작할 때 한 번 읽는다)은 각각을 끈다: 없을 때와 견주어 재기 위한 것이다. 드는 값과
바뀌는 것: [tool-cost.md](tool-cost.md) §11(영어만).

묶음을 받은 Codex 세션은 stdio 다리를 띄우므로, #320 이후 모든 Codex 세션이 node 프로세스를
하나 더 띄운다(유휴 시 상주 메모리 약 40 MB). 다리는 `default_tools_approval_mode: 'approve'`를
건다: 우리 도구는 Claude 쪽처럼 묻지 않으며, 이것이 없으면 auto(`approvalPolicy: never`)의
Codex가 모든 호출을 스스로 거절했다. `scripts/smoke-reader.mts`가 실제 모델로 처음부터 끝까지
돌린다(Codex는 `TOOL=codex`).

### 1.2 다른 프로젝트에 맡기기 (`ask_project`, #371 B)

The one reach an ordinary session has outside its project. `ask_project({ project, session?, task? })`
gives a task to an **existing ordinary session** in another registered project and returns its answer.
It never creates a session in another project (#614, owner decision 2026-10-13). Creation remains the
person's action in that project; `start_agent` creates only within its caller's own project. The global
orchestrator, which belongs to no project, retains its own create-session tool.

호출 한 번이 하는 일(`SessionManager.askProject`, 실제로는 `sessions/ask-project-flow.ts`의 `AskProjectFlow`, #428):

1. **The project.** Name or id of another registered project. Its own project is refused; an unknown
   name lists the other projects. Under `safe`/`normal`, an untrusted caller cannot ask, and a child
   started by another session or a session currently handling a cross-project task cannot delegate
   again (depth one). Under `auto` (#603), the caller's own preset opens and logs those boundaries.
2. **The session.** `session` names an ordinary session by name or id. Orchestrators, builders and
   app agents are excluded. Without it, exactly one ordinary session is selected; otherwise the call
   lists the candidates with id, name, state and last activity and asks the caller to name one.
   Duplicate names require an id. No ordinary session means a refusal telling the person to open
   one there. Selection never creates, renames or takes ownership of a session, and the task's
   text never auto-names a "New session" (#646): only the person's own words do, as with an app's
   message. Old `Asked by <project> · HH:MM` sessions remain ordinary sessions; startup removes
   their former cross-project `askedBy` mark, retaining their name and history.
3. **Consent.** `ensureProjectAccess` (`delegate`) raises a card in the caller's session naming
   `<caller project> asks <project> / <session>` and the task. Allow once, always for this project
   pair, or deny; only always is stored in `project_consents` and revoked in Settings → Permissions.
   The card states the target's trust, including in conversation and notification text. Under `auto`
   the card is skipped and logged without saving consent. The selected session keeps its own tool,
   model, effort, preset, project trust and approvals. Availability, the caller's trust and depth, and the target
   project are checked again after consent (`askGateError`). The caller's project losing trust or being removed, or
   the target project being removed, withdraws a card still standing (`withdrawReaches`).
4. **Delivery.** The task travels in `askFrame`, explaining the caller and how the answer comes
   back, and appears in the target conversation with `from` identifying the asking session. An idle
   session resumes as needed. A session busy with a turn that is not the caller's (the person's,
   another delegation, or requests queued ahead) returns the choices instead (§1.2.3, #677): the
   caller passes `ifBusy` `note` (an `auto` caller only, through the adapter's tracked mid-turn input
   path, #594, on a CLI that takes it, and never into another caller's delegation) or `queue`; no
   fork across projects. No interrupt or CLI-specific logic is added to the manager, and another
   delegation's watcher is never replaced. `AgentRunWait` holds until the delivered input's receipt completes,
   even if the CLI queues it into a later turn; an earlier turn's answer cannot finish this call.
5. **The answer.** Final text is JSON-quoted as another session's words and clipped after 6,000
   characters. Named files and folders inside the target project, resolved through symlinks, become
   readable to the caller for this host's lifetime (`readGrants`); the project root is never granted.
   Outside paths are listed without grants. Claude checks grants on each read through `mayRead`;
   Codex's reads are already unrestricted.

**Long work.** A call waits up to `ASK_WAIT_MS` (240 s), below the Codex MCP ceiling of 300 s and
bridge wait of 280 s. It then answers still working, naming the session and how to call again with
`project`, `session` and no task. Without `session`, one outstanding call in that project is enough
to continue waiting, even if another session was opened meanwhile. Multiple outstanding tasks need
an explicit session. A new task cannot replace unfinished work in the same session.

**Stop.** Stop on the caller reaches delegated work only while that caller is actually waiting
(`waiters > 0`), as for `start_agent`; after a bounded call returns still working, the target keeps
running. If the task joined an already-running turn, Stop or call cancellation ends only the caller's
wait and never interrupts the person's turn. Its receipt watcher, other observers and report-back
continue until the input finishes. A task assigned to an idle target can still be interrupted while
the caller waits. An explicit Stop on the target remains available. A failed turn or deleting the
target returns an error naming the session. Deleting the caller drops the wait and grants while the
target keeps its turn. Tracked notes cannot report an intermediate turn's completion.

**Size.** Historical baseline before the optional session selector (#614). 읽기 묶음과 같은 방식으로 쟀다(haiku, `scripts/probe-reader-tools.mts`): `ask_project`는 350자
(`DELEGATE_BUDGET_CHARS` 400)이고 로드하면 **+103토큰**(묶음: +192 → +295), 미루면 +10이다. 로드한다: "Have the toolkit
project export the sprites again, then tell me where the files are"에 로드하면 10번 중 7번 그 프로젝트로 불렀고, 미루면
5번 중 0번 — 지난 대화와 자기 폴더를 뒤졌다. #320이 `recall`에서 잰 실패와 같다. 놓친 경우는 그런 프로젝트가 없다는 답이고,
사람이 도구를 이름으로 부를 수 있다. 상관없는 사용법 질문 다섯 중 하나가 없는 프로젝트를 대서 불렀다(거절, 카드 없음).
설명은 "a task"가 아니라 "a job"이라 쓴다: 모델에게는 같게 읽히고(각각 10번 중 7번), 모든 자리의 도구를 나열하는 안내서에
없어진 컨트롤 레일의 task라는 말이 남지 않게 한다(#372). 다른 문구 두 가지는 낫지 않았다(5번 중 0, 3).

`packages/agent-host/scripts/smoke-ask-project.mts`가 임시 스토어와 데이터 폴더에서 처음부터 끝까지 돌린다: 한 임시 프로젝트의 haiku 세션이 다른
프로젝트에 자기만 아는 숫자를 쓴 파일을 만들게 하고 그 파일을 읽어 온다(`CALLER`/`CALLEE` = `claude` 또는 `codex`).

### 1.2.1 같은 프로젝트에서 다른 에이전트 띄우기 (`start_agent`, `agent_session`, #561)

평범한 세션이 자기 프로젝트 안에서 다른 에이전트(Claude나 Codex)를 띄워 일을 맡길 수 있다. Claude 세션이 구현을
Codex에 넘기고 결과만 검토하는 식이다. 앱이 보여 주지 않는 셸의 `codex exec` 대신이다. ask_project의 기계
(`Delegation`, `AgentRunWait`, `ASK_WAIT_MS`, `finalAnswer`) 위에 지었고, reader 묶음 안에 자기 예산을 가진다
(`AGENT_TOOLS`, `AGENT_BUDGET_CHARS`).

| 도구 | 인자 → 돌아오는 것 |
|---|---|
| `start_agent` | `{ task, tool?: string, model?, effort?, difficulty?: light\|standard\|heavy, wait?, worktree?, branch?, lsp? }` → 자식의 id와 이름, 그리고 답(`done`) 또는 `working`. 사람의 카드가 서 있는 동안에는 요청 핸들과 함께 `pending`(#673), 허락된 시작이 메모리를 기다리는 동안에는 `lowMemory`가 붙은 `pending`(§1.2.4, #686). `lsp: true`는 자식의 코드 인텔리전스를 켠 채로 둔다(§1.2.4) |
| `agent_session` | `{ sessionId, action: status\|send\|wait\|stop\|delete\|answer, text?, card?, ifBusy? }` → 같은 상태들, 더해서 `at_rest`(부른 세션이 준 일이 돌지 않음, 마지막 답), `asking`과 `answered`(부른 세션이 준 턴의 카드, §1.2.2, #676), `busy`와 `queued`(부른 세션의 턴이 아닌 턴으로 바쁜 세션에 보낸 것, §1.2.3, #677), `stopped`, `deleted`(병합되고 깨끗한 워크트리 자식을 치움, 3부) |

선택 인자 `tool`은 레지스트리 이름이다. 스키마는 문자열을 받고, 호출할 때 현재 레지스트리에
있는지 확인한다. 모르는 이름이면 설치된 도구 목록을 담은 오류를 반환하므로, 어댑터를 추가해도
이 스키마를 고칠 필요가 없다.

`start_agent` 한 번(`SessionManager.startAgent`, 역시 `DelegationFlow`):

1. **Who may.** An ordinary session (`reader` profile) of a trusted project (#382's rule), not one marked `askedBy`:
   depth one, so a child cannot start agents, and neither can a session handling an active ask_project task.
2. **몇 개.** 한 프로젝트에서 동시에 도는 자식은 `AGENT_CEILING`(4)까지, 그 프로젝트의 모든 세션을 합쳐 센다.
   부모가 준 턴이 도는 동안 센다. 카드 전과 후에 두 번 본다. 카드 뒤의 확인은 자리도 함께 잡는다(#673 리뷰,
   `agentStartReserved`). 확인과 예약을 동기 한 단계로 하고, 자식의 위임이 그 자리를 세기 시작할 때까지 `createSession`
   동안 쥐고 있다가, 시작이 실패하면 돌려준다. 그래서 동시에 들어온 호출이 함께 상한을 넘지 못한다. 포크도 같은 방식으로
   자리를 잡는다(`reservePlace`). 자식의 세션이 만들어지면 위임을 등록하기 전에, 기다림 없이 호출한 세션의 문
   (`agentStartGateError`)과 프리셋 규칙을 한 번 더 읽는다. 통과하지 못한 세션은 일을 받지 않고 휴지통으로 간다. 사람의 카드를
   기다리는 요청은 자리를 차지하지 않는다. 몇 시간 서 있을 수 있으므로, 허용될 때 센다.
3. **고르기.** `tool`은 프로젝트의 도구, `model`과 `effort`는 그 도구에 대해 프로젝트가 기억한 선택(#107)이
   기본이다. 도구의 목록에 없는 모델이나 effort는 목록과 함께 거절한다(`agentChoiceError`).
   이 검사는 호출을 붙잡지 않는다(#660). 캐시된 목록을 쓰고(한 번에 하나만 읽고, 늦게 와도 보관하고, 실패하면 1분간
   다시 읽지 않는다) 없으면 최대 `START_AGENT_MODEL_CHECK_MS`(3초)만 기다린다. 그때까지 목록이 없으면 준 이름 그대로
   자식을 띄우고 답에 검사하지 못했다고 적는다.
   캐시된 목록에 없는 이름은 새로 읽어 확인한 뒤에만 거절한다(CLI가 업데이트됐을 수 있다).
   자식이 생기기 전 과정(검사, 카드, 시작)에는 한도 하나(`START_AGENT_SETUP_MS`, 200초, Codex 브리지의 280초 아래)가
   있다. 넘기면 세션이 만들어졌는지를 답에 적는다. 거절과 이 답은 부르는 모델에게 자기 CLI의 하위
   에이전트로 대신하지 말고 사람에게 물으라고 말한다(#660). 다만 그때 서 있는 카드는 거두지 않는다(#673, 4번).
   `wait: true`의 기다림은 `START_AGENT_CALL_MS`(270초)에서 남은 만큼으로 줄어, 시작 과정과 기다림을 합쳐도 브리지
   한도 안에 끝난다. 넘기면 답은 `working`이고 보고가 걸린다.

   **난이도로 고르기**(#729). `model` 없이 `difficulty`를 주면 사람이 설정 → Orchestrator → Models for the agents a
   session starts에서 그 도구와 난이도에 고른 모델과 effort를 쓴다(`prefs.agentModels`, 패치 하나에 맵 전체. 그
   난이도에 고른 것이 없으면 기억한 선택으로 돌아간다). 이름을 댄 모델이 여전히 이긴다(`sessions/start-agent.ts`의
   `agentChoice`). 설정이 고른 모델은 카드에 "(gpt-6, your choice for heavy work)"처럼 적힌다. 설정의 모델과 effort는
   이름을 댄 것처럼 검사한다. 사라진 것은 목록과 함께 거절하되, "That is the person's choice for heavy work …: tell
   them, or name a model"라는 말은 설정 자신의 모델이나 effort가 잘못됐을 때만 붙이고, 부르는 쪽이 댄 effort가
   잘못됐을 때는 붙이지 않는다. 검사하지 못한 경우에는 첫 턴이 실패하면 빼고 다시 시작하라고 하지 않고 모델을 대라고
   말한다. 부르는 쪽은 그 모델을 댄 적이 없기 때문이다.

   `difficulty`와 `worktree`에 붙은 말은 #729가 청한 느슨한 안내다(에이전트는 무시할 수 있고, 프로젝트의 AGENTS.md가
   이긴다). 조회, 작은 수정, 리뷰는 light, 설계, 보안, 데이터 손실은 heavy. 풀 리퀘스트로 끝나는 수정에는 작업 트리,
   조사나 사람이 자기 체크아웃에서 지켜보는 수정에는 작업 트리 없이. 부르는 쪽이 첫 호출 전에 알아야 하므로 답이
   아니라 스키마에 둔다. 자식의 틀(`agentFrame`)은 끝나는 자기 백그라운드 작업(테스트, 빌드)을 턴 안에서 기다린 뒤
   답하라고 청한다(아래 7번).
4. **동의**(`ensureAgentConsent`). **`normal` 세션에게는 프로젝트를 신뢰한 것이 곧 동의다**(#673, 소유자 결정
   2026-10-14). 프로젝트를 신뢰한 것(#655)이 이미 그 프로젝트에 대한 사람의 결정이고, 사람이 보고 있지 않던 세션에
   뜬 카드는 그 세션이 혼자 일하게 만들었을 뿐이다. 호출할 때마다 신뢰를 다시 읽고, 따로 기억하는 것도 설정도 없다.
   `safe` 세션은 승인 자리에 카드(`agent_start`: 도구, 모델, 프리셋, 할 일)를 받는다: 한 번 허용, 이 세션은
   항상(이 호스트가 그 세션을 맡는 동안 메모리에), 이 프로젝트는 항상(카드의 ⌥; 같은 프로젝트를 양쪽에 둔
   `project_consents`의 `agents` 줄, 설정 → 권한에서 보고 거둔다), 거부. `auto`는 전처럼 연다.
   **시작 과정의 한도를 넘겨도 카드는 거두지 않는다**(#673). 호출은 요청 id(`ag-…`)를 핸들로 삼아 `pending`으로
   답하고, 시작 과정은 뒤에서 이어진다. 카드는 사람이 답할 때까지 남는다. 나중에 허용하면 자식이 시작되고 보고가
   걸린다(`wait: false`처럼 그 턴이 끝나면 알린다). 거부하거나, 허용한 뒤 시작에 실패하면 Centralu가 보낸
   메시지(`HOST_SENDER`)로 부르는 세션에게 알린다. 카드는 부르는 세션의 승인 자리 하나를 쓰므로, 그 세션의 턴이
   이어지는 동안에는 그 세션 자신의 다음 이벤트가 자리를 비운다. 턴이 끝나면(오류로 끝난 경우는 빼고) 카드를 다시
   세운다(`sessions/host-cards.ts`의 `raiseHostAsks`, 대화에 두 번 기록하지 않는다). 카드가 서 있는 동안 요청은 스토어의
   `agent_start_requests`(v50)에 있다. 호스트 교체나 재시작이 일어나도 줄은 남고(떠나는 호스트의 호출은 `pending`으로
   답한다), 다음 호스트가 카드를 다시 세운 뒤(`resumeAgentStart`) 허용되면 자식을 시작한다. 어느 호스트에서든
   허용되면 시작이 기대는 조건을 먼저 다시 읽는다(#673 리뷰): 부르는 세션이 아직 있는지, 프로젝트가 아직 신뢰되는지,
   깊이 1 규칙에 여전히 맞는지(그사이 ask_project 일을 맡았을 수 있다), 프리셋이 카드에 적힌 것보다 높지 않은지.
   하나라도 어긋나면 자식을 시작하지 않고 부르는 세션에 까닭을 알린다. 신뢰를 끄면 그 프로젝트에 서 있는 카드를 곧바로
   거두고 부른 세션들에 알린다. 카드가 서 있는 동안 같은 세션이 같은 할 일(도구를 적었다면 같은 도구)을 다시 부르면
   새 카드 대신 기존 핸들을 돌려준다. 호스트 교체의 drain은 끊긴 호출에 다시 부르라고 하는데, 그 호출은 `pending`을
   읽지 못했기 때문이다. 요청은 사람이 답할 때, 부르는 세션이 거둘 때(`agent_session stop`), 카드가 서 있는 동안 호출이
   취소될 때, 부르는 세션이 삭제될 때 끝난다. 자식 없이 끝나면 부르는 세션에 사람이 읽을 알림
   (`Centralu · agent request`)을 남긴다. 호출이 아직 기다리던 카드에서 거부한 경우는 카드 자체가 보여 주므로 남기지
   않는다. 창에서는, 화면 밖 세션에 뜬 카드가 앱이 앞에 있어도 오른쪽 위에 카드(`Notices`, 종류 `agent_start`)를
   남기고, 누르면 그 세션이 열린다.
5. **자식.** 부르는 세션의 폴더(작업 트리 세션이면 그 작업 트리)에서, 할 일에서 딴 이름으로, `askedBy`를 붙여
   (사이드바에서는 그 세션 밑에 들여 그린다, 소유자 결정 2026-10-12. 머리에 "Started by …" 되돌아가기 링크), **부르는 세션의 권한 프리셋**으로 연다. 그보다 위는 없고, 부르는
   세션의 어떤 인자나 도구로도 바꾸지 못한다. 할 일은 틀(`agentFrame`)에 넣어 부르는 세션이 보낸 것(`from`)으로
   기록한다.
6. **답.** ask_project처럼 240초까지 기다린다. 넘기거나 `wait: false`면 곧바로 `working`이고, 턴이 끝나면
   오케스트레이터의 `reportBack`이 쓰는 보고 길로 알린다. 그때 기다리는 호출이 있으면 그 호출이 답을 가져가고
   보고는 가지 않는다. 이 표지는 메모리와 함께 `report_marks`(스토어 v49, #646)에도 적어 두므로 호스트 교체(#280)에
   잃지 않는다: 떠나는 호스트의 `detachAll`은 기다림을 끝내되 보고하지 않고(`handingOver`), 다음 호스트는 키퍼가
   지켜 둔 세션 가운데 아직 턴 중인 세션의 표지만 되살린다(그 턴은 다음 호스트 밑에서 끝난다). 프로세스가 없는
   세션의 표지는 이전 호스트와 함께 죽은 턴의 것이므로 버리고, 교체하는 사이에 턴을 끝낸 세션의 표지도 버린다.
   그래야 사람이 나중에 그 세션에서 시작한 턴이 맡긴 일로 보고되지 않는다(#166). 그 답은 `agent_session`으로 읽을 수 있다.
   끝을 알리겠다고 하는 답(보고가 걸린 `working`, `pending`)은 그동안 `status`로 확인하지 말라고, 끝까지 붙잡고
   기다리는 호출은 `wait` 하나라고 말한다. `pending`은 더 이상 `status`를 알려 주지 않는다. `send`를 알려 주는
   답(`done`, `at_rest`)은 다른 종류의 일이면 할 일을 빠짐없이 적어 새 에이전트를 띄우라고 말한다. 새 에이전트는
   이전 에이전트의 맥락 없이 시작하고, 이전 자식의 이름과 역할은 첫 일에서 정해졌기 때문이다(#747: 부모가 `status`를 열 번 넘게 잇달아
   불렀고, 읽기 전용 조사로 띄운 자식에게 파일 수정까지 맡겼다). 설명이 아니라 답에 둔다. 답은 보이기 전까지 비용이 없다.

`agent_session`은 `askedBy`가 부르는 세션인, 같은 프로젝트의 세션에만 듣는다. `send`는 준 일이 아직 돌 때, 다른
일(사람의 것일 수 있다)로 바쁠 때, 사람이 그 자식의 프리셋을 부르는 세션보다 올렸을 때 거절한다(`presetWithin`).
`stop`은 부르는 세션이 준 턴만 멈춘다.

**새 작업 트리에서**(2부). `worktree: true`나 `branch`를 주면 자식은 부르는 세션의 폴더가 아니라 프로젝트 저장소의 새
작업 트리에서 연다. 새 세션 창의 작업 트리 선택과 같은 길이다(`createSession`의 `worktree`, `worktreeBranch`,
`worktreeBase`: 복사와 준비 단계, 믿는 프로젝트만). 가지는 부탁한 이름(git의 규칙으로 검사) 또는 일에서 딴 이름
(`agentBranch`: `centralu/write-the-parser-1a2b`)이고, 카드보다 먼저 정해져 카드에 적힌다. 부르는 세션이 작업 트리
세션이면 그 가지에서, 아니면 프로젝트의 줄기에서 갈라진다. git 저장소가 아닌 프로젝트는 카드 전에 거절한다. 자식은
여느 작업 트리 세션처럼 보인다(가지가 이름, 병합과 PR 상태, #69/#76). 사이드바에서는 같은 폴더의 자식처럼
자기를 띄운 세션 밑에 달린다: 사이드바는 누가 띄웠는지(`askedBy`, `ui/features/sidebar/tree.ts`의 `orderAsTree`)로
묶고, `parentSessionId`는 예전 워크트리 매니저의 세션을 그 밑에 둔다.

**멈춤과 삭제.** 호출이 취소되거나(Claude의 MCP 신호), 호출이 자식을 기다리는 중에 부르는 세션을 멈추면 그 자식의
턴도 멈춘다. 계속 돌게 둔 자식(`wait: false`, 또는 한도를 넘긴 것)은 자기 세션이라 부모의 멈춤이 닿지 않고 자기
멈춤 버튼이 있다. 부르는 세션을 지우면 기다림과 세션 동의는 사라지고, 자식은 턴과 링크를 지킨다.

**크기.** 두 정의는 1,332자(`AGENT_BUDGET_CHARS` 1,350. #729의 `difficulty`와 그것과 `worktree`에 붙은 말 전에는 1,085자로, 평범한 Claude 요청마다 247자, 실측 68토큰이 늘어 그 상주하는 Centralu 몫이 2,313자에서 2,560자가 된다. 설명 없이 붙은 #686의 `lsp` 전에는 1,060자, #677의 `ifBusy` 전에는 990자, #676의 `answer` 동작과 `card` 전에는 956자, 레지스트리 이름 스키마 전에는 992자, 작업 트리 인자 전에는 918자, `delete` 전에는 974자). Claude는 `start_agent`를 올려 두고 `agent_session`을 미룬다
(`start_agent`의 모든 답이 그 이름을 댄다). 잰 값은 tool-cost.md에 있다.

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

**Codex 프로세스를 띄우는 방법 (#568).** `npm i -g @openai/codex`는 `bin/codex.js`를 설치한다. 플랫폼
바이너리(`@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex`)를 찾아 띄우고, 신호를 전달하려고만 살아 있는
Node 래퍼다. codex-cli 0.160(macOS arm64)에서 측정: 래퍼로 띄운 유휴 `codex app-server`는 `node` 44 MB와
바이너리 115 MB, 직접 띄우면 115 MB뿐이다. 그래서 호스트가 띄우는 모든 Codex 클라이언트(세션의 app-server,
키퍼 안이든 밖이든, 그리고 사용량·모델·기록·포크·삭제용 짧은 것들)는 래퍼가 찾을 자리의 바이너리를 띄운다
(`adapters/codex/native.ts`): 패키지 안(npm), 패키지 옆(pnpm, 호이스팅 설치), 패키지 자신의 `vendor/`. 래퍼가
설정하는 `CODEX_MANAGED_BY_<NPM|PNPM|BUN>`과 `CODEX_MANAGED_PACKAGE_ROOT`도 똑같이 설정한다. 바이너리는 이것으로
업데이트 안내와 설치 점검을 한다. `codex-path/rg`와 `codex-resources`는 바이너리가 자기 옆에서 찾는다. 그 밖의
경우(Homebrew cask, PATH의 바이너리, 플랫폼 패키지가 빠진 래퍼, 래퍼가 모르는 플랫폼)는 찾은 그대로 띄운다.
`CC_CODEX_NATIVE=0`이면 예전처럼 래퍼를 띄운다.

추가 하나(#280): 키퍼 아래에서(`CC_KEEPER=1`) 호스트는 `{"activity":{"busy":true|false}}`도 stdout에
쓴다, 시작할 때 한 번과 바뀔 때마다(`keeper-link.ts`). 키퍼의 유휴 규칙이 읽는 것이 이것이다. 다른 방법으로
띄우면 호스트는 준비 줄 말고 아무것도 쓰지 않는다.

### 1.2.2 맡긴 턴의 카드 (#676)

세션이 다른 세션이 맡긴 턴을 돌고 있으면, 그 턴에서 띄운 카드는 사람에게 더해 맡긴 세션에게도 간다(사장님 결정
2026-10-14, #561 B안의 자식 질문 규칙을 좁게 적용). 다른 세션의 일이 턴을 시작하면 그 턴은 **맡긴 턴**이다:
쉬는 세션에 보낸 `ask_project`, `start_agent`, 턴을 시작하는 `agent_session` send, 쉬는 세션에 보낸
`send_to_session`. 이미 돌고 있는 턴(사람의 턴이든 다른 세션의 턴이든)에 끼어든 일이나 메모는 누구에게도 그 턴을
주지 않는다.

- **연결**(`turnOwners`, `ownTurn` / `releaseTurn`): 세션 → 그 턴을 맡긴 세션. 위임의 결과(`startDelegation`)와
  함께 끝나고, `send_to_session`이면 턴과 함께 끝난다. 사람이 나중에 시작한 턴의 카드는 맡긴 세션에게 가지 않는다.
  메모리와 함께 `delegated_turns`(스토어 v51)에도 적는다. 떠나는 호스트의 `detachAll`은 줄을 남기고(`handingOver`),
  다음 호스트는 키퍼가 쥐고 있고 아직 턴 중인 세션의 연결만 되살려 그 턴과 함께 끝낸다. 나머지 줄은 지운다. 키퍼가
  쥔 CLI는 떠 있던 카드를 새 호스트에 다시 보낸다(§4.3). `told_cards`가 두 번째 알림을 막는다.
- **전달**(`routeCard`). 맡긴 세션이 그 턴을 기다리고 있으면(`agent_session` wait, 기다리는 `start_agent`,
  기다리는 `ask_project`) 기다림이 카드와 함께 `asking`을 돌려준다. 기다림이 없으면 보고처럼 그 세션에서 온 것으로
  표시된 알림 하나가 맡긴 세션의 대화에 들어간다(`tellCardRaised`): 세션 id와 카드를 읽는 호출만 담은 호스트의 글이다.
  카드의 글은 넣지 않는다. 질문과 선택지, 승인의 내용은 대상 세션의 말이므로, 맡긴 세션은 사람 자리에서가 아니라
  **도구 결과**로 읽는다(`agent_session` status, 지휘 좌석은 `read_session`). JSON으로 감싼다(`cardsText`).
- **답하기**(`answerRoutedCard`). 질문: `agent_session` `answer`(평범한 세션. `ask_project` 대상이면 프로젝트를
  넘어서도 되지만 status와 answer만 된다) 또는 `answer_question`(오케스트레이터. 드문 명령이라 기본 계층에서는
  `centralu_run`으로 부른다. 코디네이터는 읽기만 한다). `text`가 답이다: 질문마다 한 줄, 여러 개를 고르는 질문은
  `;`로 나누거나 JSON 배열. 선택지 이름과 같은 답은 그 선택지의 이름이 된다(`answersFrom`). 카드는 사람을 위해
  세션에 남고, 먼저 온 답이 들어가며 늦은 답은 카드가 이미 없다는 결과를 받는다. 승인: 맡긴 세션은 알림을 받고,
  답하는 시점에 **두 조건이 모두** 맞을 때만 허용이나 거부를 할 수 있다(`answersApproval`, #603/#606의 규칙):
  맡긴 세션의 프리셋이 `auto`이고 앱의 에이전트가 아니어야 하며, 턴을 돌고 있는 세션이 `normal`이나 `auto`이고 앱의
  에이전트가 아니어야 한다(사장님 결정: `auto` 오케스트레이터는 `normal` 세션 대신 승인할 수 있다). `safe` 세션의
  승인은 누가 일을 맡겼든 사람의 것이다: 맡긴 세션의 `auto`가 대상의 권한을 올리지 않는다. 호스트가 그 세션에 띄운
  카드도 못 하고, "항상"은 사람의 것이다.
- **어느 카드인가**(#679 리뷰). 맡긴 세션은 카드를 `<요청 id>.<요약값>` 핸들로 읽고, 답할 때 그 핸들을 대야 한다.
  요약값은 맡긴 턴(`turnId`, 연결과 함께 저장)과 카드의 내용으로 만든다(`cardHandle`). 어댑터는 새 프로세스에서
  요청 번호를 다시 매기므로(`req-1`, …), 요청 id만으로는 앞 카드에 대한 답이 같은 세션의 새 카드나 나중 턴의 카드로
  들어갈 수 있다. 지금 떠 있는 카드와 맞지 않는 핸들은 거절하고, 맡긴 세션은 카드를 다시 읽는다. `told_cards`도
  핸들을 적으므로, 같은 id를 다시 쓴 새 카드도 알린다.

### 1.2.3 바쁜 세션에 보낸 요청 (#677)

세션 B가 세션 A에게 일을 청할 때(`agent_session` send, 이미 있는 세션에 보내는 `ask_project`, `send_to_session`) A가
B의 것이 아닌 턴(사람의 턴, 다른 세션의 위임, 앱의 일)을 돌고 있거나 앞서 대기 중인 요청이 있으면, Centralu는 B 대신
결정하지 않는다(사장님 결정 2026-10-14). 요청 도구는 아무것도 보내지 않고 선택지가 담긴 `busy`를 돌려준다. 선택지마다
지금 고를 수 있는지와 그 이유가 붙는다(`busyChoices`). B는 `ifBusy`를 붙여 다시 부르거나 처음부터 붙인다. 그 세션에서
B 자신의 턴이 돌고 있으면 B에게는 바쁜 것이 아니다: 자기 일에 메모를 더하는 것은 예전과 같다. 사람이 보내는 메시지는
바뀌지 않는다. 답은 어떤 선택지가 실행됐는지와 그 핸들을 말한다.

| `ifBusy` | 일어나는 일 |
|---|---|
| `note` | 지금까지의 턴 중간 메모(#594/#606/#653): B 자신의 프리셋이 `auto`일 때만, 턴 중간 입력을 받는 CLI에서만(`send_to_session`은 예전처럼 보낸다). 턴의 답은 턴 주인의 것이고, B는 자기 메모에 대한 답을 자기 리더에서 읽는다. 다른 호출자의 `ask_project` 일에는 넣지 않는다. |
| `queue` | 붙잡아 두었다가(`queued`, `enqueue`) A의 턴이 끝나면 B가 소유한 새 턴으로 전한다(`drainQueue`, 턴의 끝과 세션을 비우는 다른 경계에서): `agent_session`과 `ask_project`는 B의 위임으로, `send_to_session`은 B의 턴으로, 각 도구의 틀에 담아 보내고, 끝나면 보고하며 그 턴의 카드도 간다(§1.2.2). 한 번에 하나씩, 먼저 온 것부터. 답은 핸들(`qr-…`)과 대기 순서이고, `agent_session` status(또는 task 없는 `ask_project`)가 어디쯤인지 말하며 `stop`은 거둬들인다. `queued_requests`(스토어 v52)에 적는다: `detachAll`은 아무것도 전하지 않고(`handingOver`), 다음 호스트가 키퍼가 쥔 세션의 턴이 거기서 끝날 때, 쉬고 있는 세션이면 시작 직후에 전한다(키퍼가 쥔 세션은 넘겨받은 뒤에: 그 입력이 두 번째 프로세스를 띄우지 않도록). 세션이나 요청한 세션이 없어진 요청은 버리고, 휴지통에 간 세션의 요청도 버린다. 들어가기 전에 요청한 세션의 그때 프리셋으로 요청한 도구의 문을 다시 읽는다(`queuedGateError`). ask_project는 신뢰, 깊이, 대상 프로젝트, 그리고 `auto`만으로 통과한 요청이면 프로젝트 쌍의 기억된 동의를 본다(`openedByAuto`, `queued_requests.opened_by_auto`에 저장한다, 스토어 v54. 그래서 교체해도 표시가 남는다. 이전 빌드가 쓴 줄은 쌍의 기억된 동의가 없으면 표시된 것으로 읽는다). agent_session은 `auto`가 아닌 요청자에게 필요한 소유권과 프리셋 규칙을 본다. 통과하지 못한 요청은 버리면서 요청한 세션에 알린다. 요청한 세션이 `auto`에서 내려가거나, `auto`가 아닌 세션에 일을 넘길 때(`moveLiveChildren`, 원래 세션에 알린다) `auto`만으로 통과한 요청을 바로 버린다(`dropOpenedByAuto`: 표시가 있고 쌍의 기억된 동의가 아직 없는 ask, 자기가 시작하지 않은 세션으로 보낸 send). 그 순간 전달 중인 요청은 전달할 때의 문에 맡긴다. 교체 뒤 다시 전달하게 되면 그 문이 저장된 표시를 읽는다. 요청한 세션의 프로젝트가 신뢰를 잃거나 지워질 때, 그리고 사람이 프로젝트 쌍의 동의를 거둘 때도 대기 중인 `ask_project` 요청을 같은 방식으로 거둔다(`withdrawReaches`). 신뢰 상실과 동의 철회는 `auto` 요청자의 요청을 남겨 두고, 전달할 때 문이 다시 읽는다. **전달**(#684 리뷰): 세션마다 drain은 한 번에 하나만 돈다(`delivering`). 첫 대기 전에 세션을 예약하므로, 잠든 세션을 깨우는 동안도 바쁜 것으로 보이고 두 번째 요청은 들어가지 않는다. 요청은 세션의 턴이 실제로 시작될 때까지 큐의 맨 앞에 남고, 저장소 줄도 `delivering_at` 표시와 함께 남는다. 턴이 시작된 뒤에야 지운다. 그 사이 교체나 충돌이 나면 줄이 남아 다음 호스트가 다시 전한다: 적어도 한 번이고, 예전 프로세스가 아무 신호 없이 입력을 받은 채 교체되면 한 번 중복될 수 있다. drain은 미뤄 둔 재시작을 기다리지 않는다(`deliver`가 기다린다). 재시작이 끝나면 drain을 다시 예약한다. 같은 요청(요청한 세션, 도구, 내용)을 다시 보내면 두 번째 항목을 만들지 않고 이미 잡아 둔 핸들을 돌려준다. |
| `fork`, `fork_read` | 지금 A의 대화를 복사한 하위 세션(`forkFor`): 어댑터의 `forkConversation`(Claude: 원본 대화 기록 옆에 복사본을 쓰는 SDK `forkSession`, Codex: `thread/fork`)으로 만들고, 기록을 화면에 가져와 이어간다(`importHistory`). 이것이 없는 어댑터, 아직 대화가 없는 세션, 그리고 `ask_project`(다른 프로젝트에 세션을 만들지 않는다)에는 포크를 내놓지 않는다. start_agent의 문을 그대로 거친다: 깊이 하나, 프로젝트 신뢰(#382, 동의 규칙은 `ensureAgentConsent`가 가진 대로 #673), 프로젝트당 상한. 카드에 답이 나면 문을 다시 읽고, 복사하기 전에 자리를 잡는다(`reservePlace`). 프로젝트가 신뢰를 잃으면 아직 떠 있는 카드를 거둔다. 포크의 세션이 만들어지면 위임을 등록하기 전에, 기다림 없이 문과 두 프리셋 중 낮은 쪽을 그때 값으로 한 번 더 읽는다. 통과하지 못한 포크는 일을 받지 않고 휴지통으로 간다. 프리셋은 B와 A 중 낮은 쪽이다. `fork`는 자기 워크트리를 받고(`agentWorktreeBranch`, A가 워크트리 세션이면 A의 브랜치에서 갈라진다. git 저장소가 아닌 프로젝트는 거절하고 `fork_read`를 가리킨다), `fork_read`는 A의 폴더에서 하는 읽기 일로 많아야 `safe`다: 두 에이전트가 한 폴더에 쓰지 않는다. B와 연결된다: 같은 프로젝트의 평범한 세션이면 `askedBy` B(오케스트레이터는 위임으로만), 그 턴은 B의 위임(보고, 카드), 그리고 `forkedFrom` A(`sessions.forked_from_session_id`, 스토어 v52). 사이드바는 이것으로 포크를 A 아래에 둔다. `parentSessionId`와 `askedBy`보다 먼저 본다(`orderAsTree`, `foldGroupsHiding`). |

**크기.** `ifBusy`는 어느 스키마에도 설명을 싣지 않는다: `busy` 답이 이름과 값을 알려 준다. `ask_project`의 것은 그냥
문자열이다(열거형이면 reader의 Claude 요청이 2,300자를 넘는다). 다른 값은 실행기가 거절한다. `DELEGATE_BUDGET_CHARS`는
400에서 450으로, `AGENT_BUDGET_CHARS`는 1,000에서 1,100으로(#676의 `answer`와 `card`까지 더해 agent 묶음은 1,060자),
scoped 좌석은 `send_to_session`의 것 때문에 2,350에서 2,400으로 올린다.

### 1.2.4 자식 세션이 기계에 드는 비용: 코드 인텔리전스와 메모리 관문 (#686)

병렬 자식 세션의 수는 사용량보다 메모리에 먼저 막힌다. 사장님의 24 GB Mac에서 측정한 값(2026-10-14): 코드 탐색을 쓴 Claude
자식은 이 모노레포에서 자기 `tsserver`를 0.5–1.1 GB로 돌렸고, CLI 자체가 0.3–0.5 GB를 더 썼다. Codex는 언어 서버를 띄우지
않는다. 사장님은 두 가지를 정했다(2026-10-15).

**자식의 코드 인텔리전스는 부른 쪽이 요청하지 않으면 꺼진다.** 규칙은 `codeIntelligenceOff`(tool-profiles.ts)다. 자식
(`isChildSession`: `start_agent`의 자식, 포크, 앱의 에이전트)은 `start_agent`가 `lsp: true`를 넘기지 않는 한 코드
인텔리전스 없이 시작한다. 사람이 시작한 세션, 오케스트레이터, 빌더 세션은 사람의 설정을 그대로 따른다. 부른 쪽이 작업마다
고른다(리팩터링과 여러 파일에 걸친 변경에는 켜고, 조사·문서·작은 수정·테스트는 검색과 마지막 typecheck로 충분하다).
Centralu는 작업의 종류를 문장에서 추측하지 않는다. 결정은 `createSession`에서 한 번 내려지고 앱 설정
`code_intelligence:<id>` = `off`로 기록된다(열이 아니므로 마이그레이션이 없다). 그래서 깨울 때, 재시작할 때, 호스트가 이어받을
때마다 자식은 만들어질 때와 같이 실행되고, 이 빌드 이전에 만든 세션은 사람의 설정을 유지한다. 어댑터는
`noCodeIntelligence`를 받아 그 의미를 정한다. Claude는 SDK의 `settings` 옵션(CLI의 `--settings` 플래그 계층, 사람이
다루는 계층 중 가장 높다)에서 `lspServers`를 선언한 활성 플러그인을 모두 끈다(adapters/claude/lsp-plugins.ts). 사람의 설정
파일에는 아무것도 쓰지 않는다. 어떤 플러그인인지: 활성 id는 SDK 자체의 병합(`resolveSettings`, 그 세션이 읽는 계층)에서
얻고, 설치본의 `.claude-plugin/plugin.json`이 `lspServers`를 선언하거나, 설치본 루트에 `.lsp.json`이 있거나, 마켓플레이스
항목(`.claude-plugin/marketplace.json`, Anthropic 공식 LSP 플러그인은 `strict: false`로 여기에 선언한다)이 선언하면 해당한다.
파일은 `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`) 아래의 `plugins/installed_plugins.json`과 `plugins/known_marketplaces.json`으로
찾는다. 이 파일들은 공개된 인터페이스가 아니라 CLI의 것이므로, 측정한 플러그인
`typescript-lsp@claude-plugins-official`은 항상 함께 끈다(`KNOWN_LSP_PLUGINS`). 파일 구조가 바뀌면 다른 언어의 서버는
놓칠 수 있어도 이 서버는 놓치지 않는다. 키퍼 지문은 꺼졌을 때만 `noLsp`를 더하므로, 이전에 저장된 지문은 모두 그대로
읽힌다. Codex는 이 옵션을 무시한다.

**새 자식은 기계에 여유가 있을 때만 시작한다**(`MemoryGate`, sessions/memory-gate.ts. main.ts가 `useMemoryGate`로
연결하고, 테스트는 그것이 주제인 곳에서만 연결한다). 읽는 값은 비어 있는 메모리와 회수할 수 있는 메모리의 합이다
(`availableMemorySource`, os.ts): macOS는 `vm_stat`의 free·inactive·speculative 페이지(여기서 `os.freemem()`은 inactive가
9 GB인데 0.2 GB로 읽었다), Linux는 `MemAvailable`, Windows는 `os.freemem()`이다. 읽기에 실패하면 시작을 통과시킨다.
하한(2 GB, `MEMORY_FLOOR_BYTES`)보다 적으면 시작은 **거절되지 않고 대기열에 들어간다**:

| 시작 | 하한 아래일 때 |
|---|---|
| `start_agent` | 동의(카드 또는 프로젝트 신뢰) 뒤에 요청(`agent_start_requests`, #673)이 `allowed`로 표시되고, 호출은 `lowMemory`와 `ag-…` 핸들이 붙은 `pending`으로 답한다(모델은 "queued: low memory"로 읽는다). 부른 세션에 이유를 알리는 공지가 뜬다. agent_session의 `status`/`wait`/`stop`은 카드의 핸들과 똑같이 동작하고, 카드가 없던 시작은 자기 요청을 새로 받는다. 메모리가 돌아오면 보고가 걸린 채로 자식이 시작되고, 핸들은 그 자식으로 이어진다. `allowed` 요청을 이어받은 호스트는 카드를 다시 띄우지 않고 메모리만 기다린다(이전 빌드는 카드를 다시 띄우는데, 두 번 묻는 것뿐이다). |
| 포크(§1.2.3) | 대신 바쁜 세션의 대기열에 들어간다(`enqueue`). 프로세스를 새로 띄우지 않는다. 답은 `lowMemory`가 붙은 `queued`이고, "Not forked: memory is low … queued instead"로 읽힌다. |
| 앱의 에이전트 | 앱의 호출 안에서 기다린다. 실행 진행 상황에 "waiting for memory"가 뜨고, 메모리가 돌아오면 에이전트가 시작된다. 호출이 취소되면 세션 없이 끝난다. |

대기는 15초마다(`MEMORY_RECHECK_MS`) 메모리를 다시 읽고, 확인 한 번에 대기 중인 시작을 **하나만**, 오래된 것부터 내보낸다.
자식은 턴의 처음 몇 초 동안 메모리를 차지하므로, 함께 내보낸 시작들은 모두 같은 여유 메모리를 읽게 된다. 30분
(`MEMORY_WAIT_MAX_MS`)이 지나면 포기하고, 부른 세션에는 메시지로, 사람에게는 공지로 알린다. 요청이 철회되거나, 부른 세션이
삭제되거나, 호스트가 떠나면(`disposeAll`, `detachAll`이 관문을 닫는다. 저장된 요청은 다음 호스트로 넘어간다) 시작 없이 대기가
끝난다. 사람이 시작한 세션은 관문을 거치지 않는다.

### 1.2.5 인계는 자식을 함께 넘긴다 (#693, #738)

인계(`createSession`에 `handoff.fromSessionId`를 주는 것, domain-model §1.1의 세션 인계)는 예전에 원래 세션의 자식을
그 자리에 두었다. 그래서 자식의 보고는 사람이 더 이상 쓰지 않는(그리고 보통 곧 지우는) 원래 세션을 깨웠고, 새 세션은
그 자식에 닿을 수 없었다. `agent_session`은 시작한 세션에게만 허용되기 때문이다. 이제 새 세션은 만들어지는 순간,
첫 턴에서 노트를 읽기 전에 원래 세션의 **살아 있는** 일을 넘겨받는다(`moveChildren`, #693의 소유자 결정). 원래 세션이
없어지는 경우에는 **모든** 자식을 넘겨받는다(#738):

- **살아 있는 것**: 일하고 있거나 사람을 기다리는(승인 또는 질문) 세션, 원래 세션이 큐에 넣은 요청을 들고 있는
  세션(§1.2.3), 원래 세션에 보낼 보고가 아직 전달되지 않은 세션, 원래 세션이 결과를 읽으러 오지 않은 `ask_project`
  답(이 도구는 끝나도 아무에게도 알리지 않는다), 그리고 아직 열려 있는 start_agent 요청(카드가 서 있거나(#673), 이미 허용되어 메모리가 풀리기를 기다리는 것(§1.2.4, #686)). 같은 프로젝트의
  자식(`askedBy`나 `parentSessionId`가 원래 세션을 가리키는 세션)과 다른 프로젝트에 맡긴 위임을 모두 센다.
- **옮기는 것**: 원래 세션을 가리키는 `askedBy`와 `parentSessionId`(다른 프로젝트의 세션은 자기 줄을 그대로 둔다),
  보고 표시(`report_marks`), 위임된 턴의 연결(`delegated_turns`)과 호스트가 들고 있는 위임(키에 호출자가 들어 있다),
  원래 세션이 큐에 넣은 요청(`queued_requests`), 그리고 아직 서 있는 시작 요청(`agent_start_requests`, 저장된 요청에도
  호출자가 적혀 있다). 서 있는 카드는 원래 세션에서 닫히고, 새 세션에 턴 사이에 띄운 카드로 선다. 따라서 새 세션의
  첫 턴이 카드를 가리고, 그 턴이 끝나면 다시 띄운다. 승인하면 새 세션의 자식이 시작된다(기다리던 설정 과정이 카드 뒤에
  요청의 호출자를 다시 읽는다). 이미 자식을 만든 시작 요청은, 그 자식이 옮겨지면 핸들도 함께 넘긴다.
- **남기는 것, 원래 세션이 남을 때만**: 정리된 자식(끝났고 보고했거나 읽었으며 남은 일이 없는 자식)은 인계가 지우지 않는
  원래 세션에 남는다. 기록이 일어난 자리에 그대로 두기 위해서다. 그러나 정리된 자식도 아직 쓰이는 경우가 많다(끝내고
  보고한 뒤 오케스트레이터의 다음 지시를 기다리는 자식). 없어지는 원래 세션에 남겨 두면 그 자식은 주인이 없어졌다.
  `askedBy`는 지워진 세션을 가리켰고, 사이드바는 그 자식을 맨 위 단계에 보였으며, 다음 보고는 지워진 세션 앞으로 갔고,
  `auto`가 아닌 후임은 `agent_session`으로 그 자식에 닿을 수 없었다(#738). 그래서 다음과 같이 한다.
  - **원래 세션을 지우는 인계**(창의 기본값)는 그 사실을 알린다(`handoff.removesOriginal`, `createSession`에 더한 필드).
    그러면 세션을 만들 때 정리된 자식까지 모든 자식을 옮기고, 노트에는 정리된 자식을 "finished; waiting for more work"로
    적는다. 같은 트랜잭션에서 같은 방식으로 옮긴다. 달라지는 것은 `stateOf`가 정리된 자식을 건너뛰지 않고 상태를 준다는
    점뿐이다. 창은 원래 세션을 별도의 마지막 단계로 지우므로(`store.handoff`, "destruction comes last"), 호스트가 나중에
    알아내는 대신 미리 듣는다. 미리 들으면 첫 턴이 노트를 읽기 전에 옮길 수 있다. 그 뒤 삭제가 실패하면 두 세션이 모두
    남고, 자식은 사람이 쓰는 세션에 있다.
  - **나중에 지워지는 원래 세션**(인계가 남겨 둔 뒤 지운 경우, 또는 지운다고 알리지 않은 창)은 아직 가진 것을
    인계를 이어받은 세션에 넘긴다. `sessions/session-trash.ts`의 `trashSessionOnce`가 정리 작업으로 놓아 버리기 전에 넘긴다(범위 `removed`). 정리된
    자식과, 인계 뒤에 원래 세션이 시작해 아직 일하는 자식이 여기에 들고, 그 자식에 딸린 보고, 턴, 위임도 함께 간다.
    주인 없는 자식이 더 나쁘기 때문이다. 원래 세션이 요청했지만 사람이 아직 답하지 않은 것은 넘기지 않고 예전처럼
    처리한다. 서 있는 start_agent 카드는 거두고, 큐에 넣은 요청은 버린다. 그래서 다른 세션을 지웠다는 이유로 이어받는
    세션에 카드가 뜨는 일은 없다. 원래 세션이 옮겨진 자식을 기다리던 호출은 고정된 답(`handedOverReply`)을 받고 끝난다.
    깨어난 호출이 `handedOver` 항목을 읽기 전에 휴지통 작업이 그 항목을 지우기 때문이다. 이어받는 세션은 인계 마커가
    그 세션을 가리키는 가장 최근의 살아 있는 세션이다(`Store.handoffHeirs`, SQL에서 거른다). 휴지통에 갔거나 지금
    지워지고 있는(`trashing`) 후임은 자기 후임들에게 넘기며, 가까운 세대부터 찾는다. 그 세션은 노트를 이미 오래전에
    읽었으므로 대화에 알린다(`notice`). 곧 없어질 원래 세션에는 알리지 않는다. 이 이동은 휴지통으로 옮기는 트랜잭션보다
    먼저 도는 별도의 트랜잭션이다. 그 사이에 충돌하면 자식은 이어받는 세션에 있고 원래 세션은 남는다. 인계한 적이 없는
    세션을 지우면 자식은 예전처럼 혼자 남는다.
- **노트**: 첫 메시지가 가리키는 노트 파일과, 노트 원본을 보관하는 마커의 맨 앞에 옮긴 것의 목록을 붙인다. 항목마다
  이름, 상태, 핸들과 함께, 새 세션이 그 항목으로 실제로 할 수 있는 일을 적는다. 할 수 있는 일은 무엇이 옮겨졌는지에
  따라 다르다(#693 리뷰). 새 세션이 이제 시작한 것이 된 자식에는 `agent_session`이 듣고, 보고할 것이 남아 있으면 보고가
  온다. 다른 프로젝트의 세션은 task 없는 `ask_project`로 답을 기다리고, 넘겨받은 턴의 카드를 알려 준다. 새 세션이
  시작하지 않은 같은 프로젝트의 세션(턴만 넘겨받은 경우)은 보고와 카드를 받지만, `agent_session`은 `auto`에서만 듣는다.
  서 있는 카드는 사람이 답할 때까지 `agent_session`에 쓰는 핸들이다. 메모리를 기다리는 시작(`allowed`)은 카드가 없고,
  메모리가 허락하면 새 세션의 자식으로 스스로 시작하며 보고도 새 세션으로 간다. 그동안 핸들은 그대로 쓸 수 있다. 옮긴 것이 없으면 아무것도 붙이지 않는다. 첫 메시지
  자체는 창이 만든 것이므로 바꾸지 않는다(창은 그 메시지를 텍스트로 확인한다).
- **남는 원본**(인계가 원본을 지우지 않는 경우, #694)에는 무엇이 누구에게 갔는지를 대화에 알린다(`notice`). 원본이
  그 순간 기다리던 호출(`agent_session`의 wait나 send, task 없는 `ask_project`, 시작 요청 핸들에 대한 wait, 나중에
  카드가 승인되는 `start_agent` 호출)은 어디로 갔는지를 답으로 받고 끝난다. 그래서 결과는 새 세션이 한 번만 읽는다.
  기다리던 호출이 자식의 보고 표시를 내려 두었으므로, 그 보고는 같은 트랜잭션에서 새 세션 앞으로 다시 세운다
  (`armReports`). 이후 원본이 그 항목을 `agent_session`이나 `ask_project`로 물으면 "not a session this session
  started" 대신 어디로 갔는지 답한다(`handedOver`, 메모리에만 둔다).
- **누가 인계할 수 있는지**는 여기서 검사하지 않는다. `moveChildren`은 호출자를 믿는다. 지금은 사람의 인계만 이
  함수를 부르고, 에이전트가 부르는 인계(#694의 오케스트레이터 도구)는 먼저 원본에 대한 권한을 확인해야 한다.
- **원자성**: 저장된 것은 모두 한 트랜잭션으로 옮기고(`Store.moveChildren`), 호스트의 메모리는 커밋한 뒤에 그 사이
  await 없이 따라간다. 커밋 전에 충돌하면 모든 연결이 원래 세션에 남고, 커밋 뒤에 충돌하면 모든 연결이 새 세션에
  있다. 따라서 교체나 재시작 뒤에 이어받는 호스트는 한 소유자만 읽는다(`report_marks`, `delegated_turns`,
  `queued_requests`, `agent_start_requests`는 예전처럼 시작할 때 읽는다). 저장소가 거절하면 아무것도 옮기지 않고
  노트에도 아무것도 적지 않는다. 위임이 끝날 때는 그 위임을 시작한 세션이 아니라 그 시점의 소유자 이름으로 턴을 놓는다.
- **상태가 있는 곳**: 자식의 일을 누가 소유하는지는 `ChildOwnership`(`sessions/child-ownership.ts`, #428)이 가진다.
  보고 표시와 멈춘 보고, 위임된 턴, 대기열 요청과 지금 전달 중인 요청, 위임과 관찰자 메모, start_agent 요청, 연결된
  머신의 보고, 인계가 넘긴 것이 여기에 있다. 저장소 사본이 있는 변경은 여기서 저장소에도 쓰고, 매니저는 읽기 전용
  Map으로 읽는다. 옮기기의 메모리 쪽은 `moveOwner` 한 번의 호출이고, 옮기는 시작 요청의 카드는 그 중간에 매니저가
  위 순서대로 옮긴다. 무엇을 옮길지, 저장소 트랜잭션, `askedBy`와 `parentSessionId`는 매니저에 남는다. 시작할 때는 자기 행을 직접
  다시 읽는다(`restoreReports`, `restoreTurns`, `restoreQueued`). 예전에는 매니저 생성자가 하던 일이다. 서 있는
  start_agent 요청은 `DelegationFlow.restoreAgentStarts`가 읽으며, 보고 표시와 턴 사이에 불린다.
- **창**은 `session_owner`(그 세션의 지금 `askedBy`와 `parentSessionId`)를 듣고 자식을 새 소유자 아래에 둔다. 연결된
  머신의 이벤트는 `Qualifier.event`가 이름을 붙이고, 허브의 미러에도 반영한다.

### 1.3 새 프로젝트 만들기 (`projects.create`, `create_project`, #515)

예전에는 프로젝트를 만들려면 폴더가 이미 있어야 했다(`projects.add`는 없는 폴더를 거절한다). 이제 호스트가
폴더를 만든다: `projects.create { name, parent?, machine? }`는 **빈** 폴더를 만들고(`git init`도 템플릿도
없다) `projects.add`처럼 등록하되 신뢰한 채로 둔다(#655, 밖에서 온 내용이 없다). 복제(`source`)는 신뢰하지 않은 채로 등록하고, 이미 프로젝트인 경로를 다시 등록해도 신뢰는 바뀌지 않는다. `projects.createPreview`는 아무것도 만들지 않고 어디에 생길지, 왜 거절될지를
답한다. 대화상자가 사람이 입력하는 동안 이것을 묻는다. 둘 다 `projects.add`처럼 `machine`으로 라우팅되므로
(remote-hub.md §5) 폴더는 프로젝트가 사는 머신의 호스트가 그 머신의 경로 규칙으로 만든다.

| 규칙 | 위치 |
|---|---|
| 이름은 폴더 하나: `/`나 `\` 없음, `.`나 `..` 아님, 제어 문자 없음, 255바이트 이하, 어느 머신에서든 Windows 장치 이름(`CON`, `nul.txt`, `COM1`) 금지. Windows에서는 `< > : " \| ? *`와 끝의 점·공백도 금지 | `folderNameError` (protocol, 대화상자·목과 공유) |
| 이미 있는 것은 다시 쓰지 않는다: 같은 이름의 폴더·파일·깨진 링크가 있으면 거절하고, 폴더 자체는 재귀로 만들지 않으므로 확인 뒤에 생긴 이름도 거절된다 | `projectFolderTarget`, `makeProjectFolder` (`dev-services/project-folder.ts`) |
| 준 `parent`는 이미 있는 폴더의 전체 경로여야 하고, 만들지 않는다 | 같은 곳 |
| `parent`가 없으면 그 머신의 `~/Centralu`. 없으면 만든다 | `projectsHome` |

**기본 위치는 모든 머신에서 `~/Centralu`다**: macOS와 Linux(WSL 포함)는 `~/Centralu`, Windows는
`%USERPROFILE%\Centralu`(`projectsHome`, 플랫폼 모듈. 이름은 protocol의 `PROJECTS_DIR`이고 목도 이것을 보여 준다).
처음 쓸 때 만든다.

| 결정 | 이유 |
|---|---|
| 바탕화면이 아니라 `~/Centralu`(오너, 2026-10-12. #515의 첫 빌드는 바탕화면을 썼다) | 권한 창이 없다: macOS에서 바탕화면은 보호된 폴더라, 처음 들여다볼 때(대화상자에 이름을 입력할 때) Centralu 이름으로 접근 권한을 물었다. 홈의 폴더는 보호되지 않는다. 눈에 보인다: 사람이 자기 작업을 찾는 Finder나 탐색기에서 보인다. 어디서나 한 규칙: 바탕화면 알려진 폴더를 찾지 않고(Windows의 PowerShell, Linux의 XDG), 바탕화면이 없는 WSL 배포판이나 서버도 노트북과 같은 폴더를 쓴다 |
| 데이터 폴더(`~/.centralu`)와 따로 | 데이터 폴더는 앱의 것이라 제거할 때 지워질 수 있다. 프로젝트는 사람의 작업이라 함께 지워지면 안 된다 |

호스트는 `main.ts`가 연결해 줄 때만 기본 위치를 안다(`SessionManager.useProjectsHome`). 없으면 `parent` 없는
호출은 거절된다. 그래서 테스트와 linked-hosts e2e(임시 `HOME`의 `Centralu`를 준다)는 실행하는 사람의 홈에 손대지
않는다.

**빈 폴더 대신 클론**(`source: { git, branch? }`, #515에 오너가 덧붙인 것). 폴더는 같은 규칙으로 먼저 빈 채로
만들고, 그 안에 `git clone -- <url> <folder>`를 돌린다(`dev-services/project-clone.ts`):

| 규칙 | 방법 |
|---|---|
| 그 머신의 git과 로그인 | 프로젝트가 사는 머신의 호스트가 `runGit`으로, 사람의 git 설정 그대로 클론한다(갓 만든 클론에는 자기 설정도 훅도 없어서, 저장소가 고른 것은 아무것도 돌지 않는다) |
| 로그인을 묻지 않는다 | `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`·`SSH_ASKPASS=`(빈 값, git이 건너뛴다), `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`(Git Credential Manager는 저장된 것만 쓰고 창을 띄우지 않는다), 사람이 자기 ssh 명령을 정하지 않았으면 `GIT_SSH_COMMAND='ssh -o BatchMode=yes'`. 그 머신에 저장되지 않은 로그인이 필요한 저장소는 바로 한 문장으로 실패한다 |
| 주소 | `https://`, `ssh://`, scp 꼴 `user@host:path`만(`gitSourceError`, protocol). 거절: `ext::`와 모든 `<transport>::`, `file://`와 로컬 경로(에이전트가 사람의 폴더를 자기가 읽는 프로젝트로 복사하게 만들 수 있다), `git://`·`http://`(인증·암호화 없음), `-`로 시작하는 주소나 호스트, 주소에 적은 비밀번호(`.git/config`에 남고 카드에 보인다). 리다이렉트에 대비해 `protocol.ext.allow=never`, `protocol.file.allow=never`도 넘긴다 |
| 서브모듈 없음 | `--recurse-submodules`를 쓰지 않는다: 그 주소는 사람이 승인한 것 너머에서 저장소가 고른다 |
| 이름 | `name`이 비면 저장소 이름(`repoNameOf`: 마지막 경로 조각에서 `.git`을 뺀 것) |
| 실패하면 아무것도 남지 않는다 | 그 클론을 위해 만든 폴더를 지우고 프로젝트를 등록하지 않는다. 실패마다 한 문장(`cloneFailure`: 없는 로그인·브랜치·호스트·저장소, git 없음, 10분 초과) |
| 시간 | 호스트는 10분이 지난 클론을 멈춘다. 창의 호출은 180초(`LONG_CALLS`), 연결된 머신 한 단계는 200초를 기다리고, 그 뒤로는 대화상자가 아직 클론 중이라고 말하며 프로젝트는 끝나면 목록에 들어온다(`projects_changed`) |

https로 서비스하는 로컬 bare 저장소를 상대로 끝까지 시험한다(정적 서버로 git의 dumb 프로토콜, `GIT_SSL_CAINFO`로
믿게 한 자체 서명 인증서, 사람의 git 설정은 빼고). 로그인이 필요한 저장소로 401을 답하는 경로도 포함한다
(`sessions/clone-project.test.ts`).

**오케스트레이터의 `create_project { name?, parent?, git?, branch? }`**는 사이드바의 Add project 버튼에 불만 켜던
`propose_project`를 대체했다. 오케스트레이터 자신의 승인 자리에 카드를 띄우고(`project_create`: 이름, 전체
경로, 클론이면 저장소와 브랜치), 호출은 `ask_project`의 동의 카드처럼 답을 기다린다(`askHost`). 사람이 만들기를 누르기 전에는 아무것도
만들지 않는다. "항상"은 허용으로 읽고 아무것도 기억하지 않으며, 거절하거나 호출이 멈추면 아무것도 만들지 않는다.
대상은 카드 전에(거절은 사람에게 아무 비용이 없다) 그리고 카드 뒤에 다시 확인한다. 이렇게 만든 프로젝트는
`projects_changed`로 알리고, 모든 창이 프로젝트 목록을 다시 읽는다. 오케스트레이터만 가진 도구이고
(security-boundaries.md) 이 컴퓨터에만 만든다: 허브의 오케스트레이터는 연결된 머신을 보지 못하므로 그 머신의
프로젝트는 Add project에서 그 머신을 골라 만든다. 클론이면 만들기를 누른 뒤 호출이 도는 동안 오케스트레이터 대화에 "Cloning … into …"라고 알린다.
이 교체로 오케스트레이터가 늘 싣는 정의는 전보다 작아졌다(`residentCost`, Claude: 11,798 → 11,620자, 클론 인자까지
11,770자; docs/tool-cost.md).

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
  sleep?: boolean               // #568: 유휴 세션을 재울 수 있다(재개가 캐시를 지킨다고 측정됨). §4.6.1
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
  - **실행 중인 작업은 호스트 교체를 넘어 살아남는다** (#648). 도구는 목록이 바뀔 때만 알리고 시작할 때는 아무 말도
    하지 않으므로, 넘겨받은 프로세스를 입양한 호스트는 모든 세션을 유휴로 읽었고, 재우기나 정의 새로 고침이 돌고 있는
    개발 서버 위로 프로세스를 닫았다. 매니저는 바뀔 때마다, 그리고 프로세스가 시작할 때(새 프로세스는 비어 있음) 실행
    중인 집합을 저장소에 쓴다(`background_tasks:<id>`). 프로세스를 입양하는 호스트는 그 기록으로 세션의 목록을 채우고
    어댑터에도 넘기며(`ProcessSource.adopt.backgroundTasks`), 어댑터의 추적기는 그것으로 씨를 뿌려 작업이 끝나는 것을
    알린다(타이머는 제외한다. 대화 기록에서 다시 읽는다). 기록이 없는 세션(이전 호스트가 기록 이전 빌드)은 도구 자신의
    전체 목록(`snapshot`이 붙은 `background_tasks`, Claude의 `background_tasks_changed`)이 오거나 두 시간 동안 아무 말이
    없을 때까지 `background_unknown`이며 재우지 않는다. 두 시간이 지나면 로그를 남기고 없음으로 기록한다. 끝남이나
    타이머로 만든 목록은 이 상태를 풀지도, 기록되지도 않는다. 세션을 지우면 기록도 지운다.
  - **재시작과 백그라운드 작업** (#648). 안전을 바꾸는 재시작(권한 프리셋, 실행 설정, 프로필이 내주는 도구 정의)은
    턴만 기다린다. 유휴 세션은 바로 다시 띄우고, 턴 중의 변경은 백그라운드에서 무엇이 돌든, 모르든 턴이 끝날 때
    적용한다. 그 밖의 미뤄진 재시작(모델, 앱 묶음)은 목록에 오른 백그라운드 작업이 도는 동안 최대 한 시간까지 더
    기다린다(`sessions/restart-policy.ts`의 `RestartPolicy.applyDeferredRestart`). 백그라운드 작업을 끝내게 되거나 그 작업을 모르는 재시작은 먼저 대화에 그 사실을
    알린다(작업 이름을 담은 `restart` 알림).
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
| Claude (재개) | 재개한 프로세스가 살아 있는 프로세스처럼 프롬프트 캐시를 읽는지 (#568, §4.6.1): 유휴 세션을 재우는 것이 공짜인 이유 | `pnpm exec tsx packages/agent-host/scripts/probe-resume-cache.mts` (실제 모델, haiku, 임시 데이터 폴더. 깨운 턴이 캐시에서 90% 미만을 읽으면 1로 끝난다) | 재개할 때 요청을 다르게 짜는 CLI: 세션은 여전히 깨어나지만 더 느리고 비싸지고, 다른 무엇도 그것을 알려 주지 않는다 |

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
                  → a session that was mid-turn is reset to idle with a `quit` marker (§4.6.2)
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

**데이터 폴더 하나에 호스트 하나** (`dev-services/instance-lock.ts`). 한 폴더에 호스트가 둘이면 각자 제 세션 목록을 들고 같은 `store.db`에 쓴다. 소유권은 호스트가 살아 있는 내내 쥐는 배타적 SQLite 트랜잭션이다(`host-ownership.sqlite`에 `BEGIN EXCLUSIVE`, DELETE 저널 모드) (#82). 잡는 일은 원자적이고, 두 번째 호스트는 곧바로 거절되며, 호스트가 어떻게 죽든 운영체제가 풀어 주므로 크래시가 낡은 흔적을 남기지 않는다. `host.lock`(pid와 시작 시각)은 충돌 메시지에 주인을 적는 설명으로만 남는다: #461 전까지는 그 파일만 아는 #82 이전 호스트를 위해 살아 있고 맞아떨어지는 `host.lock`도 시작을 거절했다. #82 전에는 파일 하나를 확인하고 나서 쓰는 방식이라, 동시에 띄운 호스트 8개에서 주인이 2개 나왔다. 한 기계 안의 소유권이다 — 분산 임대가 아니고, 네트워크 파일시스템 위의 데이터 폴더용도 아니다.

### 4.0 플랫폼별로 호스트가 뜨는 방식

목록은 여기 하나다. 창은 키퍼 크레이트의 순수 함수 하나, `start_plan::plan`
(`apps/desktop/src-tauri/keeper/src/start_plan.rs`)에서 아는 것으로 정한다: OS, 디버그인지 릴리스인지, 아래 변수들,
리소스에 번들된 호스트가 있는지, `<data>/keeper.sock`에 키퍼가 답하는지, 이 창이 사는 동안 셸이 이미 한 번 물러났는지.
모든 시작 지점이 이것에 묻는다: 창의 첫 시작과 재시도, 그리고 키퍼를 띄울 때마다. 아래 각 행은 표 테스트
(`every_row_of_the_start_table`)의 한 행이고, 두 번째 테스트는 그 사실들의 모든 조합을 이 함수가 대신한 코드와 맞대 본다.

`centralu --keeper`는 이제 시작 지점이 아니다(#461). 창의 실행 파일은 디버그 창이 `CC_KEEPER_IN_PROCESS`와 함께 띄웠을
때만 키퍼를 돈다(`KeeperInProcess` 행). 다른 누가 그렇게 띄우면 창을 열지 않고 곧바로 64로 끝난다
(`keeper::exe::run_from_window`). 0.1.0-beta.16까지는 옆의 `centralu-keeper`로 `exec`했다: 새 빌드의 창 실행 파일을
`centralu --keeper --take-over-fd 3 ...`로 띄워 넘겨주는 0.1.0-beta.11 이하의 키퍼와 #440 이전의 창 때문이었다. 그런
키퍼는 이제 `ready`를 듣지 못해 되돌아가고, 창은 "완전히 다시 시작"을 내놓는다. 창 옆에 `centralu-keeper`가 없는
번들(손으로 조립한 것)은 창의 실행 파일 안에서 키퍼를 돌렸지만, 이제는 키퍼를 띄우지 못하고 그렇다고 말한다.

| 어디서 | 변수 | 방식 | 무엇이 도는가 | 이유 |
|---|---|---|---|---|
| macOS 릴리스 | 없음 | `ThroughShell` | 창이 LaunchServices로 `<data>/shell/Centralu.app`을 열고, 셸이 `<data>/content/<version>/`에서 `centralu-keeper`를, 그 검증된 사본에서 호스트를 띄운다(§4.1) | 셸이 업데이트를 건너 macOS 권한을 쥔다([plans/thin-shell.md](plans/thin-shell.md)) |
| macOS 릴리스 | `CC_SHELL_UNPINNED=1` | `ThroughShell` | 같고, 창이 고정되지 않은 셸을 싣고 있어도 연다 | 임시 `CC_DATA_DIR`로 손수 경로를 확인할 때 |
| macOS 릴리스, 셸이 물러남(거절, 안 실림, 고정 안 됨, 설치 실패, 열리지 않음, 보고 없음) | 없음 | `KeeperBeside` | 창이 자기 실행 파일 옆의 `centralu-keeper`를 띄우고, 호스트는 `<data>/hosts/<key>/`에서 돈다 | 에이전트는 계속 돌아야 한다. 창이 사는 동안 계속 이렇게 한다 |
| macOS 릴리스 | `CC_KEEPER_HOST_SOURCE`(값 무관) | `KeeperBeside` | 창 옆의 키퍼가 그 폴더를 돌린다(빈 값이면 번들된 호스트) | 키퍼 스크립트가 호스트를 지정하는 방법이고, 셸은 그 호스트를 돌리지 않는다 |
| 번들된 호스트가 없는 macOS 릴리스(`cargo run --release`) | 없음 | `KeeperBeside` | 창 옆의 키퍼, 소스 호스트, 개발용 데이터 폴더 | 셸이 검증할 것이 없다 |
| 키퍼가 이미 답함 | | `Attach` | 아무것도 띄우지 않고 붙는다 | 데이터 폴더 하나에 키퍼 하나 |
| macOS 디버그(`pnpm app:dev`) | 없음 | `Direct` | 창이 tsx로 소스 호스트를 돌린다, `CC_DEV=1` | 키퍼 이전처럼 앱이 호스트의 부모다. `target/debug`에 남은 번들 호스트는 무시한다 |
| macOS나 Linux 디버그 | `CC_USE_KEEPER=1` | `KeeperInProcess` | 창이 `CC_KEEPER_IN_PROCESS=1`과 함께 자신을 `centralu --keeper`로 띄우고, 키퍼는 소스 호스트를 돌린다 | `tauri dev`는 창만 빌드하므로 옆의 `centralu-keeper`가 더 오래된 코드일 수 있다([architecture.md](architecture.md) §4.1) |
| 어디서나 | `CC_HOST_CMD`(값 무관) | `Direct` | 그 명령줄(빈 값이면 번들된 호스트나 소스 호스트) | 다른 호스트를 돌리는 비상구 |
| Linux 릴리스(AppImage, deb, rpm) | 없음 | `Direct` | 창이 시스템 Node로 번들된 호스트를 돌린다 | 키퍼가 AppImage 안에서 돈다: 더 새 AppImage의 빌드로 전환하면 그 AppImage의 마운트에서 돌게 되는데, 그 마운트는 그 창이 끝나면 사라지고, 그 뒤 디버그 키퍼는 SIGBUS로 죽었다. 먼저 사본에서 돌아야 한다([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md) §6, #295) |
| Linux 디버그 | 없음 | `Direct` | tsx로 소스 호스트 | 위와 같다 |
| Linux 릴리스 | `CC_USE_KEEPER=1` | `KeeperBeside` | 창 옆의 키퍼(AppImage의 `usr/bin/`) | macOS 밖에는 셸이 없다 |
| Windows, 릴리스와 디버그 | `CC_USE_KEEPER`는 무시 | `Direct` | 번들된 호스트(릴리스)나 소스 호스트(디버그), 콘솔 창 없이(§1) | 키퍼는 unix 소켓, 디스크립터 전달, `flock` 위에 지어졌다 |

창이 정하지 않는 것, 각자 제자리에서:

| 무엇 | 어디서 정하는가 |
|---|---|
| 열린 셸이 하는 일: 설치할지 둘지, 고정됐는지, 검증, 복사, 거절 이유 | 창의 `shell::prepare`, `shell::install::plan`, `shell::start::start`, 그리고 셸 크레이트([plans/thin-shell.md](plans/thin-shell.md) §10.1, §10.2) |
| 직접 띄운 키퍼의 넘겨주기(§4.4): 창이 지정한 `centralu-keeper`로(#444부터). 다른 이름의 실행 파일(#440 이전의 창은 제 실행 파일을 지정한다)은 거절되고 키퍼는 제 빌드에 남는다(#461) | `server::switch`, `server::upgrade`, `handoff::give` |
| 검증된 콘텐츠에서 뜬 키퍼의 넘겨주기: 새 콘텐츠를 검증하고 복사한 뒤 `<data>/content/<new>/centralu-keeper`로 넘겨준다 | `server::content_route`(§4.4) |
| 원격의 `centralu serve`: npm 런처가 시스템 Node로 번들된 호스트를 돌린다. 창도 키퍼도 없다 | `packaging/npm/centralu/bin/serve.mjs`(§4.7) |
| `pnpm dev`와 e2e: `pnpm host`가 소스 호스트를 돌린다. 창도 키퍼도 없다 | `CONTRIBUTING.md` |

### 4.1 호스트를 쥐는 쪽: 키퍼 (#280, 옵션 C 1단계)

패키지된 앱에서 호스트의 부모는 앱이 아니라 키퍼다(`centralu-keeper`, 창의 실행 파일 옆에 있는 자기 실행 파일, #440;
[architecture.ko.md](architecture.ko.md) §4.1). 키퍼는 호스트를 `--port 0 --watch-parent --db <data>/store.db`와
`CC_DATA_DIR=<data>`로 띄우고, stdin 파이프를 쥐며, 앱이 쓰던 규칙 그대로 다시 띄운다: 연속 실패 다섯 번,
30초 안정 가동이면 횟수 초기화, 잠금 충돌이나 더 새 빌드만 읽을 수 있는 store면 곧바로 멈춤(`host_proc/`,
키퍼와 앱의 직접 경로가 함께 쓴다: 모든 OS가 함께 쓰는 로직은 `mod.rs`, OS마다 다른 프로세스 메커니즘은
keeper 크레이트의 OS 계층 `src/os/`, 키퍼의 호스트 넘겨주기는 `handover.rs`, Node 찾기는 `node.rs`). 키퍼가 죽으면 호스트는 그 파이프에서 EOF를 보고 스스로 내려간다.

**키퍼를 띄우는 쪽.** `<data>/keeper.sock`에서 답하는 키퍼가 없을 때 창이 띄운다. macOS 릴리스는 먼저 셸에게
맡긴다([plans/thin-shell.md](plans/thin-shell.md) §6, §10.2, 창의 `src/shell/`): 자기가 싣고 온 셸로
`<data>/shell/Centralu.app`을 설치하거나 올리고, LaunchServices로 연다(`/usr/bin/open -n -g -a <shell> --args
--content <bundle>/Contents/Resources/content --data-dir <data> --bundle-path <bundle> --nonce <n>`). 그리고 그
nonce가 적힌 `<data>/shell-status.json`을 최대 45초 기다린다. 셸은 서명된 콘텐츠를 검증해 `<data>/content/<version>/`에
복사하고, 창이 쓸 것과 같은 명령줄(`keeper::exe::Start`)로 거기서 `centralu-keeper`를 띄운다. 그래서 키퍼와 그 아래
모두를 macOS는 셸로 판단한다. 셸이 거절하거나 보고하지 않으면 창은 다른 모든 빌드처럼 자기 번들에서 키퍼를 직접
띄우고(창이 살아 있는 동안 계속), 그 이유를 `host_build`(`shell`)에 남긴다. 릴리스는 빌드 바에 보여 주고, 셸이
고정되지 않은 빌드(로컬 `pnpm app`, 리허설)는 `keeper.log`에 `[window]` 줄로만 적으며 그 셸을 설치하지도 열지도
않는다. 디버그 빌드, `CC_KEEPER_HOST_SOURCE`, Linux와 Windows는 전처럼 키퍼(또는 호스트)를 직접 띄운다(§4.0).

**빌드별 사본.** 띄울 때마다 키퍼는 번들의 `resources/host` 폴더를 `<data>/hosts/<key>/`에 복사하고(임시 폴더에
쓴 뒤 rename) 거기서 `main.mjs`를 돌린다. key는 `bundle-info.json`에 찍힌 커밋이다. `-dirty`나 `unknown`
빌드는 빌드 시각을 덧붙여, 서로 다른 dirty 빌드가 사본을 함께 쓰지 않는다. 호스트가 준비되면 그 호스트가 돌지
않는 사본을 지우되, 띄우기나 교체가 붙잡은 사본은 남긴다(`source::Copies`): 띄우기는 키퍼가 그 사본을 도는 호스트의
것으로 적을 때까지, 교체는 새 호스트를 넘겨받거나 포기할 때까지 붙잡는다. 복사와 정리는 한 잠금을 거치고, 정리는
호스트가 어느 사본에서 도는지를 도는 그때 읽으며, 스스로를 넘겨주는 키퍼는 얼릴 때 둘 다 멈춘다. 붙잡기가 없을 때는
키퍼가 막 넘겨받은 호스트가 부른 정리가 교체가 방금 만든 사본을 지웠다("Cannot find module
.../hosts/<key>/main.mjs", #368). 온전한 사본은 원래 폴더가 사라져도 그대로 쓴다: Linux에서 그 폴더는 AppImage
안에 있어 누군가 붙들고 있는 동안만 마운트되고, 더 새 AppImage의 창에게서 넘겨받은 키퍼는 그 창의 마운트보다 오래
산다([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md) §6).

셸이 띄운 키퍼(자기 실행 파일이 `<data>/content/<version>/`에 있는 키퍼)는 사본을 만들지 않는다: 호스트를 검증된
사본의 `host/` 폴더에서 그대로 돌린다. 그 폴더는 읽기 전용이고 서명된 매니페스트와 대조를 마쳤다
([plans/thin-shell.md](plans/thin-shell.md) §5, §10.3). 같은 잠금이 그 `content/<version>` 폴더들도 붙잡고, 정리는
아무 붙잡기도 없고, 키퍼 자신의 것도 아니고, 호스트가 돌거나 다음에 돌 곳도 아닌 버전을 모두 지우며, 죽은 복사가 남긴
`.partial-*` 폴더도 지운다.

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
| `{"op":"stop"}` | 호스트와 키퍼를 멈춘다("Quit completely", 그리고 창이 이어서 자기 빌드의 키퍼를 띄우는 "Restart completely") |
| `{"op":"switch","source":…,"keeper":{"exe":…}?}` | 그 빌드로 블루그린 교체(§4.2, 빌드 표식은 그 폴더에서 다시 읽는다). 떠 있는 호스트가 없으면 다음 시작이 그 빌드를 돌린다. `keeper`가 있고(앱은 제 빌드의 `centralu-keeper`를 보낸다. #440 이전의 앱이 보내던 제 실행 파일은 #461부터 거절되고 키퍼는 제 빌드에 남는다) 키퍼가 다른 빌드면, 키퍼가 먼저 그 빌드의 키퍼에게 스스로를 넘기고([architecture.ko.md](architecture.ko.md) §4.4) 그 키퍼가 교체를 한다. 검증된 콘텐츠에서 도는 키퍼는 번들에서 아무것도 띄우지 않는다: 번들의 서명된 콘텐츠를 검증해 복사하고 그 사본 안의 키퍼에게 넘긴다(§4.4). 거절되면 교체는 `refused`가 채워진 `failed`로 끝난다. 교체 중의 두 번째 `switch`는 거절한다 |
| `{"op":"upgrade","exe":…,"source":…}` | 호스트는 그대로 두고, 키퍼를 `exe`에 있는 `source` 빌드의 키퍼에게 넘긴다(§4.4). 검증된 콘텐츠에서 돌면 `exe`가 든 번들의 콘텐츠를 검증한 사본 안의 키퍼에게 넘긴다 |
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
`--no-claude --no-codex`를 붙인 `keeper-children-integration.mjs`와 `keeper-handoff-integration.mjs`, 이어서 셸의 것
(`shell-integration.mts`)과 검증된 콘텐츠에서의 넘겨주기(`keeper-content-integration.mts`, §4.4). 이 잡이 있는
까닭은 이 중 어느 것도 단위 테스트나 e2e에 드러나지 않기 때문이다: 서버가 생기기 전에 넣은 #329의 `await`가 터미널을
쥔 호스트의 재시작을 모두 크래시시켰고(#348), 알아챈 것은 손으로 돌린 children 스크립트뿐이었다. claude와 codex
턴은 손으로 돌리는 채로 남는다. 각 스크립트는 통과하든 실패하든 자기가 띄운 프로세스와 그것들이 띄운 것까지 모두
끝낸다. 이름이 아니라 프로세스 표 하나로 찾는다(`scripts/keeper-test-processes.mjs`). 검사가 실패하면
`keeper.log`와 `host.log`의 끝을 찍는다. `keeper e2e (linux)` 잡은 같은 스크립트와 키퍼 크레이트의 단위 테스트를
ubuntu-24.04에서 돌린다. 그곳의 첫 시도(2026-10-05)는 스크립트 자신에게 SIGTERM이 닿아 끝났다: 멈추는 길이
`/bin/kill -TERM -<pid>`를 썼는데, procps-ng 4.0.4는 이것을 pid의 **첫 자리 숫자**가 가리키는 그룹에 보내므로 1로
시작하는 호스트 pid는 사용자의 모든 프로세스에 신호를 보냈다(#350). 이제 두 멈춤 함수 모두 `kill(2)`를 직접 부른다
([spikes/2026-10-linux-keeper.md](spikes/2026-10-linux-keeper.md)).

### 4.2 호스트에서 본 정문과 교체 (#280, 옵션 C 3단계)

설계는 [architecture.ko.md](architecture.ko.md) §4.2에 있다. 호스트가 하는 일:

**토큰과 주소는 키퍼에게서.** 키퍼 아래에서 호스트는 `CC_HOST_TOKEN`(정문의 토큰, 키퍼가 돌리는 모든 호스트에
같다)과 `CC_FRONT_DOOR`(`ws://127.0.0.1:<door>`)를 받고, 읽은 뒤 둘 다 환경에서 지워 터미널·에이전트·명령이
물려받지 않게 한다. Codex 브리지는 정문 주소로 띄운다(`swap-control.ts`, `bridgeAddress`): 도는 codex는 브리지를
계속 쥐고, 이 호스트보다 오래 사는 주소만 교체를 견딘다. 키퍼가 없으면 예전처럼 호스트 자신의 포트를 준다.

**브리지의 자격 증명** (#382). 브리지는 토큰을 받지 않는다. 대신 `CC_BRIDGE_TOKEN`을 받는데, 호스트의 토큰을 키로
한 세션 id의 HMAC이다(`transport/bridge-token.ts`). 같은 사용자의 어떤 프로세스든 브리지가 시작될 때의 환경을 읽을
수 있기 때문이다([security-boundaries.md](security-boundaries.md), "The front door"). 이것으로 hello한 연결은
클라이언트가 아니다: `hello_ok` 말고는 아무것도 받지 않고(재생도, 방송도, 터미널 출력도 없다), 호출할 수 있는 것은
`orchestrator.tools`, `orchestrator.tool`, `apps.sessionTools`, `apps.sessionCall`뿐이며, 그것도 자격 증명을
만든 세션을 이름으로 댈 때만이다. 키퍼 아래에서 키는 정문의 토큰이라서, 다음 호스트도 아무것도 넘겨받지 않고 돌던
브리지의 자격 증명을 받아 준다. 이 변경 이전의 호스트는 거절한다: 그런 빌드로 되돌아가면 새 빌드가 시작한 Codex
세션은 다시 시작할 때까지 Centralu 도구를 잃고, 브리지가 그렇게 말한다.

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
남기지 않는다. 키퍼는 8 MiB까지 쌓은 뒤 호스트를 읽지 않는다. 호스트가 읽기를 멈춘 제어 연결은 응답과 종료 이벤트가
8 MiB 쌓이면 끊기고, 키퍼 로그에 한 줄이 남는다: 그 호스트는 쥐고 있던 자식이 모두 SIGHUP으로 끝난 것으로 보고, 다시
시작할 때까지 새로 띄우지 못한다. 몰려온 바이트를 다 보내고 나면 이 버퍼들은 모두 1 MiB만 남기고 용량을 돌려준다.

**호스트가 거기서 띄우는 것.** 자식마다 호스트만 읽는 태그가 붙는다(`keeper/tags.ts`): `{kind:"agent", tool,
sessionId, version?}`(띄운 CLI 버전, #297, §4.6), `{kind:"terminal", id, cwd}`, `{kind:"command", cwd, command, runId, startedAt}`. 새 호스트는 옛 호스트의
태그를 계속 읽을 수 있어야 한다: 자식은 자기를 띄운 빌드보다 오래 산다.

- **에이전트.** 매니저는 어댑터에 `ProcessSource`(`adapters/contract.ts`)를 넘긴다: 키퍼에서 `spawn`하거나, 쥐어 둔
  프로세스를 `adopt`한다. claude는 이것을 `spawnClaudeCodeProcess`로 받고, `CodexClient`는 띄우는 대신 그 프로세스를
  받는다. `KeeperAgentProcess`는 둘이 쓰는 `ChildProcess`의 표면을 갖지만, `kill()`은 CLI의 프로세스 그룹 전체(아래)에
  대해 키퍼에 보내는 요청이고 프로세스를 놓았거나 호스트가 끝나는 중이면 결코 보내지 않는다(SDK는 주인이 끝날 때 자기
  프로세스를 kill한다). `stdin.end()`는
  `close_stdin`이다. codex 요청 id에는 클라이언트마다 접두사가 붙어, 이전 호스트의 요청에 대한 답이 우리 요청을 풀지 못한다.
- **터미널과 명령.** `TerminalService`와 `CommandRunner`는 node-pty 대신 키퍼의 pty 모듈(`KeeperPty`, node-pty의 표면)을
  받는다. 멈추거나 닫을 때는 프로세스 트리를 걷는다(`kill-tree.ts`). 어디서든 통한다. 터미널을 닫을 때는 셸이 끊김
  신호를 받기 전에 트리를 잡는다: 거기서 띄운 개발 서버는 자기 그룹에 있고(작업 제어), 끊김 신호를 무시하는 서버는 예전에
  계속 돌고 있었다.

**에이전트를 멈추면 끝나는 것.** 에이전트 CLI는 자기 도우미를 띄운다: Claude Code의 LSP 도구는
`typescript-language-server`를 띄우고 그것이 `tsserver`를 띄운다(하나가 3.4 GB까지 갔다). 사용자 설정의 MCP 서버, 셸도
있다. 도우미는 CLI의 프로세스 그룹을 함께 쓰고, `setsid`가 그 그룹을 CLI만의 것으로 만들었으므로 그룹은 CLI와 그것이
띄운 것뿐이다. 멈춤은 그 그룹에 신호를 보낸다: 호스트의 TERM과, 유예가 지나도 CLI가 남아 있을 때 뒤따르는 KILL(SDK는
5초, codex는 EOF 뒤 2초)이 도우미에게도 닿는다. 그리고 에이전트가 끝나면, 어떻게 끝났든(멈춤, 크래시, 정리하지 않는 CLI)
키퍼가 그 그룹을 쓸어 낸다: 곧바로 TERM, 2초 뒤 아직 남은 것에 KILL(`Sweep`, `keeper/children/mod.rs`). 예전에는 CLI의
pid에만 신호를 보냈고, 남은 것은 launchd/init으로 넘어가 메모리를 쥔 채 계속 돌았다. 그룹 번호는 그룹에 누가 남아 있는
동안 다시 쓰이지 않고, CLI의 pid를 어떤 프로세스든 쥐고 있으면(아직 거두지 않은 좀비, 또는 남에게 넘어간 번호) 쓸어 내기를
보내지 않으므로, 쓸어 내기는 다른 그룹에 닿지 않는다. 키퍼 자신의 그룹은 결코 대상이 아니다(#350). 아직 기다리는
쓸어 내기는 표와 함께 다음 키퍼에 넘어가고(§4.4), 아주 멈추는 키퍼는 쓸어 내기를 기다렸다가 마지막에 남은 것을 KILL한다.
pty는 쓸어 내지 않는다: 셸이 끝나면 커널이 터미널의 전경 그룹에 끊김 신호를 보내고, 호스트는 터미널이나 명령을 멈출 때
그 트리를 끝낸다. detach(재시작, 교체)는 아무것도 보내지 않으므로 에이전트와 도우미는 살아남는다.

키퍼가 없으면(Windows, `pnpm dev`, e2e, 디버그 앱, 자식 서비스가 답하지 않은 키퍼) 호스트가 CLI를 직접 띄운다. Claude도
`spawnClaudeCodeProcess`로 그렇게 한다(`adapters/local-process.ts`). macOS와 Linux에서는 CLI가 자기 프로세스 그룹을
갖는다. 멈춤은 `kill-tree.ts`의 방식이다: 트리의 모든 그룹에 TERM, 3초 뒤 살아남은 것에 KILL. 끝난 뒤에는 그 그룹을 같은
방식으로 쓸어 낸다(`stopGroup`). Windows에서 멈춤은 트리에 `taskkill /T /F`이고, 끝난 뒤에는 남긴 것을 부모 링크와 생성
시각으로 찾아 끝낸다(`collectOrphansWindows`). 자기 그룹에 있으므로 CLI는 더 이상 호스트의 그룹에 있지 않다: SIGKILL을
받은 호스트는 stdin EOF로만 그것을 데려간다. codex는 EOF에 바로 끝나고, claude는 하던 턴을 마치고 끝난다. SDK는 자기가
띄운 프로세스에만 실패 메시지에 CLI의 stderr 끝을 붙이므로, 어댑터가 같은 방식으로 붙인다.

**떠나기** (`main.ts`, `stopServices(mode)`). *detach* — SIGTERM, SIGINT, 키퍼 파이프가 닫힘, 잡히지 않은 예외,
교체의 드레인 — 는 모든 세션 핸들·터미널·명령 실행에 `detach()`를 부른다: 도구에는 아무것도 보내지 않고, 기다리는
승인은 계속 기다리며, 오는 중이던 출력은 저장소가 닫히기 전에 기록한다. 앱 프로세스와 in-process 도구 서버는 호스트에
살므로 멈춘다. *stop* — 키퍼의 `stop` 이벤트, 또는 자식 서비스 없는 모든 끝 — 은 예전 경로다: 세션을 정리하고 터미널과
실행을 죽인다. stop 뒤에는 남은 것을 키퍼가 끝낸다(stdin EOF와 SIGHUP, 2초, 각 그룹에 TERM, 1초, KILL). 끝난
에이전트가 그룹에 남긴 것도.

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
| codex | `initialize`를 다시: `-32600 "Already initialized"`, 그 밖에 바뀌는 것 없음. `thread/resume`: `thread.status`는 `active`/`waitingOnApproval`, 도는 턴은 `thread.turns`에(Stop에 필요한 id), 승인은 같은 요청 id(`0`)로 다시 왔고, 수락하자 턴이 끝났다. #342부터 resume은 턴을 달라고 하지 않고(`excludeTurns: true`), 도는 턴은 스레드가 `active`일 때만 `thread/turns/list`(`limit: 1`, 최신부터, `itemsView: 'notLoaded'`)로 묻는다. 0.160.0에서 다시 측정(2026-10-05): 턴은 `inProgress`로 왔고, 기다리던 승인은 여전히 같은 id로 다시 왔다. 이 플래그를 모르는 Codex는 턴을 실어 답하고, 그것을 예전처럼 읽는다. 스레드의 MCP 서버는 다시 띄우지 않는다(resume에 설정한 탐침 서버는 뜨지 않았다). 브리지가 정문의 주소와, 키퍼가 돌리는 모든 호스트가 받아 주는 자격 증명을 갖는 이유가 이것이다(§4.2). |

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

**검증된 콘텐츠에서** ([plans/thin-shell.md](plans/thin-shell.md) §10.3). 셸이 띄운 키퍼는 `<data>/content/<version>/`에서
돌고 서명된 코드만 띄워야 하므로, 넘겨줄 때 창이 건넨 키퍼 실행 파일을 그 번들의 `Contents/Resources/content`를 가리키는
표지로만 쓴다. 그 콘텐츠를 셸의 규칙과 키로 검증하고(서명, 플랫폼, 목록에 든 키퍼와 호스트,
`<data>/content/highest-started` 아래가 아닐 것), `<data>/content/<새 버전>/`에 복사하거나(그 자리에서 검증되는 사본은
그대로 쓴다), 그 사본 안의 키퍼에게 `--host-source`로 사본의 `host/`를 주어 넘긴다. `switch`라면 이어서 교체하는 호스트도
바로 그 폴더다. 넘겨받은 키퍼는 서기 시작하면 바닥을 자기 버전으로 올린다. 거절(`content`, `downgrade`, `copy`,
`in-use`, `no-content`)이면 아무것도 움직이지 않는다: 키퍼와 호스트는 계속 서고, 창은 `refused`에 이유가, `message`에
문장이 담긴 실패한 교체를 본다. 되돌리기는 셸로만 한다. 호스트는 이 중 아무것도 알아채지 않는다: 자기가 도는 곳은 여느
사본과 같은 폴더다. 직접 띄운 키퍼(디버그 빌드, Linux, 창의 대체 시작)는 위처럼 받은 실행 파일에게 넘긴다.
`scripts/keeper-content-integration.mts`가 일회용 키를 믿는 테스트 셸과 테스트 키퍼, 실제 호스트, 세는 터미널로 이것을
돌린다: 바뀐 콘텐츠와 더 오래된 콘텐츠는 모두 계속 선 채로 거절되고, `content/0.2.1/`로 넘겨줘도 호스트·터미널·정문이
같으며, 호스트가 새 사본으로 옮겨 가고, 아무것도 돌지 않게 된 옛 버전 폴더는 지워진다.

### 4.5 호스트에서 본 업데이트 적용 (#352)

설계는 [architecture.ko.md](architecture.ko.md) §4.5에 있다. 호스트의 몫은 설치와 규칙 하나다.

**설치** (`updates.ts`). `updates.apply`는 `npm i -g centralu@<v>`를 돌리고, 설치된 앱이 있으면 `centralu install`을
돌린 뒤 `restart_required`를 알린다. 아무것도 다시 띄우지 않는다. `autoApply`가 켜져 있으면("Apply updates
automatically when idle", `updates.setAutoApply`, 저장소의 앱 설정에 `updates.autoApply`로 저장, 기본 꺼짐) 새 버전을
찾은 확인이 같은 설치를 스스로 시작하고, 새 버전을 이미 아는 상태에서 설정을 켜면 바로 시작한다. 진행 중이거나 이미
끝난 설치 위에서는 하지 않는다: 그 뒤의 확인은 `restart_required`를 건드리지 않으므로 설치는 한 번이다. 실패한 설치는
다음 설치 시도까지 그 오류를 유지하며, 확인이 지워 주지 않는다(#636). `autoApply`가 켜져 있으면 호스트가 메모리에 둔
타이머로 10분, 1시간, 그 뒤 6시간마다 스스로 다시 시도한다(#645): 지연 전에 오는 확인은 아무것도 시작하지 않고, 지연 뒤의
확인은 마찬가지로 다시 시도하며, 실패한 것과 다른 릴리스는 바로 시도한다. 성공, 설정 끄기, 종료가 재시도를 끝낸다.

설치 전에 `updates.apply`는 레지스트리를 다시 묻는다(#635). 아는 새 버전이 없으면(자동 확인 꺼짐, 또는 오래된 "최신"
답) 거절하지 않고 먼저 다시 물어, 새 것이 없으면 그것을 결과로(`idle`, 오류 없음) 알리고 `failed`로 두지 않는다(#645).
호출은 대상이 정해질 때 답한다. 릴리스의 기준은 npm이므로, 설치된 복사본은
어떤 릴리스 버전이든(더 높은 것도) 대상으로 바뀐다: `latest`에서 내려간 릴리스가 /Applications에 남아 "Apply now"로
제안되면 안 된다. 그대로 두는 복사본은 대상보다 새로운 관리자의 로컬 빌드(`<base>.local.N`, `pnpm local-update`,
#610/#613) 하나뿐이다. 그 모양의 올바른 SemVer가 아니거나 읽을 수 없는 버전은 바뀐다: 깨진 plist나 버전 파일이
업데이트를 막을 수 없다. 버전은 런처와 같은 방법으로 읽는다(macOS는 번들 `Info.plist`에 `plutil -extract
CFBundleShortVersionString raw`, XML·바이너리 모두; Windows는 런처의 `centralu-version.txt`). 로컬 빌드를 두면 패키지만
올리고 `restart_required`에 그 사실을 적는다. `centralu install`도 같은 규칙을 스스로 적용하고, `--force`로 일부러 바꿀
수 있다(#645).

두 명령 모두 셸 없이 `tool-launch.ts`를 거쳐 돈다(`updates.ts`의 `commandFor`): Windows에서 `npm`과 `centralu`는
배치 파일이라 `execFile`이 이름으로도(ENOENT) 경로로도(EINVAL) 띄우지 못하므로, 각 파일을 읽어 그것이 띄우는 `.js`를
호스트의 Node로 돌린다. 갱신하는 설치된 앱은 `installedCopyPath()`, 곧 플랫폼별 런처의 `installedPaths()[0]`이다(테스트가
둘을 묶어 둔다). 실패는 어느 쪽이 실패했는지 말한다: npm 자신의 마지막 줄(로그 위치 안내 줄은 건너뛴다), 또는 npm은
됐고 복사본만 안 됐으면 런처의 첫 줄과 복사본 경로, 그리고 손으로 마칠 `centralu install`.

**Windows에서는**, 2026-10-08 Windows 11에서 임시 npm prefix와, 실행 중인 앱과 같은 핸들을 쥔 대역(폴더에서 띄운
exe, 매핑된 호스트의 `better-sqlite3`·`node-pty` 모듈)으로 측정했다:

| 단계 | 일어나는 일 |
|---|---|
| `npm i -g centralu@<v>` | 앱이 설치된 복사본에서 돌든 npm 패키지 안에서 돌든 성공한다 |
| `centralu install` | `%LOCALAPPDATA%\Programs\Centralu`를 `Centralu.old-<시각>`으로 비켜 이름을 바꾸고, 조립한 `Centralu.new`를 그 자리로 옮긴다. NTFS는 exe와 네이티브 모듈이 쓰이는 중에도 이 이름 바꾸기를 허용하고, 어떤 프로세스의 작업 디렉터리가 안에 있을 때만 거부한다. 파일 탐색기는 exe를 그 폴더에서 띄우고 호스트가 그것을 물려받으므로, 앱은 시작할 때 자기 폴더에서 작업 디렉터리를 옮긴다(`src-tauri/src/lib.rs`의 `leave_app_folder`). 비켜 둔 복사본은 옛 앱이 도는 동안 지울 수 없고, 다음 설치가 지울 수 있는 `Centralu.old-*`를 모두 쓸어 낸다 |
| 실행 중인 앱 | 열어 둔 파일은 그대로 쓴다. Windows는 exe를 원래 경로로 계속 보고하므로, 그 뒤 경로로 여는 것은 새 복사본의 것이다. 옛 창이 다시 띄운 호스트도 마찬가지다(그 경로에서 추론, 실행해 보지 않음) |
| "Apply now" | 제공되지 않는다: 키퍼가 없어 다시 띄우면 모든 에이전트가 멈춘다(`relaunch_info`). 줄은 "Restart Centralu to finish updating to <v>"라고 하고, 종료 후 시작 메뉴나 `centralu`로 다시 열면 새 복사본이 뜬다 |

0.1.0-beta.12까지의 빌드는 Windows에서 스스로 업데이트하지 못하고(호스트가 `npm`을 이름으로 돌렸다: "Update failed",
`spawn npm ENOENT`), 이 수정은 설치된 빌드가 된 뒤에야 돈다. 그 빌드로 올리려면 터미널에서 `centralu update`를 한 번
돌린다. 이것은 셸을 거치고 앱이 열려 있어도 된다.

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

**호스트 교체 뒤 시작 설정 (#589).**

키퍼가 보존한 프로세스는 이전 어댑터 정책으로 시작했을 수 있다. 어댑터의 버전이 있는
`launchSettingsFingerprint(settings)`를 세션별 앱 설정에 저장하고, 키퍼의 프로세스를
이어받은 뒤 비교한다. 값이 다르면 유휴 프로세스는 resume으로 다시 띄우고, 작업이나 승인을
기다리는 프로세스는 턴이 끝난 뒤 다시 띄운다. 잠든 세션은 프로세스가 없으므로 새 값만
기록한다. 호스트는 CLI 이름이나 지문의 내용을 해석하지 않으며, 시작 정책을 바꾸는 어댑터가
자기 지문을 바꾼다.

저장된 지문이 없는 경우도 불일치다. 이전 빌드가 보존한 프로세스의 시작 설정은 알 수 없으므로,
이 검사를 도입하는 업데이트에서는 각 보존 프로세스를 같은 안전한 경계에서 한 번 다시 띄우고
새 지문을 기록한다. 그 뒤 설정이 같으면 호스트 교체 때 다시 띄우지 않는다. 변경되거나 이전에
기록되지 않은 시작 설정은 캐시 재구축 원인 `launch_settings`("launch settings changed")로
보고하며, 재시작 로그는 "launch settings changed or previously unrecorded"라고 밝힌다.
`instructions`("tools changed")와 별개의 원인이다.

**능력 검사 자리** (#270). 설치된 CLI의 버전이 바뀔 때마다 서비스는 `capabilityCheck({ tool, from, to })`를 부른다.
#270은 버전이 바뀌면 도구가 못 하던 것에 대한 탐침을 다시 돌리자고 제안한다. 아직 구현한 것이 없으므로 기본값은
host.log에 그렇다는 줄 하나를 쓴다. 탐침은 여기에 꽂힌다.

### 4.6.1 유휴 세션 재우기 (#568)

세션마다 자기 에이전트 프로세스가 돌고, 유휴 상태에서도 메모리를 쥐고 있다: Claude 프로세스 하나가 몇 턴 뒤
240-300 MB였고 유휴 동안 자랐다(사흘 된 Opus 세션은 814 MB, #561). 끝내면 전부 돌아오고, 나중에 대화를 재개하면
살아 있던 프로세스처럼 프롬프트 캐시를 읽는다. #561에서 측정(CLI 2.1.29x, haiku): 1시간 수명에서 2, 6, 10분, 강제
5분 수명에서 2, 4분 뒤 다음 턴이 재개든 살아 있든 ~100%를 캐시에서 읽었고, 5분 수명의 6분에서는 둘 다 똑같이
만료됐다. 깨우는 비용은 첫 토큰까지 +0.7초(p50), +1.8초(p95). 그래서 호스트가 유휴 세션을 재운다
(`sessions/sleep.ts`, `SessionSleeper`). 도구가 아니라 호스트의 정책이다:

| 규칙 | 이유 |
|---|---|
| 살아 있는 세션이 정한 시간 동안 아무 말이 없으면(어떤 이벤트도 없으면) 잠든다: 기본 **15분**, 설정 → Background의 "Put idle sessions to sleep after"(`agents.setSleepPolicy`, `agents.sleepAfterMinutes`로 저장, 끄면 `off`) | 소유자의 결정(2026-10-12). Claude Code가 요청하는 1시간 캐시 수명 안이라 깨운 턴도 캐시를 읽는다 |
| 어댑터가 된다고 하는 도구만(`capabilities.sleep`): Claude는 예, Codex는 아니오 | Claude의 재개는 캐시를 지킨다고 측정됐다. 큰 Codex 스레드는 재개에 7-13초가 걸렸고 재개 때의 캐시는 측정하지 않았다. Codex의 메모리는 계정당 app-server 하나를 함께 쓰는 쪽(#561 E3)이 더 얻는다. 따로 정한다 |
| `sessionIdle`이 아니라고 하는 동안은 재우지 않는다: 턴, 기다리는 승인이나 질문, 백그라운드 작업(아래의 CLI 자신의 타이머 포함), 백그라운드 작업을 알리지 못하는 도구 | 새 CLI로 옮기는 규칙(§4.6)과 같다: 프로세스를 끝내면 그것이 쥔 것도 끝난다 |
| Never while it waits on others (`waitsOn`): a child it started with `start_agent` (or a session handling its ask_project task) still in the turn it gave it, a session it owns (`askedBy`; a former worktree manager's worktree sessions, #561) while that one works, or a session that owes it a report (`reportBack`) | Their answer comes back to it in moments, and waking it for that costs the resume it saved. A child waiting on its parent sleeps by the ordinary rule: it is idle |
| 이 호스트가 아직 소식을 듣지 못한 세션의 조용한 시간은 호스트 시작부터 센다 | 다른 호스트를 막 이어받은 호스트(재시작, 교체)는 사람이 1초 전에 무엇을 했는지 모른다 |
| 재우기는 `SessionManager.sleepSession`: 여전히 유휴가 아니면 거절하고, 핸들을 맵에서 빼고, `session_live {live: false, reason: 'asleep'}`를 보내고, 프로세스를 정리한다. 그 사이 온 메시지는 정리가 끝나기를 기다리는 재개를 시작한다(`sleeping`) | 한 대화에 프로세스가 둘이 되지 않고, 닫히는 핸들에 메시지를 잃지 않는다 |
| 깨우기는 보통의 `resumeSession`, 호스트 재시작 뒤 세션이 가는 길이다. 모든 재개는 `session_live {live: true}`를 보낸다 | 맞게 지킬 길이 하나다. 요청한 창만이 아니라 모든 창이 안다 |
| 프로세스가 떨어져 나가고 새 프로세스가 그 자리를 채우지 못했을 때도 `session_live {live: false}`가 나간다(#648): 호스트가 시작한 재시작(새로 고침, CLI 옮기기, "Restart agent")이 프로세스를 띄우지 못하면 `reason: 'restart_failed'`, 프로세스가 죽으면 `'crashed'` | 전에는 창이 세션을 계속 살아 있다고 보여 화면의 깨우기가 물러섰고, 사람은 보내기가 실패해야 알았다. 이제 잠든 것으로 보이고 다음 메시지가 깨운다 |
| 키퍼 아래에서는 정리가 맡겨 둔 자식을 멈춘다(stdin을 닫고 신호). 이어받은 호스트는 그 세션에 대해 넘겨받을 것이 없고, 잠든 채로 보여 주고, 새 자식으로 깨운다(`sleep-keeper.test.ts`). 훑기는 떼어 놓기 전에 멈춘다(`stopPlan`) | 교체 도중의 재우기는 다음 호스트가 넘겨받을 프로세스를 끝낸다 |
| 화면은 작성란이 키보드를 받거나 첫 키가 들어올 때, 그리고 보낼 때 세션을 깨운다. 고르거나 보기만 해서는 깨우지 않고, 그리드 패널도 시작할 때 깨우지 않는다 | 보는 세션이 곧 말을 거는 세션은 아니다. 재개는 사람이 입력하는 동안 돌아서 0.7초가 대부분 가려진다. #568 전에는 고르면 깨웠고, 느린 Codex 재개를 가리려고 시작할 때 그리드의 모든 패널을 깨웠다 |
| 잠든 상태는 조용히 보인다: 사이드바의 도구 표시는 같은 상태로 깨어 있는 세션과 똑같이 그려지고(흐리게 하면 멈춘 세션으로 읽힌다, #670) 툴팁만 "asleep"이라고 한다. 대화의 줄은 "Asleep — it wakes when you type to it", 깨어나는 동안은 "Waking session…" | 할 일이 있는 상태가 아니라서 색도 배지도 없다. 다만 첫 답이 왜 느린지 궁금한 사람은 알 수 있다 |

`CC_SLEEP_AFTER_MS`는 설정 위에 더 짧은 시간을 둔다(프로브와 테스트용). `probe-resume-cache.mts`가 실제
호스트로 깨운 턴의 캐시를 다시 잰다(§3.1). Claude Code를 업데이트할 때 돌린다. 첫 실행(2026-10-12, haiku,
`CC_SLEEP_AFTER_MS=20000`, 120초 더 조용히): 23초 뒤 잠들었고, 깨운 턴은 입력 26,198 토큰 중 99.7%를 캐시에서
읽었으며(그 전의 따뜻한 턴은 99.2%), 보내고 끝나기까지 4.6초가 걸렸다(따뜻할 때 2.3초, 재개와 대화 따라잡기 포함).

**CLI 자신의 타이머도 백그라운드 작업으로 센다.** `/loop`와 예약 프롬프트는 Claude 프로세스 안의
타이머(`ScheduleWakeup`, `CronCreate`)이고, CLI는 이것을 작업으로 알리지 않는다. 프로세스가 잠들거나 다시 뜨면
조용히 사라진다. Claude 어댑터가 호출과 구조화된 결과에서 읽어(`adapters/claude/normalize.ts`의
`ClaudeSchedules`) 기다리는 것마다 세션의 백그라운드 작업으로 올린다(kind `other`, 따로 멈출 수 없음). 그래서
`sessionIdle`은 `background`라고 한다. 깨우기는 `scheduledFor`까지(없으면 요청한 지연, 그것도 없으면 런타임의
최대 1시간), 또는 `ScheduleWakeup {stop: true}`까지 기다린다. cron 작업은 `CronDelete`가 그 id를 말하거나,
`CronList` 답에서 빠지거나, 7일 뒤 스스로 만료될 때까지다(한 번만 도는 작업도 보수적으로 그만큼 둔다). 어댑터는
다음 시각 1초 뒤에 다시 본다. 이전 호스트에서 넘겨받은 프로세스는 대화의 마지막 400개 메시지에서 다시 읽는다
(대화 기록에는 구조화된 결과가 없어서 깨우기는 넘겨받은 때부터 요청한 지연으로 센다). 백그라운드 표시의 툴팁이
이것들을 나열하고, 끝날 때까지 세션이 깨어 있다고 말한다. Codex 세션은 잠들지 않으므로 여기서 할 일이 없다.

다루지 않는 것: 키퍼 없이 호스트가 다시 시작하면, 재연결 복구는 여전히 그 전에 살아 있던 세션을 깨운다.

### 4.6.2 아무도 멈추라고 하지 않았는데 멈춘 턴 (#698)

턴은 일이 끝나기 전에 끝날 수 있는데, 세션의 모습은 그것을 알려 주지 않는다. 다른 세션처럼 `error`, `idle`,
`waiting_input`에 머물러 있을 뿐이다. 2026-10-15에 하위 세션 여러 개가 일하는 동안 인터넷이 두 번 끊겼다. Claude
하위 세션들은 `error`로 끝났고(CLI가 `api_retry`를 열 번, 약 3분 동안 시도한 뒤 `ECONNREFUSED`와 `ENOTFOUND`로
실패했다), 사람이 직접 "continue"를 보낼 때까지 그대로 있었다. 그 턴들은 CLI가 스스로 연 턴(Monitor 발동)이어서
빚진 보고가 없었고, 그들을 시작한 오케스트레이터는 아무것도 듣지 못했다. Codex 하위 세션의 중단된 턴은
오케스트레이터에게 "The assigned work finished"로 보고되었고, "완전히 종료"는 턴 도중의 세션을 대화에 아무 줄도
남기지 않은 채 `idle`로 되돌렸다.

이제 호스트는 **마지막 턴이 끝나지 못한 이유**를 세션에 둔다(`SessionInfo.interruption`, 저장은
`sessions.interruption`, 스토어 v53). 바뀔 때마다 `interruption` 이벤트로 보낸다. 이벤트에서 읽는 방식은 도구에
묶이지 않는다(`sessions/interruptions.ts`):

| 이유 | 정해지는 때 | 지워지는 때 |
|---|---|---|
| `network` | 돌던 턴이 네트워크 때문에 오류로 끝날 때(`endedTurn`과 함께 `interruptionAfter`. 충돌 `adapter_crashed`와 쉬는 동안의 오류는 해당하지 않는다): 오류 코드(`ECONNREFUSED`, `ENOTFOUND` 등), Claude의 "API Error: No response from API / Can't reach the API server / Connection refused, lost, reset, error, dropped / Request timed out / No internet route / Unable to connect to API / fetch failed"(CLI가 연결 실패를 말로 옮기는 함수에서 읽은 문구. "Unable to connect to API: SSL …"은 네트워크가 아니라 설정 문제다), 컴퓨터 잠자기, Codex의 "stream disconnected before completion", "failed to lookup address information", "Connection failed: error sending request", "waiting for network"(`isNetworkFailure`. 실제 저장소와 host.log에서 측정한 문장들). 도구의 문장만 보고 충돌에 붙는 stderr 끝부분은 보지 않는다(`failureSentence`). "connection closed", "network error" 같은 일반적인 말은 그 문장들 안에서만 센다. MCP 서버나 개발 서버도 그런 말을 할 수 있기 때문이다 | 세션이 다시 일할 때(`working`, 출력), 또는 턴이 다른 식으로 끝날 때 |
| `quit` | 시작할 때 프로세스 없이 `working`이나 `waiting_approval`인 세션을 찾았을 때(완전 종료, 재부팅, 키퍼가 살아남지 못한 충돌), 또는 키퍼가 쥔 프로세스를 다시 붙이지 못했을 때. 대화에 Centralu의 경고 줄을 쓴다("Centralu quit or restarted while this turn was running …") | 같음 |
| `interrupted` | 턴이 `interrupted_by_tool` 이유(`INTERRUPTED_BY_TOOL`)로 `waiting_input`에서 끝날 때: 우리가 `turn/interrupt`를 보내지 않은 턴에 온 Codex의 `turn/completed {status: "interrupted"}` | 같음 |
| `reconnecting` | 도구가 `RECONNECTING_FLAG_MS`(5분) 동안 `retrying`에 머물 때: Codex는 네트워크를 끝없이 기다린다. 살아 있는 동안만이며 저장하지 않는다 | 활동이 `retrying`에서 벗어나거나 턴이 끝날 때 |

| 결정 | 이유 |
|---|---|
| 턴 도중 취소된 앱 요청은 세션을 중단하기 전에 기다림을 실패로 끝낸다 | Claude 어댑터는 중단되는 순간 턴을 끝내므로, 기다림이 취소를 "끝나기 전에 멈춤"으로 읽었다 |
| 분류해서 보여 주고, 스스로 다시 보내지 않는다 | 다시 보낸 턴은 부작용(push, 댓글, 출시)을 되풀이할 수 있다. 이어 가는 일은 사람이나 요청한 세션이 보내는 메시지 하나이고, 두 쪽 모두 같은 문장이다: "Continue where you stopped. Check what already happened before repeating a step." 다시 연결될 때 자동으로 보내는 기능은 나중에 선택 사항으로 더할 수 있다 |
| Codex의 `interrupted` 턴은 `turn_complete`가 아니라 Stop처럼(`state_change waiting_input`) 끝난다 | `turn_complete`는 "끝났다"는 뜻이어서 오케스트레이터는 일이 끝났다고 들었다. 이제 중단 뒤에 `turn_complete`가 오지 않으므로, 턴을 기다리는 쪽(`AgentRunWait`)은 중단에서 기다림을 끝낸다 |
| Codex 어댑터는 자기가 보낸 중단과 Codex가 보낸 중단을 구별해 로그에 남긴다(`interruptsSent`, "interrupted by a stop from Centralu" / "by Codex"). 메모의 `turn/start`가 오가는 사이에 누른 Stop은 답이 알려 준 턴을 중단하고, 이것도 우리 것으로 센다(`takeInputTurn`) | 실제 사례에서는 사람의 Stop, 호스트, CLI 중 누가 보냈는지 알 수 없었다 |
| 사람의 Stop과 오케스트레이터의 `agent_session stop`은 아무것도 정하지 않는다 | 본인이 알고 있다. 자기 행동을 표시하면 소음이 된다 |
| `reconnecting` 시계는 `retrying`만 시작하고, 조용함은 시작하지 않는다 | 15–40초씩 쉬며 CI를 기다리던 세션은 멈춘 것처럼 보였지만 멈추지 않았다. 긴 빌드도 똑같이 보인다 |
| 그 턴에 빚진 보고는 이유를 먼저 말하고("stopped before finishing: a network error ended its turn", "its tool interrupted the turn") 이어 가는 방법을 덧붙인다 | "The assigned work failed"를 들은 쪽은 "continue" 한 번이면 될 일을 다시 하거나 버렸다 |
| 빚진 보고가 없으면(보고 표시도, 지금 그 턴을 기다리는 호출도 없음), 턴을 맡긴 세션이 `network`, `interrupted`, `quit` 중단을 한 번 듣는다(`tellAskerOfInterruption`): 지금 아무도 기다리지 않는 위임의 호출자(한도를 넘긴 `ask_project`나 `start_agent`), 없으면 그 세션을 시작한 세션(`askedBy`). 아직 기다리는 호출은 자기 답에서 중단을 읽는다 | 2026-10-15 사례, 그리고 `askedBy`가 없는 `ask_project` 턴. 멈춘 턴마다 보고는 하나이고, 다음 보고에는 다음 턴이 필요하므로 두 세션이 서로를 깨우는 고리가 생기지 않는다 |
| `quit`은 다음 시작 때 하위 세션마다 한 번 알린다. 대상은 보고를 받을 세션, 턴을 맡긴 세션(`delegated_turns`), `askedBy` 가운데 아직 있는 첫 세션이다(`quitNotices`, 키퍼가 쥔 세션이면 넘겨받은 뒤). 키퍼가 쥔 프로세스를 다시 붙이지 못하면 그 보고도 같은 식으로 정리한다. **스스로 종료로 멈춘 요청 세션에는** 시작 때든 그 뒤든 알리지 않는다: 그 세션은 사람의 Continue를 기다린다 | 기다리지 않고 위임한 세션은 잘린 것이 아니라 쉬고 있었고, 그 보고 표시는 버려졌다: 아무것도 듣지 못했다. 한 번 깨우는 비용은 턴 하나이고, 듣지 못하는 비용은 그 일 전체다. 같은 종료로 잘린 오케스트레이터를 깨우면 아무도 없는 시작 시점에 턴이 돌고, 그 턴이 사람이 보기 전에 자기 "멈춤" 표시를 지운다. 사람이 그 세션을 이어 가면 하위 세션들의 줄이 멈췄다고 말한다 |
| 오케스트레이터의 목록(`list_sessions`, reader에게는 id 없는 `read_session`)과 `agent_session status`는 줄에 "stopped: network error", "stopped: Centralu quit during its turn", "stopped: its tool interrupted the turn", "reconnecting to its API for N min"을 붙인다. 거르는 인자는 두지 않는다 | 줄이 이미 말하고, 인자는 모든 요청의 도구 정의에 실린다(docs/tool-cost.md). `agent_session`의 목록(#690)은 아직 없다 |
| 화면은 상태 옆에 그것을 보여 준다: 인박스 행의 말과 **Continue**, 사이드바 표시의 테두리와 툴팁, 입력창 위의 줄(product-spec FR-15) | 상태만으로는 멈춘 턴과 끝난 턴이 똑같이 보인다. Continue는 일을 이어 가는 메시지 하나다 |
| `CLAUDE_CODE_MAX_RETRIES`는 CLI가 정한 대로 둔다 | 3분이면 대부분의 끊김을 넘긴다. 예산을 늘리면 긴 장애 동안 턴을 붙잡아 둔다 |

### 4.7 원격 모드 1단계: `centralu serve` (#82)

앱은 다른 머신(SSH 서버, 나중에는 노트북)에 있는 프로젝트를 다룰 수 있다. 그 머신은 자기만의 독립된 호스트를 돌린다:
자기 저장소, 자기 에이전트 CLI 로그인, 자기 파일과 터미널 (#82, 결정 1). 1단계에서는 사람이 그 호스트를 직접 설치하고
띄우며, 앱은 SSH 로컬 포워드로 닿는다. 양쪽 어디에서도 공개 인터페이스에 열린 것이 없다: 원격 호스트는 127.0.0.1에
바인드하고, 사람의 컴퓨터 쪽 포워드도 마찬가지다. 앱이 SSH로 호스트를 설치하는 것은 수명 주기 계약을 쓴 뒤의
3단계다 (#82, 결정 4).

**원격 머신에서:**

1. Node 22.14 이상을 설치하고 `npm i -g centralu`. Linux에서는 플랫폼 패키지가 번들 호스트를 AppImage 옆에 풀린 채로
   싣고 있으므로(`host/`, [releasing.ko.md](releasing.ko.md)) 돌리는 데 디스플레이도 FUSE도 데스크톱 라이브러리도
   필요 없다.
2. 그 머신에 Claude Code 및/또는 Codex를 설치하고 로그인한다 (`claude` 후 `/login`, `codex login`). 호스트는 그
   머신의 로그인을 쓰며, 클라이언트의 것은 결코 쓰지 않는다.
3. `centralu serve`를 실행한다. 전경에 머물며 stderr에 (그리고 늘 그렇듯 `~/.centralu/host.log`에) 로그를 쓴다.
   찾을 줄은 `[centralu serve] listening on 127.0.0.1:17175 …`이다.
4. 이미 쓰는 것으로 계속 돌게 둔다: tmux, `nohup`, 또는 `systemd --user` 유닛 (아래). 진짜 감독, 업데이트 경로,
   제거는 3단계의 설치기와 함께 온다.

```ini
# ~/.config/systemd/user/centralu.service
[Unit]
Description=Centralu host (centralu serve)

[Service]
# The launcher serve keeps up to date, so the unit does not depend on npm's PATH
ExecStart=%h/.centralu/bin/centralu serve
# SIGTERM to the launcher only; it passes one to the host, which stops its own agents first
KillMode=mixed
TimeoutStopSec=30
Restart=on-failure

[Install]
WantedBy=default.target
```

그다음 `systemctl --user daemon-reload && systemctl --user enable --now centralu`, 그리고 한 번
`loginctl enable-linger $USER`를 해서 로그아웃한 뒤에도 호스트가 돌게 한다. 첫 `centralu serve`는 손으로 실행한다:
`~/.centralu/bin/centralu`를 쓰는 것이 그것이다.

**명령:**

| 명령 | 하는 일 |
|---|---|
| `centralu serve` | 호스트를 전경에서 `127.0.0.1:<port>`로 띄운다. 종료 코드는 호스트의 것 (깨끗이 멈추면 0) |
| `centralu serve --port <n>` | 같은 것을 그 포트로. 포트는 기록되어, 플래그 없는 다음 `serve`가 그것을 쓴다 |
| `centralu serve --detach [--port <n>]` | 이 세션 바깥에서 `serve`를 띄우고, 그 호스트가 hello에 답하면 돌아온다. JSON 한 줄을 찍는다. 이미 돌고 있으면 두 번 띄우지 않고 그렇다고 답한다. 어떻게 띄우는지(setsid, WMI, WSL은 WMI로 만든 `wsl.exe`)와 `serve.log`, `serve.pid`는 영어판 §4.7 |
| `centralu serve --stop` | 돌고 있는 호스트에 멈추라고 묻고(`host.stop`), 멈출 때까지 기다린 뒤 JSON 한 줄을 찍는다. 윈도우에서 런처를 죽이면 호스트가 정리 없이 끝나기 때문이다 |
| `centralu serve --connection` | JSON 한 줄을 찍고 끝난다 (아래). 토큰이 아직 없으면 만든다. 추가된 `install` 필드는 `{ managed, current, previous, node }` |
| `centralu serve --rotate-token` | 포트는 두고 토큰을 바꾼다. 돌고 있는 serve는 재시작할 때까지 옛 토큰을 쓴다 |
| `centralu serve --help` | 위의 것 |

`--connection`은 클라이언트가 `ssh -T -o BatchMode=yes <target> …`로 묻는 단 하나의 질문에 답한다:

```json
{"v":1,"port":17175,"token":"…","version":"0.1.0-beta.11","protocolVersion":1,"dataDir":"/home/me/.centralu","hostRunning":true}
```

| 필드 | 뜻 |
|---|---|
| `v` | 이 줄의 모양. 그 숫자를 모르는 클라이언트는 어느 쪽을 업데이트할지 말한다 |
| `port` | 호스트가 원격의 루프백에서 듣는 곳: 마지막 `serve`가 들은 포트, 없으면 17175 |
| `token` | hello에 쓸 토큰. `--rotate-token` 전까지 재시작해도 같다 |
| `version`, `protocolVersion` | `hostRunning`이면 돌고 있는 호스트의 것(그 `hello_ok`에서 읽는다), 아니면 설치된 패키지의 것(`host/bundle-info.json`). 호스트를 재시작하지 않은 `npm i -g` 뒤에는 둘이 다르다 |
| `dataDir` | 호스트가 소유하는 데이터 폴더 |
| `hostRunning` | 이 토큰을 가진 호스트가 방금 `port`에서 hello에 답했다. TCP 연결만으로는 치지 않는다 |

stdout에는 그 줄만 나가고, 설명할 것은 stderr로 간다. 명령을 찾지 못하면(종료 코드 127) SSH 셸의 PATH에 npm의
전역 폴더가 없는 것이다(nvm, fnm, volta, `~/.npm-global`은 대화형 셸에서만 그것을 넣는다): `~/.centralu/bin/centralu`를
쓴다. `serve`와 `--connection`이 이것을 절대 경로로 이 설치와 이 Node에 맞춰 둔다. nvm과 Homebrew에서는 그 경로에
버전이 들어 있으므로, Node를 올린 뒤에는 대화형 셸에서 `centralu serve`(또는 `--connection`)를 한 번 돌려 다시 쓰기
전까지 이 런처가 실패한다.

| 결정 | 이유 |
|---|---|
| 런처가 번들 호스트를 시스템 Node로 띄운다; 키퍼는 없다 | 앱이 돌리는 것과 같은 `resources/host`이므로, 원격 호스트는 따로 살려 둘 두 번째 빌드가 아니다. 키퍼는 창 밑에서 빌드를 바꾸고 재시작 너머로 에이전트를 쥐려고 있다; 화면 없는 호스트에는 아직 둘 다 필요 없다 |
| 127.0.0.1에만 바인드하고 SSH 로컬 포워드로 닿는다 | SSH가 이미 사람을 인증하고 연결을 암호화한다. 공개 포트라면 TLS와 우리만의 로그인이 필요하고, 인터넷의 모든 스캐너가 그것을 찾는다 |
| 토큰은 `<데이터 폴더>/serve.json`에, 첫 바이트부터 0600으로, 어긋나면 다시 좁혀 둔다 | 그 머신의 모든 RPC의 열쇠다. 찍는 것은 `--connection`뿐이다: 토큰을 실은 호스트의 준비 줄은 런처가 읽고 아무 데도 넘기지 않는다 |
| 토큰은 `--token`이 아니라 `CC_HOST_TOKEN`으로 호스트에 간다 | 머신의 아무 사용자나 남의 명령줄을 읽을 수 있다(`ps`); 프로세스의 환경은 주인만 읽는다. 호스트는 읽은 뒤 그 변수를 지운다 |
| 토큰과 포트는 한 번 만들고 둔다 | 클라이언트는 그것을 저장해 두고 SSH 왕복 없이 다시 붙는다; hello가 거절될 때만 `--connection`을 다시 돌린다 |
| 기본 포트 17175 | 모든 OS의 임시 포트 범위보다, 그리고 호스트의 앱별 뷰 origin(20000–32767, `views/origin-ports.ts`)보다 아래 |
| 호스트는 자기 프로세스 그룹과 `--watch-parent`를 갖는다 | Ctrl+C는 런처에 닿고, 런처가 호스트 하나에만 SIGINT를 한 번 넘기며, 호스트가 에이전트를 순서대로 멈춘다. 런처를 죽이면(SIGKILL이라도) 호스트의 stdin이 닫혀 함께 내려간다: 감독 없이 남겨지는 일이 없다 (`tooling/launcher-serve.test.ts`) |
| 시작하는 동안 온 시그널은 호스트가 내려갈 수 있을 때까지 쥐고 있는다 | 호스트가 핸들러를 달기 전에는 커널 기본 동작이 적용되어 그 자리에서 끝난다. 측정: 준비 줄을 읽자마자 넘긴 SIGINT가 매번 호스트를 죽였다. 이제는 시작이 끝나면 깨끗이 내려간다; 시작하는 동안 두 번째 시그널이 오면 바로 끝난다 (`main.ts`, `pendingSignal`) |
| 두 번째 `serve`, 또는 같은 데이터 폴더의 다른 어떤 호스트도 거절된다 | 소유권 잠금(`instance-lock.ts`)이 권위다. `serve`는 먼저 기록해 둔 포트에 물어보므로 이미 떠 있는 serve는 포트와 함께 이름이 나오고, 다른 소유자라면 호스트의 잠금 메시지 뒤에 pid를 대는 줄이 붙는다 |
| 호스트 환경에 `DISPLAY` / `WAYLAND_DISPLAY`가 없다 | 호스트가 띄우는 무엇도 아무도 보지 못할 창이나 키링 대화상자를 열 수 없다; 물어보려던 도구는 파일 저장소로 물러나거나 로그에 메시지를 남기고 실패한다 |
| Windows: 자기 그룹 없음, 넘기기 없음 | 거기서 `detached`는 새 콘솔을 뜻한다; 호스트는 런처의 콘솔을 같이 쓰고 Ctrl+C를 직접 받는다. 아직 돌려 보지 않았다 |

**1단계가 다루지 않는 것.** 앱 뷰는 호스트의 HTTP 문 `127.0.0.1:<port>`에서 열리므로, 로컬 포트가 원격 포트와 같은
포워드를 통해서는 동작한다. 매니페스트가 자기 origin을 요구하는 앱은 따로 포트를 받으며(`views/origin-ports.ts`),
포워드 하나로는 실리지 않는다. 반대편, 이 호스트에 링크하는 호스트는 §4.8이다.

호스트는 다른 프로토콜의 클라이언트를 `version_mismatch`와 종료 코드 4002로 거절한다. 메시지는 두 숫자와 어느 쪽이
더 오래되었는지를 말하므로, 사람은 앱을 업데이트할지 원격을 업데이트할지 안다 ([protocol.ko.md](protocol.ko.md) §1).

### 4.8 원격 모드 1단계: 허브의 링크 (#82)

§4.7의 나머지 반쪽이다. 창이 붙은 호스트(**허브**)는 다른 기기의 `centralu serve` 호스트에 링크하고, 그 세션과
프로젝트를 제 것처럼 보여 준다([plans/remote-hub.md](plans/remote-hub.md). 프로토콜 쪽은
[protocol.ko.md](protocol.ko.md) §6). 호스트는 호스트하고만 말한다: 창은 여전히 호스트 하나와 말하고, 각 기기는 자기
저장소의 유일한 작성자로 남는다. 코드는 `packages/agent-host/src/links/`에 있다.

**`main.ts`가 엮는 조각들.**

| 조각 | 파일 | 하는 일 |
|---|---|---|
| 레지스트리 | `stored.ts`, store v46 `linked_machines` | 사람이 링크한 기기: id, 이름, ssh 대상, 원격 셸, 숫자를 접는 `slot`, 받아들인 버전 쌍 |
| 전송 | `tunnel.ts` (`SshTunnel`) | ssh로 원격에 연결 줄을 묻고, ssh 로컬 포워드를 잡고 있는다 |
| 링크 | `links.ts` (`LinkedMachine`) | 기기마다 하나: 전송, 버전 확인, 클라이언트, 재시도 간격, 상태, 숨기는 세션 집합, 미러 갱신 |
| 클라이언트 | `remote-client.ts` | 허브가 원격 호스트에 거는 WebSocket: hello, 커서와 에포크, 호출, 이벤트, 터미널 프레임 |
| 라우터 | `router.ts`, `routes.ts` | `HostServer.onRpc` 앞에서: id가 가리키는 기기로 호출을 보내고, 목록을 합치고, 나머지는 로컬로 답한다 |
| 한정자 | `qualifier.ts`, `machine-ids.ts` | 들어올 때 `<machine>.<id>`를 붙이고 나갈 때 뗀다. 숫자는 slot마다 접는다 |
| 미러 | `stored.ts`, store v46 `machine_headers` | 기기마다 마지막으로 받은 세션과 프로젝트 목록. 닿지 않을 때 대신 답한다 |

계획 문서 §5의 세 길목이 그 자리다: 라우터가 서버가 부르는 `onRpc`이고, 링크는 원격의 이벤트를 `server.broadcast`에
넣으며(그래서 허브 자신의 `seq`와 재전송을 받는다), 터미널 프레임은 로컬 것과 같은 길로 넣는다. 링크된 기기가 없는
호스트는 모든 호출을 전처럼 자기 핸들러로 보낸다.

**전송.** 사람 자신의 `ssh`, 키, `~/.ssh/config`로 두 번:

```
ssh -T -o BatchMode=yes -o ConnectTimeout=15 -- <target> <연결 명령>
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o GatewayPorts=no -L 127.0.0.1:<port>:127.0.0.1:<port> -- <target>
```

연결 명령은 원격의 셸(`MachineInfo.shell`)에 따라 다르다. `ssh <target> <명령>`은 원격 계정의 로그인 셸이 무엇이든
그 셸에 명령을 넘기기 때문이다:

| 셸 | 연결 명령 | 잰 곳 |
|---|---|---|
| `posix` | `sh -c 'if command -v centralu …; then exec centralu serve --connection; elif [ -x "$HOME/.centralu/bin/centralu" ]; then exec …; else echo CENTRALU-NOT-FOUND; exit 127; fi'` | `tunnel.test.ts`의 가짜 ssh |
| `powershell` | 같은 찾기(`Get-Command centralu.cmd`, 다음 `%USERPROFILE%\.centralu\bin\centralu.cmd`)를 `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>`로 | Windows 11, OpenSSH, PowerShell 5.1 |
| `wsl` | 같은 PowerShell 감싸기 안에 `wsl.exe -d '<distro>' -- bash -lc 'echo <base64> \| base64 -d \| bash -l'`. 스크립트는 PATH에서 `/mnt/*`를 뺀 POSIX 찾기 | 그 노트북의 WSL2 Ubuntu 24.04 |

기기마다 `centralu` 대신 돌릴 명령을 적을 수 있다(`MachineInfo.command`): 소스 체크아웃, `~/.centralu`가 아닌 데이터
폴더. 적힌 그대로 돌고, 대체 경로는 없다.

| 결정 | 이유 |
|---|---|
| 런처로 넘어가는 판단은 원격에서 명령 하나로 하고, "없음"은 stdout의 단어로 말한다 | 종료 코드가 Windows를 건너오지 못한다: OpenSSH는 명령을 PowerShell 아래에서 돌리고, PowerShell은 어떤 실패든 1로 바꾼다. 잰 값: WSL이나 PowerShell의 127은 1로 왔고, WSL 안의 없는 명령은 0으로 왔다 |
| 평범한 단어가 아닌 것은 모두 base64로 PowerShell을 건넌다 | PowerShell 5.1은 따옴표를 다시 해석하고, 네이티브 프로그램에 넘기는 큰따옴표를 망가뜨린다. base64는 글자, 숫자, `+`, `/`, `=`뿐이라 어느 층도 건드리지 않는다 |
| WSL의 찾기는 PATH에서 `/mnt/*`를 뺀다 | WSL은 Windows의 PATH를 뒤에 붙이고, Windows의 npm 폴더에는 `centralu` shim이 있다: 배포판 안의 `command -v centralu`는 `/mnt/c/Users/<me>/AppData/Roaming/npm/centralu`, 곧 Windows 설치본을 가리켰다 |
| WSL 포워드는 `-N` 대신 `wsl.exe -d <distro> --exec sleep infinity`를 돌린다 | WSL은 마지막 `wsl.exe` 클라이언트가 끝나고 15초쯤 뒤 배포판을 멈추고, 그 안의 서비스도 함께 멈춘다. 잰 값: systemd 유닛 아래의 `centralu serve`가 붙은 클라이언트 없이 시작 19초 만에 멈췄다. Windows의 sshd로 가는 포워드만으로는 배포판이 붙들리지 않는다 |
| 포워드 양 끝은 127.0.0.1에 묶고 `GatewayPorts=no` | 어느 기기의 네트워크에서도 링크를 쓸 수 없다 |
| 비어 있으면 양 끝에 같은 포트 번호, 아니면 다른 번호 | §4.7: 앱 뷰의 주소에는 호스트 자신의 포트가 들어 있다. 기본값 17175를 쓰는 두 기기는 그 번호를 함께 가질 수 없고, 두 번째 기기의 앱 뷰는 어차피 2단계의 프록시가 필요하다 |
| 어디서나 `BatchMode=yes` | 아무도 답할 수 없는 암호나 호스트 키 질문이 링크를 멈춰 세운다. 키는 사람이 다른 ssh 쓰임처럼 한 번 마련한다 |
| 토큰은 저장하지 않고 링크가 시작할 때마다 ssh로 묻는다 | 그 기기의 모든 RPC 열쇠다. 시작마다 ssh 왕복 한 번(LAN에서 연결까지 2.1–4.3초 잼)은 싸다 |
| ssh 프로세스는 허브 호스트의 자식이고 `Tunnel` 인터페이스 뒤에 있다 | 계획 문서의 probe 4(§10.6, 2026-10-08)가 실제 허브 교체를 건너 대안들을 쟀다: 지금 그대로면 교체 한 번에 링크가 약 1.1초 떨어지고, OpenSSH `ControlPersist`면 0.8초(교체마다 포워드를 하나씩 남기고 "완전히 종료"보다 오래 산다), keeper의 자식이면 약 0.14초일 것이다. 원격의 에이전트는 허브 교체를 알아채지도 못하므로 여기에 둔다 |

**링크의 상태**(`MachineInfo.status`, `machine_status`로 보낸다): `connecting`; `connected`; `unreachable`(ssh 실패,
포워드나 소켓이 끊김. 2초에서 1분까지 늘려 가며 다시 시도); `starting`(호스트가 돌지 않아 링크가 `centralu serve --detach`로
띄우는 중. 묻지 않는다, 계획 문서 §10.9 결정 7. WMI가 막힌 기기에서는 포워드의 ssh 세션이 호스트를 돌리고 링크와 함께 끝난다);
`not_running`(Centralu는 답하지만 `centralu serve`가 돌지 않고, 띄우기도 실패했다. `error`가 까닭. 다시 시도); `versions_differ`; `refused`(토큰이 연달아 두 번 거절됨. 연결 줄은 바로 한 번 다시 읽는다.
`--rotate-token`은 토큰을 바꾸지만 돌고 있는 serve는 재시작할 때까지 이전 것을 쓰기 때문이다).

**버전은 연결 전에 확인한다**(계획 문서 §4). 연결 줄은 돌고 있는 원격 호스트의 `version`과 `protocolVersion`을
싣고, 허브는 소켓을 열기 전에 자기 것과 비교하며, 연 뒤에는 `hello_ok.build`로 한 번 더 본다. 프로토콜이 다르면
절대 이어지지 않는다. 같은 채널의 다른 버전이면 더 오래된 쪽을 가리키며 `versions_differ`에 멈추고, 두 쪽이 맞거나
사람이 거절할 때까지(`machines.acceptVersions`, 그 쌍에 대해서만 기억하므로 어느 쪽이든 바뀌면 다시 묻는다) 기다린다.
dev 빌드에는 더 오래된 쪽이 없고 프로토콜이 같으면 이어진다. 업데이트 자체는 다음 단계다: 허브는 자기 업데이트로,
원격은 1단계에서 손으로(`npm i -g centralu`), 3단계에서 ssh로.

**연결한 뒤** 링크는 원격의 `sessions.list`와 `projects.list`를 미러로 읽고, 숨길 세션(원격의 오케스트레이터와
코디네이터, 계획 문서 §3.4)을 적어 두고, `machine_resync`를 보낸다. 창은 그 기기를 다시 읽고 죽은 것을 깨운다.
링크는 원격마다 커서와 에포크를 하나씩 쥐므로, 끊긴 소켓은 빈틈을 재전송받고, 재시작한 원격은 새 수명이라 다시
동기화한다. 허브가 보여 주지 않는 세션의 이벤트는 버리고, 세션 이벤트로 읽기 사이의 미러 이름과 상태를 따라간다.

**반대 방향은 꺼져 있다**(계획 문서 §3.2). 링크는 허브가 연 클라이언트 연결이다. 프로토콜에는 호스트가 클라이언트를
부르는 프레임이 없고, `RemoteClient`는 요청 모양의 것을 실행하지 않고 버린다(`remote-client.test.ts`). 그래서 탈취된
원격이 링크를 통해 허브에 닿을 수 없다.

**허브를 거쳐 잰 값**(probe 3, 2026-10-05. Wi-Fi의 MacBook, 원격은 같은 LAN의 Windows 11 노트북. WSL2에서는 main의,
Windows에서는 beta.10의 `centralu serve`):

| | WSL2 Ubuntu | Windows (PowerShell) |
|---|---|---|
| 링크부터 연결까지 | 2.1–4.3초 | 2.3–3.7초 |
| 허브를 거친 RPC 왕복, 중앙값 / p95 | 5.4–12.8 / 7.7–36 ms | 5.5–22 / 8–68 ms |
| 키 입력부터 에코까지(키마다 RPC 하나), 중앙값 / p95 | 8–16 / 12–35 ms | 16–31 / 17–46 ms |
| 터미널 출력, 허브를 거쳐 / 원격에 바로 | 6.3 MB를 7.5–15 / 5.5–8.7 MB/s | 0.34 MB를 10.0 / 9.5초 |
| 40만 줄 변경의 `git.diff` (호스트의 0.5 MB 상한) | 240–290 ms | 310–365 ms |

중계는 원격 자신의 속도에 비해 잴 만한 것을 더하지 않는다: Windows의 느린 출력은 ConPTY의 것이고, 원격 호스트에
바로 붙어도 같다. 64 MiB 느린 독자 차단에는 닿지 않았다.

**창 쪽** (`packages/ui`; 복구는 [state-management.ko.md](state-management.ko.md) §7):

| 어디 | 링크로 하는 일 |
|---|---|
| 사이드바 | 기기와 상관없이 프로젝트 목록 하나(#734)이고, 순서는 허브가 기기를 넘나들며 지킨다: `projects.reorder`는 기기 접두사가 붙은 id로 목록 전체를 받고, 기기마다 제 프로젝트의 순서를 저장하며, 허브는 목록 전체를 제 저장소(`app_settings`의 `hub.projectOrder`)에 저장한다. 그래서 기기가 연결되어 있으면 `projects.list`가 그 순서로 답한다. 그 순서에 아직 없는 프로젝트(그 뒤에 더한 것, 새로 연결한 기기의 것)는 기기가 연결되어 있든 없든 끝에 선다. 순서는 저장하기 전에 검사한다. 저장된 순서에는 있는데 낡은 창이 보낸 순서에는 없는 id는 앞서던 id 뒤의 자리를 지키고, 허브가 더는 나열하지 않는 id는 잊는다(연결된 기기의 id는 닿지 않을 뿐일 수 있어 남긴다). 응답에는 순서가 하나도 이름 짓지 않은 기기의 프로젝트까지 모든 기기의 프로젝트가 들어 있다. 연결된 기기의 프로젝트와, "Your apps"에 선 그 사용자 폴더 앱은 이름 오른쪽에 기기 이름 배지(96px을 넘으면 말줄임)를 단다: 링크가 `connected`이면 실선 테두리, 그 밖(`connecting`, `away`, …)이면 점선이다. 누르면 설정 → 기기를 열고, 툴팁에는 링크의 마지막 오류가 있다. 연결되지 않은 기기의 프로젝트와 세션은 흐리게(`data-away`) 남고, 결코 깨우지 않는다. 기기가 하나라도 연결되면 Add project가 어디에 더할지 묻는다: 이 컴퓨터(폴더 선택기), 또는 연결된 기기의 경로로 폴더를 더하거나(`projects.add {path, machine}`) 그 기기의 `~/Centralu`에 빈 폴더를 만든다(`projects.create {name, parent?, machine}`) |
| 설정 → 기기 | `machines.list/add/remove/reconnect`. 행마다 마지막 오류를 할 일로 말하고(`@cc/core`의 `machineProblem`: 키가 안 올라감, 호스트 키를 받은 적 없음, 거기에 Centralu가 없거나 serve가 안 돎), 버전 질문을 담는다 |
| 버전 질문 | `MachineInfo.versions`에서: 허브가 오래되면 기존 업데이트 경로, 원격이 오래되면 거기서 칠 정확한 `npm i -g centralu@<허브 버전>`(1단계는 원격을 업데이트하지 못한다). "Connect anyway"는 `machines.acceptVersions`이고, 프로토콜이 같을 때만 내놓는다 |
| 새 세션 대화상자, 세션 메뉴 | `agents.detect`, `agents.models`, `agents.capabilities`에 프로젝트의 `machine`을 넘긴다 |
| 세션 머리줄 | 기기를 밝힌다(그리드 패널의 머리줄이기도 하고, 승인과 질문에 답하는 곳이기도 하다). "older CLI"는 `agents.versions {machine}`과 비교한다 |
| 인박스, 알림 카드, OS 알림 | 원격 세션의 기기를 밝힌다 |
| 사용량 게이지(2단계) | 이 컴퓨터의 도넛이 먼저, 그다음 연결된 기기마다 그 이름 뒤에 그 기기의 도넛: `agents.detect`와 `agents.usage`에 그 `machine`을 넘긴다. 연결된 기기에만 묻는다(5분마다, 호스트 연결이 돌아올 때, 그 기기의 링크가 돌아올 때). 연결되지 않은 기기는 상태만 보인다 |
| VS Code에서 열기(2단계) | 다른 기기의 프로젝트에서 사이드바의 프로젝트 메뉴, diff, 뷰어, 파일 트리의 행 메뉴가 "Open in VS Code"를 내놓는다: `system.openUrl`로 여는 `vscode://vscode-remote/ssh-remote+<sshTarget><경로>` 링크(`@cc/core`의 `remoteIdeUrl`). WSL 기기와, 링크에 실을 수 없는 ssh 대상에는 내놓지 않는다 |
| 다른 기기의 프로젝트에서 꺼지는 것 | 파일 관리자에서 보기와 파일 트리의 다른 동작, 이 컴퓨터의 IDE에서 열기(`fs.resolve`가 거절된다), 삭제할 때 폴더를 이 컴퓨터의 휴지통으로 옮기기, 새 앱, 앱 뷰(`appStatus`가 나중 버전에서 열린다고 말한다) |

**1단계가 아직 다루지 않는 것.** 다른 기기의 앱 뷰는 2단계다(목록에 있고, 그 도구는 거기서 돌며, 뷰는 그렇다고
말한다). ssh로 원격을 설치하고 업데이트하는 것은 3단계다([plans/remote-hub.md](plans/remote-hub.md) §10). `processes.strays/stop`과 종료 대화상자는
아직 이 컴퓨터에만 묻는다. WSL의 `centralu serve`에는 배포판이 시작할 때 그것을 띄울 것(§4.7의 systemd 유닛)이
필요하고, 그 뒤로는 링크가 배포판을 살려 둔다.

## 5. dev-services (이름과 달리 prod 경로다 — 2026-08-15 정정)

M1.5에서 Node 사이드카가 배포 경로가 되면서, "Tauri 4단계에서 Rust로 옮기고 삭제한다"는 계획은
**보류되었다**. 이 디렉터리는 오늘날 prod에서 그대로 사용된다. 이름은 역사적 잔재다.

- **git**: `git` CLI spawn + `--porcelain=v2/-z` 파싱. status·diff·log·branches·checkout·stage·commit·push.
  git2(Rust)로의 이전은 **측정으로 병목이 확인되기 전까지는 하지 않는다** (m2-plan 결정 3).
  포트 인터페이스가 같으므로 나중에 옮겨도 UI는 변경되지 않는다.
- **store**: better-sqlite3 + `user_version` 마이그레이션 러너. `Store`(`store.ts`)는 파일을 열고 마이그레이션을 돌린다. 나머지 메서드는 `dev-services/store/`의
  개념별 모듈(프로젝트, 세션, 메시지, 휴지통, 앱 실행 기록 등)로 호출을 넘기고, 단계 목록은 `store/migrations/`에 있다. 스키마 DDL은 정확히 한 곳,
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

규칙은 `dev-services/store/migrations/index.ts`의 단계 목록(`migrationSteps`) 위에 적혀 있고, 리뷰어는 새 단계를 이 규칙에 비추어 본다:

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
6. **단계는 자신이 돌았다는 기록과 함께 한 단위로 커밋한다 (#396):** 단계의 문장들, `min_reader_version` 상향,
   `user_version` 증가(그리고 `deferred_migrations` 목록이 바뀔 때는 그 목록: 스왑이 미뤄 둔 단계가 돌면 줄어들고,
   스왑이 단계를 미루면 늘어난다)가 한 트랜잭션에 들어간다. 전에는 문장마다
   따로 커밋되어, v12나 v17의 두 `ALTER` 사이에서 죽은 시작은 첫 열만 남겼고, 다음 시작은 그 열을 보고 단계의 나머지를
   영영 건너뛰었다. `VACUUM`은 트랜잭션 안에서 돌 수 없으므로 단계는 그것을 커밋 뒤로 미루고, 그 커밋 안에 VACUUM이
   밀려 있다고 적는다(`app_settings`의 `vacuum_owed` 행, VACUUM이 돌거나 실패하면 지운다; `vacuumAfterStep`). VACUUM
   도중에 멈춘 호스트는 그 행을 남기고, 다음 열기가, 스왑이면 `runDeferred`가 VACUUM을 돌린다. v10은 트랜잭션
   안에서는 무시되는 `foreign_keys`를 바꾸므로 스스로 커밋하고(`ownTransaction`), 그 자체로 한 단위다.

| 단계 | 하는 일 | 옛 빌드 |
|---|---|---|
| 2, 4, 5, 7, 8, 12, 14, 15, 17, 18, 20, 22, 23, 24, 25, 27, 30, 31, 33, 37, 38, 39, 43, 53, 54 | 열 추가 (53: 마지막 턴이 끝나지 못한 이유인 `sessions.interruption`, #698; 54: `auto`만으로 통과한 대기 ask를 표시하는 `queued_requests.opened_by_auto`) | 읽는다 (39: 휴지통의 세션을 살아 있는 세션으로 보여 준다; 43: 이전 host의 `grid.set`은 크기를 쓰지 않으므로 앱 패널이 기본값으로 돌아간다, #306; 53: 이전 host는 `sessions.interruption`을 읽지도 쓰지도 않으므로, 그 host가 맡은 줄은 마지막 값을 그대로 둔다, #698; 54: 이전 host는 `opened_by_auto`를 읽지도 쓰지도 않는다. 그 host가 넣은 줄은 null이고, 쌍의 기억된 동의가 없으면 표시된 것으로 읽는다) |
| 3, 6, 9, 16, 19, 34, 36, 41, 42, 49, 50, 51, 52 | 테이블 추가 (3은 색인도 채운다: 무거움; 42는 그리드의 세션 줄을 `grid_layout`에 한 번 옮겨 적고 `grid_panels`는 그대로 둔다, #288; 49는 세션이 일을 준 세션에게 빚진 보고를 적는 `report_marks`를 더한다, #646; 50은 아직 사람의 답을 기다리는 start_agent 카드를 적는 `agent_start_requests`를 더한다, #673; 51은 돌고 있는 턴을 맡긴 세션을 적는 `delegated_turns`를 더한다, #676; 52는 바쁜 세션을 위해 붙잡아 둔 요청을 적는 `queued_requests`와 nullable `sessions.forked_from_session_id`를 더한다, #677) | 읽는다 (42: 이전 host는 그리드를 `grid_panels`에 두므로, 두 빌드의 그리드가 달라질 수 있다) |
| 10, 11, 40 | 같은 모양으로 다시 짓기 (10: `project_id`를 nullable로 한 `sessions`; 11과 40: 색인 후 `VACUUM`: 무거움) | 읽는다 |
| 21, 26, 29, 35, 48 | 한 방향 데이터 고쳐 쓰기 (21은 모든 메시지를 고쳐 쓴다: 무거움. 48은 예전 워크트리 매니저의 워크트리 세션에 `askedBy`를 준다, #561) | 읽는다, 되돌릴 수 없다 |
| **13, 28, 32** | **테이블이나 열 삭제** | **깨진다: `min_reader_version`을 올린다** |

스키마를 바꾸는 단계는 같은 PR에서 [generated/schema.md](generated/schema.md)를 다시 만든다(`pnpm docs:schema`). 새
테이블은 [domain-model.ko.md](domain-model.ko.md)와 그 원본의 "저장되는 곳" 목록에 한 줄을 얻는다. 둘 다 하기
전까지 `schema-doc.test.ts`가 실패한다.

### 5.2 다른 빌드가 읽는 저장 모양 (#384)

저장소의 테이블은 두 빌드가 나눠 쓰는 모양 하나이고, §5.1이 다룬다. 다른 모양도 많이 같은 식으로 저장되거나 오간다.
`app_settings`의 JSON 행, 데이터 폴더의 파일, 사람이나 다른 빌드가 쓰는 파일, 프로세스 사이의 줄과 프레임이다. 호스트
교체 중에, 사람이 이전 릴리스로 돌아간 뒤에, 서로 다른 릴리스의 두 기계 사이에서 옛 빌드와 새 빌드가 그 각각을 읽는다.

모든 모양의 규칙:

- **필드가 더해지면:** 옛 읽는 쪽은 무시하고, 기록을 다시 쓰는 곳이라면 그 필드를 남긴다.
- **필드가 빠졌거나 아직 쓰이지 않았으면:** 새 읽는 쪽은 기본값을 쓴다.
- **이 빌드가 못 읽는 값**(새 열거형의 단어): 그 값만 기본값이 되고, 기록의 나머지는 그대로 읽힌다. 못 읽는 권한은
  거절이지 허락이 아니다.
- **깨진 파일:** 파일이나 행 이름을 대는 분명한 말. 멈추지 않고, 말 없이 설정이 초기화되지도 않는다.

| 모양 | 위치 | 읽는 곳 / 쓰는 곳 | 옛 모양 | 새 모양 | 깨짐 | 테스트 |
|---|---|---|---|---|---|---|
| 화면 설정 (`UiPreferences`) | `app_settings.ui_preferences` | `parseUiPreferences` (protocol), `SessionManager.uiPreferences` / `setUiPreferences` | 빠진 필드마다 기본값 | 못 읽는 값은 기본값으로 보이고, 이 빌드가 변경을 쓸 때 모르는 필드와 못 읽는 값은 남는다 | 기본값, 행 이름을 댄 stderr 한 줄. 다음 변경이 덮어쓴다 | `theme.test.ts`, `ui-preferences.test.ts` |
| 작업 공간 스냅샷 | `workspace` 행 | UI 스토어의 복원(`attach`), `readNotifyPolicy` (core), `sanitizeLayout` | 필드마다 따로 확인. 스냅샷에 없는 알림 스위치는 꺼짐이 아니라 기본값(켜짐) | 무시. 창이 스냅샷을 통째로 다시 쓰므로 옛 창은 새 창의 배치 필드를 떨군다. 의도된 것: 스냅샷은 설정이 아니라 배치다 | 호스트가 `null`을 답하고 화면은 기본값에서 시작 | `store.test.ts` (ui), `notify.test.ts` |
| 테마·글꼴 캐시 | 페이지의 `localStorage` | `applyCachedTheme`, `applyCachedTypography` | 값마다 확인 | 무시 | 캐시 없음과 같다. 첫 프레임만이고 호스트의 답이 뒤따른다 | (캐시뿐) |
| 키퍼 설정 | `keeper-settings.json` | `source::load_settings` (키퍼, 기본값 있는 serde) | `background` 기본값은 꺼짐 | 읽을 때 무시, **다음 저장에서 떨어진다** | **말 없이** 꺼짐으로 읽힌다 | `background_mode_is_off_unless_saved_on` (새 모양 테스트는 아직 없음) |
| 그리드 배치 | `grid_layout` | `Store.listGridView` / `setGridView` | 스팬 없는 행은 고른 것 없음으로 읽힌다 (v43) | `kind`에 CHECK가 있어 새 패널 종류는 테이블 재구성, 곧 §5.1의 깨는 단계다. 범위 밖 스팬은 없음으로 읽힌다 | (행) | `store.test.ts` (v42, v43) |
| 프로젝트 사이의 동의 (#371) | `project_consents` | `Store.listProjectConsents` / `getProjectConsent` | (행) | 이 빌드가 모르는 종류는 저장소에 남고 목록에는 안 나온다 (#384) | (행) | `store.test.ts` |
| 세션의 앱 동의 | `app_settings.session_apps:<id>` | `sessions/app-access.ts`의 `parse` | (목록) | 모르는 동의의 원소는 버린다 | 빈 목록 | |
| 앱 권한 | `app_permissions` | `desk.ts` | 옛 `uses`에 대해 기록된 결정은 다시 묻는다 | `allow`가 아닌 결정은 모두 거절 | (행) | `app-capabilities.test.ts` |
| 앱 매니페스트 | `centralu.app.json` | `parseManifest` | 선택 필드는 기본값 (`view.origin` opaque, `uses` 비어 있음) | 모르는 필드는 경고, 모르는 `uses.host` 능력은 경고하고 거절, 다른 `manifestVersion`은 두 버전을 대는 오류 | 파일 이름을 댄 오류가 앱 목록에 보인다 | `manifest.test.ts` |
| 앱 비밀 값 | `app-secrets.json` | `AppSecrets` | (맵) | 남는 키 무시 | 앱은 비밀 값 없이 시작, stderr에 말한다 | `app-secrets.test.ts` (깨진 파일은 아님) |
| 가져온 앱 표시 | `app-imports.json` | `ImportBook` | (맵) | 남는 키 유지 | `.unreadable-<시각>`으로 옮겨 두고 알린다. 가져온 앱은 다시 묻는다 | |
| 앱 버전 | `app-versions/<app>/<id>/meta.json` | `AppVersions.list` | | 남는 필드 유지 | `id`와 `at`이 없는 기록은 반쯤 지워진 것처럼 건너뛴다 (#384) | `versions.test.ts` |
| 테마 파일 | `<data>/themes/*.json` | `parseThemeFile` (protocol) | 빠진 토큰은 바탕 테마로 | 모르는 키나 토큰은 문제로 적고 무시 | 이유와 함께 깨진 것으로 목록에 | `theme.test.ts`, `themes.test.ts` |
| 오케스트레이터 제안과 스킬 | `app_settings.orchestrator_*` | `OrchestratorProposals` | | 원소는 남는 필드를 지킨다 | 목록이 아니면 빈 목록, 이름이나 내용이 없는 원소는 건너뛴다 (#384) | `orchestrator-proposals.test.ts` |
| 뷰 넘겨주기 | `app_settings.views.handover` | `restoreViewHandover` | | 뷰가 아닌 원소는 건너뛴다 (#384) | 아무것도 다시 열지 않고, 행은 그래도 지운다 | `view-handover.test.ts` |
| 뷰 출처 포트, 본 에이전트 버전, 프로젝트 JSON 열 | `app_settings.apps.viewPorts`, `agents.versionsSeen`, `projects.*` | `readBook`, `readSeen`, `Store` | 값마다 확인 | 무시 | 없음으로 읽힌다 | |
| 호스트 빌드 기록 | `CC_HOST_SOURCE` (키퍼에서 호스트로) | `hostBuild` (`keeper-link.ts`) | 빠진 키는 빠진 채로 | 무시 | 호스트 자신의 커밋만 | `keeper-link.test.ts` |
| 시작 상태 | `shell-status.json` | 창의 `start.rs`, 필드마다, nonce로 맞춘다 | | 무시 | 아직 상태 없음으로 다룬다 | `start.rs` 테스트 |
| 키퍼 기록 | `keeper.json` | 사람이 보라고 쓴다. 읽는 빌드는 없다 | | | | |
| 원격 연결 줄 | `centralu serve --connection` stdout | `parseConnectionLine` (`links/tunnel.ts`) | `version`과 `dataDir`는 기본값 | 다른 `v`는 어느 쪽을 업데이트할지 말하는 오류, 포트나 토큰이 없으면 오류 | JSON이 아닌 줄은 건너뛴다 | `tunnel.test.ts` |
| 호스트 ↔ UI 페이로드 | RPC 결과, 이벤트, `hello_ok` | `parseRpcResult`, `parseServerFrame`, `parseTolerant` (protocol, #339) | 기본값 적용 | 선언 안 된 필드는 버리고, 못 읽는 값은 그 값만 온 그대로 둔다 | | `tolerant.test.ts`, `rpc-client.test.ts`, `e2e/older-host.spec.ts` |

아직 덮지 못한 것: `keeper-settings.json`은 저장할 때 모르는 필드를 떨구고, 못 읽는 파일은 말 없이 꺼짐으로 읽힌다(키퍼의
Rust, 따로 바꾼다). 이전 릴리스의 호스트로 새 저장소를 여는 e2e도 아직이다. `older-host.spec.ts`는 페이로드 쪽 절반을 덮는다.

## 6. 사용량과 한도 (FR-9)

**도구에게 묻는다. 도구의 파일을 읽지 않는다.** `agents.usage` → `SessionManager.usageFor(tool)`
→ 어댑터의 선택 메서드 `listUsage()`이고, 그 안에서 도구 자신의 API를 부른다 (한쪽은 Claude
SDK, 다른 쪽은 `app-server`). 답하지 못하는 어댑터는 던지고, 매니저가 이유를 달아 degrade한다 —
자신 있게 틀린 숫자를 보여주는 것보다 낫다.

사용량은 세션도 디렉토리도 아닌 **계정**의 성질이라 `listUsage()`에는 인자가 없다 — 어느
폴더에서 묻든 답이 같다. 다루는 것은 구독 한도뿐이고, 추가 결제(크레딧)는 범위 밖이다.

**세션이 없을 때 (#726).** Claude SDK는 사용량 호출을 돌고 있는 세션의 query에만 달아 두어서, 세션이 하나도 없는 호스트
(대개 연결된 기기)는 "A running session is required to read usage"라고 답했고 계량기는 빈 채로 남았다. 이제 살아 있는
세션이 없으면 `listUsage()`가 읽기 위한 **프로브 세션**을 띄운다: 임시 폴더에서 도는 Claude 프로세스에 메시지를 보내지
않아 과금이 없고, 답할 때까지 읽고(측정으로 약 1.5초, 상한 20초, 바쁜 컴퓨터에서 3~8초; 매니저는 15초에 포기하지만 프로브는 계속되어 답이 다음 질문에 쓰인다; 호출이 없는 SDK는 곧바로 끝) 곧바로 멈춘다.
설정 파일도, 코드 인텔리전스도, `strictMcpConfig`로 사용자의 MCP 서버도 띄우지 않고, 모델 목록 요청에 빌려 주지도
않는다. 폴더는 프로세스가 떠난 뒤에 지우고(Windows는 그때까지 폴더를 쥔다), 남은 것(임시 폴더의 10분 넘은
`centralu-usage-probe-*`)은 첫 프로브 때 쓸어 낸다. 답도 실패도 5분간 유지되어서 계량기의 5분 폴링이 한 번에 프로세스
하나 이상을 띄우지 않고 고장 난 CLI를 폴링마다 다시 시도하지 않는다. 계량기는 창이 가려진 동안 폴링하지 않고
(건너뛴 뒤 다시 보이면 곧바로 묻는다) 그 기기에서 `agents.detect`가 쓸 수 있다고 한 도구만 묻는다. 로그인이 안 되어 있으면 프로브 없이 그렇게
말한다. Codex는 이미 짧게 사는 클라이언트로 읽으므로 이런 공백이 없다.

**허브와 연결된 기기가 같은 계정일 때 (#726).** 각 호스트는 `agents.account { tool }`에 자기가 보는 로그인의 지문으로
답한다(`claude auth status --json`에서 조직 id와 소문자로 바꾼 이메일의 해시; 조직 id만으로는 한 팀의 구성원들을 같다고
보게 되는데 각자의 한도가 따로 있다). 호스트 밖으로 나가는 것은 해시뿐이고 이메일은 나가지 않는다. 허브와 기기의 지문이 같으면
허브가 `agents.usage { machine }`에 자기 한도와 `sameAccountAsHub: true`로 답하고, 기기에는 프롬프트 캐시 수치만
묻는다(`limits: false`): 그 수치는 기기 자신의 요청을 센 것이기 때문이다. 다르거나 기기의 호스트가 `agents.account`를 모르면
평소처럼 기기에 묻고, 기기에 세션이 없으면 거기서 프로브한다. 화면은 "Same account as this computer"를, 읽을 수 없었으면
빈 계량기 대신 한 줄짜리 이유를 보여 준다.

이 절은 원래 전혀 다른 것을 적고 있었다: chokidar로 `~/.claude/projects/**`와
`~/.codex/sessions/**`를 감시하며 증분 파싱하고, `usage_facts` 행을 써서 `usage.weekly` RPC로
읽고, 집계는 `core/usage`에서 한다는 설계. **그중 어느 것도 존재하지 않는다** — chokidar는
의존성이 아니고, `core/usage`에는 §6.1의 캐시 계산만 있고, `usage.weekly` 메서드도 없으며,
`usage_facts`에 행을 쓴 빌드는 하나도 없다. 그래도 지금은 `schema.sql`에 남는다: v0.1.0-beta.10까지의
릴리스는 프로젝트를 지울 때 여기서 그 행을 지우고, 이 빌드가 그것을 건드리지 않는 첫 빌드라서, 지우는 것은 나중
릴리스의 수축 단계다(§5.1 규칙 2). 게다가 그것은 §8.1이
말하는 규칙의 **정반대**였고, 두 절이 이 문서 안에서 서로를 부정한 채 나란히 있었다. 도구의
비공개 JSONL을 읽는 것이 바로 §8.1이 금지하는 일이고, 이유도 거기 적혀 있다: 문서화되지 않은
포맷은 업그레이드에서 소리 없이 깨지며, 숫자가 조용히 깨지는 것은 숫자가 없는 것보다 나쁘다.

### 6.1 프롬프트 캐시

사용량 게이지는 에이전트의 입력 중 얼마가 프롬프트 캐시에서 왔는지도 말한다. 비용이 드는 것은
캐시 재구축이기 때문이다: 다시 만든 프롬프트는 쓰기 값으로 치르고, 게이지가 보이는 한도에도
들어간다. 도넛의 툴팁에 한 줄("Cache hit 94% · last 5 h")이 있고, 클릭해서 여는 드롭다운이
도구별로, 최근 5시간과 오늘(호스트 기준 자정부터)에 대해 풀어 보인다: 적중률, 캐시에서 읽은
토큰·캐시에 쓴 토큰·캐시 밖 입력, 재구축 수, 가장 많이 쓴 세션 몇 개(누르면 그 세션이 열린다).

**도구의 파일이 아니라 세션 자신의 이벤트에서 센다** (위의 규칙). 어댑터는 모델 요청마다
`usage_update`에 `request`(`RequestInput`)를 한 번 싣는다: Claude는 assistant 메시지마다,
CLI가 한 응답을 사용량을 되풀이하는 여러 메시지로 보낼 수 있어서 메시지 id로 중복을 걸러낸다.
Codex는 `thread/tokenUsage/updated`의 `last`에서, `total`이 그대로인 알림(되풀이)은 건너뛴다.
`tokens`는 예전 그대로의 누적 값이다. Claude 하위 에이전트의 요청도 세는데, 부모의 마지막 값을
되풀이하는 `usage_update`에 실어서 하위 에이전트의 토큰이 부모의 수치를 대신하지 않게 한다(#98).
`SessionManager`가 요청을 `CacheLedger`(`sessions/cache-ledger.ts`)에 넘기고, `agents.usage`가
물을 때 합한 `cache: CacheStats`를 함께 답한다. 연결된 기기의 호스트는 자기 것을 세고, 허브는
그 답 안의 세션 id에 기기를 붙인다.

| 결정 | 이유 |
|---|---|
| 적중률 = 창 안의 `cacheRead / (input + cacheRead + cacheCreation)` | 세 입력 필드는 겹치지 않으므로(`TokenUsage`) 합이 모델이 읽은 입력 전부다. 쓰기는 실패로 센다: 재구축만 한 창은 0%다. 보이는 곳(`@cc/core` `cacheHitRate`)에서 합으로부터 계산해서, 빌드가 다른 호스트와 UI가 뜻을 달리 읽을 수 없다 |
| **재구축**은 캐시 쓰기가 그 요청 입력 전체의 50% 이상이고 4,096 토큰 이상인 요청 | 보통의 작업은 지난 요청 이후 새로 생긴 것만 쓰고 나머지는 읽는다(몇 퍼센트). 캐시된 앞부분이 만료되거나 바뀐(다른 모델, 다른 도구) 요청은 거의 전부를 쓴다. Claude Code의 고정 앞부분만으로도 10,000 토큰을 훌쩍 넘으므로 하한은 작은 보조 호출만 걸러낸다. 턴이 아니라 요청 단위로 판단한다: 도구 호출 N번인 턴은 요청 N+1개이고, 합치면 한 번의 재구축이 뒤 요청들의 읽기에 묻힌다. 상태가 필요 없어서 끼어드는 하위 에이전트 요청에 헷갈리지 않는다. `pnpm measure:tools`는 더 정밀한 규칙(이전 요청이 보낸 입력 중 이번 요청이 읽지 못한 양, [tool-cost.md](tool-cost.md) §2)을 쓰는데, 그것은 대화마다 이전 요청이 필요하다. 이 규칙은 절반을 여전히 읽는 부분 재구축을 놓칠 수 있고, 대화 초반의 아주 큰 도구 결과를 셀 수 있다 |
| Codex: 읽기만 | Codex는 캐시에서 읽은 입력을 입력 수 안에 넣어 알리고, 캐시에 쓴 것은 말하지 않는다. 그래서 적중률은 전체 입력 중 캐시된 입력이고, 세션은 캐시 밖 입력으로 순위를 매기고, 화면이 그렇다고 말로 적는다. Codex의 재구축은 입력의 절반 미만을 캐시에서 읽은 요청이다(캐시 밖 4,096 토큰 이상): 읽지 못한 부분은 제값을 치렀고 제공자가 다음 요청을 위해 캐시하는 것이 그것이라, Claude의 쓰기가 뜻하는 비용과 같다. codex-cli 0.160의 내역에는 `cacheWriteInputTokens` 필드가 있지만, OpenAI 모델에서 0이 아닌 적이 있는지, `inputTokens`가 그것을 포함하는지는 재지 않았으므로 읽지 않는다 |
| 호스트 메모리에, 최대 하루치·도구마다 요청 50,000개 | 창은 시간 단위이고 수치는 누가 게이지를 볼 때만 읽힌다. 테이블은 그것을 위해 마이그레이션과 요청마다의 쓰기가 된다. 재시작은 화면이 인정하는 만큼만 잃는다(`countingSince`: 창 이름이 "since 14:02"가 되고 드롭다운이 그 전 요청은 모른다고 말한다). 타이머로 도는 것은 없다: 요청이 끝날 때 붙이고, 오래된 것은 다음에 붙일 때 버리고, 합은 `agents.usage`에서 낸다. 게이지는 이미 5분마다 그것을 물으므로 툴팁에 새 질문은 없다 |
| 게이지의 주간 창이 아니라 시간 단위 창 | 일주일은 재시작을 넘어 메모리에 담을 수 없고, 손쓸 일(캐시가 만료된 쉬던 세션, 모델 전환)은 몇 시간 안에 보인다 |

**재구축이 왜 일어났나.** 재구축마다 그럴듯한 원인을 붙인다. 근거는 그 세션에서 대화의 이전
요청과 이번 요청 사이에 호스트가 본 일이다. 매니저가 일이 생길 때 장부에 알리고(`CacheLedger.note`),
세션 자신의 대화의 다음 요청이 재구축이든 아니든 그 알림을 가져가므로, 알림이 해당 요청보다 오래
남지 않는다. 드롭다운은 Rebuilds 아래 한 줄("6 rebuilds: 3 cache expired (idle 64 min) · 1 model
change · 1 compaction · 1 unknown")과, 이름을 올린 세션마다 그 아래에 원인을 적는다. API가 알려 준
것이 아니라 근거로 짐작한 것이고, 화면의 Rebuilds 툴팁이 그렇다고 말한다.

| 원인 (강한 근거부터) | 근거 |
|---|---|
| `cold_start` 첫 요청 | 세션이 막 만들어졌다(`createSession`) |
| `subagent` 하위 에이전트 시작 | Claude 하위 에이전트의 첫 요청. 하위 에이전트는 자기 프롬프트와 캐시가 있어서 그 요청은 따로 줄을 이루고(`RequestInput.agent`, 그것을 띄운 호출), 세션의 알림을 가져가지 않는다 |
| `new_process` 새 프로세스 | 이유를 밝히지 않고 세션의 프로세스가 다시 떴다: 깨우기, 충돌 뒤 되살리기, 메뉴의 재시작, 밖에서 이어받은 대화. 이 호스트가 요청을 본 적 없고 알림도 없는 대화도 여기에 든다: 그 프로세스는 이 호스트보다 늦게 떴다(재시작, 호스트 교체) |
| `model_change` 모델 변경 | 모델이 바뀌었다: 사람의 설정(`updateSettings`), 또는 도구 스스로의 전환(거절 뒤 대체 모델, `recordToolSettings`). 어긋난 설정이 모델인 설정 재시작도 그렇게 적는다. #513의 기준선에서 잰 바로는 세션 안에서 Claude의 캐시를 다시 만든 유일한 일이다 |
| `compaction` 압축 | `compaction` 이벤트, 또는 `conversation_reset`(Claude Code의 /clear): 다음 요청은 캐시가 본 적 없는 요약이나 빈 대화로 시작한다 |
| `thread_restart` 스레드 재시작 | 붙이거나 뗀 앱을 받으려고 Codex의 스레드가 다시 시작했다(`sessionAppsChanged`, 바로 또는 턴이 끝날 때) |
| `instructions` 도구 변경 | Claude가 붙이거나 뗀 앱을 바로 받았다(도구 목록은 프롬프트의 일부다), 또는 스킬이나 MCP 변경으로 오케스트레이터가 다시 시작했다 |
| `launch_settings` 시작 설정 변경 | 키퍼가 보존한 프로세스의 어댑터 시작 지문이 바뀌었거나 이전 빌드가 지문을 기록하지 않아 다시 띄웠다(#589). 유휴 프로세스는 바로, 작업 중인 프로세스는 턴이 끝난 뒤 다시 띄운다. 프로젝트 신뢰를 바꾸면 그 프로젝트의 실행 중인 세션도 같은 경로로 다시 뜨고, 대화에 그 이유가 남는다(#663) |
| `expired` 캐시 만료 | 이 줄의 마지막 쓰기에 대해 API가 알린 수명보다 오래 쉬었다(Claude의 `cache_creation` 내역: `ephemeral_1h_input_tokens` 또는 `ephemeral_5m_input_tokens`) |
| `probably_expired` 아마 만료 | 알린 수명이 없을 때 5분 넘게 쉬었다(Codex는 알리지 않는다. 아직 쓴 적 없는 Claude 줄도) |
| `unknown` 모름 | 위의 어느 것도 아니다. 알린 수명보다 짧게 쉰 경우도 |

Claude Code가 캐시에 쓴 것을 얼마나 두라고 할지는 CLI 안에서 요청마다 정한다(CLI 2.1.289에서 읽음):
`FORCE_PROMPT_CACHING_5M`, 다음 `CLAUDE_CODE_PROMPT_CACHE_TTL`(또는 하위 에이전트용 짝), 다음
`promptCacheTtl` 설정, 에이전트 머리말, `ENABLE_PROMPT_CACHING_1H`. 그 밖에는 초과 사용 중이 아닌
claude.ai 구독자이고 요청의 출처가 원격으로 설정되는 허용 목록(기본값 `repl_main_thread*`, `sdk`,
`auto_mode`, `memdir_relevance`)에 있으면 1시간, 나머지는 모두 5분이다: API 키, 초과 사용, 하위
에이전트. 이 중 어느 것도 밖에서 보이지 않고 허용 목록은 릴리스 없이 바뀔 수 있으므로, 호스트는
짐작하지 않는다: 요청마다 API가 알린 쓰기 수명을 읽고, 아무것도 알리지 않았을 때만 5분으로 본다.
만료로 본 재구축 앞의 쉰 시간을 함께 보인다(`expiredIdleMs`, 그 창에서 가장 짧고 가장 긴 것).

`scripts/probe-cache-causes.mts`로 잰 결과(실제 호출, haiku, SDK 0.3.263을 거친 CLI 2.1.289, 구독자
로그인, 2026-10-12): SDK 세션의 쓰기에 API는 `1h`를, `FORCE_PROMPT_CACHING_5M`에서는 `5m`을 알렸다.
sonnet으로 바꾸자 0을 읽고 23,268 중 23,266을 썼고 `model_change`로 적혔다. 5분을 강제한 새 세션은
16,794를 모두 썼고 `cold_start`로 적혔다. 강제하지 않았을 때 첫 요청은 다른 세션이 캐시한 12,973
토큰을 읽어 재구축이 아니었다. 5분 수명에서 6분 쉰 뒤의 요청은 0을 읽고 16,959를 써서 `expired`로
적혔다(362초 쉼). 두 일은 재구축을 일으키지 않아 적을 것이 없었다: `/compact` 뒤의 요청은 13,074
토큰의 고정 앞부분을 읽고 2,308 토큰의 요약만 썼고, 재시작 뒤에는 15,382를 읽고 2,124를 썼다. 압축은
대화를 바꾸지 그 앞의 시스템 프롬프트와 도구를 바꾸지 않으므로, 요약이 그 앞부분보다 클 때만
압축으로 적힌다.

다루지 않는 것: Codex 하위 에이전트의 요청(그 알림은 부모의 단계 목록으로 가고 이 셈을 지나지
않는다), 재개된 스레드가 재개할 때 한 번 알릴 수 있는 Codex 요청, 호스트가 듣지 못하는 원인:
요청 사이에 CLI가 자기 시스템 프롬프트를 바꾸는 일. 캐시는 계정의 것이라 세션끼리 나눠 쓰므로,
한 세션이 다른 세션이 쓴 앞부분을 읽어 위의 일 뒤에 기대한 재구축이 나타나지 않을 수도 있다.

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
